/**
 * 日次タスクレポート（統合版）
 * Google Apps Script
 *
 * ※ 共通定数・ヘルパーは common.gs を参照
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【処理フロー】（毎日 21:00 JST に実行）
 *
 *   ① 未着手議事録からTODOチェックボックスを抽出
 *      → Geminiでタスク名を整形 → Notionにタスク登録
 *      → 議事録ページのタグを「完了」に更新
 *   ② Notionの残タスク（未着手・進行中）を収集
 *      （①で追加したタスクも含まれる）
 *   ③ 本日のSlackメッセージ（チャンネル＋DM）を収集
 *   ④ Gemini AIで②③を統合・優先度整理
 *   ⑤ 議事録抽出サマリー＋AI整理タスクをSlack通知
 *
 * 【初回セットアップ手順】
 *   1. script.google.com で common.gs / notion_task_extractor.gs /
 *      morning_tasks.gs を貼り付け
 *      ※ daily_ai_task_organizer.gs は本ファイルに統合済みのため不要
 *   2. スクリプトプロパティを common.gs の説明に従って設定
 *   3. setupDailyTrigger() を一度だけ手動実行
 *   4. testDailyRun() で動作確認
 *
 * 【必要なSlackスコープ】
 *   chat:write, im:write  : 既存
 *   channels:history      : チャンネル投稿履歴の読み取り（追加）
 *   im:history            : DM投稿履歴の読み取り（追加）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────
const MINUTES_DB_ID   = '380db617-4b67-802f-9f63-fe51ecbe05d0'; // [DB] 議事録・ドキュメント管理
const ALL_TASKS_DB_ID = '380db617-4b67-80a9-bdc4-cad9411d207c'; // [DB] オールタスク管理


// ─────────────────────────────────────────────
// メインエントリーポイント（毎日 21:00 JST に実行）
// ─────────────────────────────────────────────
function runDailyTaskReport() {
  const props        = PropertiesService.getScriptProperties();
  const notionToken  = props.getProperty('NOTION_TOKEN');
  const geminiApiKey = props.getProperty('GEMINI_API_KEY');
  const slackToken   = props.getProperty('SLACK_TOKEN');
  const today        = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const todayDisplay = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');

  try {
    // ① 議事録 → Notionタスク登録
    const minutesResult = processMinutes_(notionToken, geminiApiKey, today);

    // ② Notion残タスク収集（①の登録分も含む）
    const notionTasks = fetchRemainingTasks_(notionToken);

    // ③ 本日のSlackメッセージ収集
    const slackMessages = fetchTodaySlackMessages_(slackToken);

    // ④ Gemini AIで整理（タスクもSlackメモも両方0件なら省略）
    let organizedText = null;
    if (notionTasks.length > 0 || slackMessages.length > 0) {
      organizedText = organizeWithGemini_(geminiApiKey, notionTasks, slackMessages, today);
    }

    // ⑤ Slack通知
    notifySlack_(slackToken, buildDailyMessage_(todayDisplay, minutesResult, organizedText));

  } catch (e) {
    notifySlack_(
      PropertiesService.getScriptProperties().getProperty('SLACK_TOKEN'),
      `⚠️ 日次タスクレポートでエラーが発生しました（${today}）\nエラー内容: ${e.message}`
    );
    throw e;
  }
}


// ─────────────────────────────────────────────
// ① 議事録処理：TODO抽出 → Notionタスク登録
// ─────────────────────────────────────────────
function processMinutes_(notionToken, geminiApiKey, today) {
  const minutePages = getUnprocessedMinutes_(notionToken);
  if (minutePages.length === 0) return { processedMinutes: [], addedTasks: [] };

  const processedMinutes = [];
  const addedTasks       = [];

  for (const page of minutePages) {
    const pageId          = page.id;
    const minutesTitle    = getPageTitle_(page);
    const projectRelation = getProjectRelation_(page);
    const minutesDate     = getPageDate_(page);

    const checkboxItems = extractCheckboxItems_(notionToken, pageId);
    if (checkboxItems.length === 0) continue;

    const tasksForThisPage = [];
    for (const item of checkboxItems) {
      const simpleName = simplifyTaskName_(geminiApiKey, item.text);
      tasksForThisPage.push({ simpleName, originalText: item.text, dueDate: item.dueDate || null });
    }

    for (const task of tasksForThisPage) {
      createTask_(notionToken, {
        simpleName:      task.simpleName,
        originalText:    task.originalText,
        projectRelation: projectRelation,
        dueDate:         task.dueDate,
        minutesTitle:    minutesTitle,
        minutesDate:     minutesDate,
      });
      addedTasks.push({ name: task.simpleName });
    }

    updatePageStatus_(notionToken, pageId, '完了');
    processedMinutes.push({ title: minutesTitle, taskCount: tasksForThisPage.length });
  }

  return { processedMinutes, addedTasks };
}


// ─────────────────────────────────────────────
// ② NOTION: 未完了タスクを取得
// ─────────────────────────────────────────────
function fetchRemainingTasks_(token) {
  const res = notionPost_(token, `https://api.notion.com/v1/databases/${ALL_TASKS_DB_ID}/query`, {
    filter: {
      or: [
        { property: 'タグ', status: { equals: '未着手' } },
        { property: 'タグ', status: { equals: '進行中' } },
      ],
    },
    sorts: [{ property: '期間', direction: 'ascending' }],
    page_size: 50,
  });

  return (res.results || []).map(page => {
    const props     = page.properties;
    const titleProp = Object.values(props).find(p => p.type === 'title');
    return {
      title:    titleProp?.title?.map(t => t.plain_text).join('') || '(無題)',
      status:   props['タグ']?.status?.name || '',
      dueDate:  props['期間']?.date?.start || null,
      priority: props['優先度']?.select?.name || null,
    };
  });
}


// ─────────────────────────────────────────────
// ③ SLACK: 本日のメッセージを収集（チャンネル＋DM）
// ─────────────────────────────────────────────
function fetchTodaySlackMessages_(slackToken) {
  const todayStr    = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const midnightJst = new Date(todayStr + 'T00:00:00+09:00');
  const oldestTs    = Math.floor(midnightJst.getTime() / 1000).toString();

  const allMessages = [];

  const channelMsgs = getSlackHistory_(slackToken, SLACK_CHANNEL, oldestTs);
  allMessages.push(...channelMsgs);

  const dmChannelId = openDmChannel_(slackToken, SLACK_USER_DM);
  if (dmChannelId) {
    const dmMsgs = getSlackHistory_(slackToken, dmChannelId, oldestTs);
    allMessages.push(...dmMsgs);
  }

  return allMessages
    .filter(m => !m.bot_id && !m.subtype)
    .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
    .map(m => m.text || '')
    .filter(Boolean);
}

function getSlackHistory_(token, channelId, oldestTs) {
  const url  = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&oldest=${oldestTs}&limit=200`;
  const res  = UrlFetchApp.fetch(url, {
    headers:            { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  return data.ok ? (data.messages || []) : [];
}

function openDmChannel_(token, userId) {
  const res  = UrlFetchApp.fetch('https://slack.com/api/conversations.open', {
    method:             'POST',
    headers:            { Authorization: `Bearer ${token}` },
    contentType:        'application/json',
    payload:            JSON.stringify({ users: userId }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  return data.ok ? data.channel?.id : null;
}


// ─────────────────────────────────────────────
// ④ GEMINI: 残タスク＋Slackメモを統合・整理
// ─────────────────────────────────────────────
function organizeWithGemini_(apiKey, notionTasks, slackMessages, today) {
  const taskLines = notionTasks.length > 0
    ? notionTasks.map(t => {
        const statusMark  = t.status === '進行中' ? '[進行中]' : '[未着手]';
        const priorityStr = t.priority ? `【${t.priority}】` : '';
        const dueStr      = t.dueDate  ? `（期限: ${t.dueDate}）` : '';
        return `- ${statusMark} ${priorityStr}${t.title}${dueStr}`;
      }).join('\n')
    : '（なし）';

  const slackLines = slackMessages.length > 0
    ? slackMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : '（なし）';

  const prompt =
    `あなたはタスク管理アシスタントです。\n` +
    `本日（${today}）終了時点の情報をもとに、明日以降のアクションを整理してください。\n\n` +
    `## Notionの残タスク\n${taskLines}\n\n` +
    `## 本日のSlackメッセージ\n${slackLines}\n\n` +
    `---\n` +
    `以下の3区分で出力してください。該当なしの区分は省略すること。\n\n` +
    `*【要対応】期限切れ・今日期限*\n` +
    `・タスク名（期限）\n\n` +
    `*【今週中】*\n` +
    `・タスク名（期限または理由を一言）\n\n` +
    `*【Slackより拾ったタスク】*\n` +
    `・タスク名（元の発言を10字以内で要約）\n\n` +
    `注意：\n` +
    `- 期限なし・優先度不明のタスクは「今週中」に含める\n` +
    `- Notionにすでにある内容と重複するSlackメモは追加しない\n` +
    `- 1行1タスク、タスク名は20字以内\n` +
    `- 前置き・まとめ・説明文は不要`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  try {
    const res  = UrlFetchApp.fetch(url, {
      method:             'POST',
      contentType:        'application/json',
      payload:            JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          temperature:     0.3,
          thinkingConfig:  { thinkingBudget: 0 },
        },
      }),
      muteHttpExceptions: true,
    });
    const raw  = res.getContentText();
    const data = JSON.parse(raw);

    if (data.error) {
      Logger.log('Gemini APIエラー: ' + JSON.stringify(data.error));
      return `⚠️ Gemini APIエラー: ${data.error.message}`;
    }

    const candidate    = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text         = candidate?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      Logger.log('Gemini レスポンス全体: ' + raw);
      Logger.log('finishReason: ' + finishReason);
    }

    if (finishReason === 'SAFETY')     return '⚠️ Geminiがセーフティフィルターによりブロックしました。';
    if (finishReason === 'MAX_TOKENS') return '⚠️ Geminiの出力がトークン上限に達しました。';

    return text || '⚠️ Geminiのレスポンスが空でした（finishReason: ' + finishReason + '）';
  } catch (e) {
    Logger.log('Gemini 例外: ' + e.message);
    return `⚠️ Gemini API呼び出しエラー: ${e.message}`;
  }
}


// ─────────────────────────────────────────────
// ⑤ Slackメッセージ組み立て
// ─────────────────────────────────────────────
function buildDailyMessage_(todayDisplay, minutesResult, organizedText) {
  const lines = [`📋 *日次タスクレポート*（${todayDisplay}）\n`];

  // 議事録セクション
  if (minutesResult.processedMinutes.length > 0) {
    lines.push('*━━ 議事録からの新規タスク登録 ━━*');
    lines.push(`処理した議事録: ${minutesResult.processedMinutes.length}件`);
    for (const m of minutesResult.processedMinutes) {
      lines.push(`　• ${m.title} → ${m.taskCount}タスク追加`);
    }
    lines.push(`追加タスク合計: ${minutesResult.addedTasks.length}件`);
    lines.push('');
  } else {
    lines.push('*━━ 議事録からの新規タスク登録 ━━*');
    lines.push('　本日処理対象の「未着手」議事録はありませんでした');
    lines.push('');
  }

  // AI整理セクション
  lines.push('*━━ AIによる残タスク整理 ━━*');
  if (organizedText) {
    lines.push(organizedText);
  } else {
    lines.push('　本日の残タスクもSlackメモもありませんでした 🎉');
  }

  return lines.join('\n');
}


// ─────────────────────────────────────────────
// NOTION: 未着手議事録ページ一覧を取得
// ─────────────────────────────────────────────
function getUnprocessedMinutes_(token) {
  const res = notionPost_(token, `https://api.notion.com/v1/databases/${MINUTES_DB_ID}/query`, {
    filter: { property: 'タグ', status: { equals: '未着手' } },
  });
  return res.results || [];
}


// ─────────────────────────────────────────────
// NOTION: ページ内のチェックボックス項目を再帰的に抽出
// ─────────────────────────────────────────────
function extractCheckboxItems_(token, pageId) {
  const items = [];
  collectBlocks_(token, pageId, items);
  return items;
}

function collectBlocks_(token, blockId, items) {
  const url    = `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`;
  const blocks = (notionGet_(token, url).results) || [];

  for (const block of blocks) {
    const type = block.type;

    if (type === 'to_do' && block.to_do.checked === false) {
      const cleaned = removeFootnotes_(richTextToString_(block.to_do.rich_text));
      if (cleaned) items.push({ text: cleaned });
    }

    if (['paragraph', 'callout', 'bulleted_list_item', 'numbered_list_item'].includes(type)) {
      const text    = richTextToString_(block[type]?.rich_text || []);
      const matches = [...text.matchAll(/(?:^|\n)\s*[-•*]?\s*\[ \]\s+(.+)/g)];
      for (const m of matches) {
        const cleaned = removeFootnotes_(m[1]);
        if (cleaned) items.push({ text: cleaned });
      }
    }

    if (block.has_children) collectBlocks_(token, block.id, items);
  }
}

function richTextToString_(richTextArr) {
  if (!richTextArr?.length) return '';
  return richTextArr.map(rt => rt.plain_text || rt.text?.content || '').join('');
}

function removeFootnotes_(text) {
  return text.replace(/\[\^[^\]]*\]/g, '').trim();
}


// ─────────────────────────────────────────────
// GEMINI: タスク名をシンプル化（15字以内）
// ─────────────────────────────────────────────
function simplifyTaskName_(apiKey, originalText) {
  const prompt =
    `以下の議事録のTODO項目を、15字以内の簡潔な日本語タスク名に変換してください。\n` +
    `動詞始まりで「何をするか」が一目でわかる形にしてください。\n` +
    `変換後のタスク名のみを返してください（説明・句読点・かぎかっこ不要）。\n\n` +
    `TODO項目:\n${originalText}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  try {
    const res  = UrlFetchApp.fetch(url, {
      method:             'POST',
      contentType:        'application/json',
      payload:            JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 60,
          temperature:     0.2,
          thinkingConfig:  { thinkingBudget: 0 },
        },
      }),
      muteHttpExceptions: true,
    });
    const data      = JSON.parse(res.getContentText());
    const simplified = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return simplified || originalText.slice(0, 15);
  } catch (_) {
    return originalText.slice(0, 15);
  }
}


// ─────────────────────────────────────────────
// NOTION: タスクをオールタスク管理DBに作成
// ─────────────────────────────────────────────
function createTask_(token, { simpleName, originalText, projectRelation, dueDate, minutesTitle, minutesDate }) {
  const properties = {
    'プロジェクト名': { title: [{ text: { content: simpleName } }] },
    'タグ':           { status: { name: '未着手' } },
  };
  if (projectRelation?.length > 0) properties['プロジェクト'] = { relation: projectRelation };
  if (dueDate)                      properties['期間']         = { date: { start: dueDate } };

  const children = [
    heading2Block_('元のチェックボックステキスト'),
    paragraphBlock_(originalText),
    { object: 'block', type: 'divider', divider: {} },
    heading2Block_('背景・エビデンス'),
    paragraphBlock_(`出典: ${minutesTitle}（${minutesDate || '日付不明'}）`),
  ];

  notionPost_(token, 'https://api.notion.com/v1/pages', {
    parent:     { database_id: ALL_TASKS_DB_ID },
    properties,
    children,
  });
}

function heading2Block_(text) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: text } }] } };
}
function paragraphBlock_(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } };
}


// ─────────────────────────────────────────────
// NOTION: ページのタグを更新
// ─────────────────────────────────────────────
function updatePageStatus_(token, pageId, statusName) {
  notionPatch_(token, `https://api.notion.com/v1/pages/${pageId}`, {
    properties: { 'タグ': { status: { name: statusName } } },
  });
}


// ─────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────
function getPageTitle_(page) {
  const titleProp = Object.values(page.properties).find(p => p.type === 'title');
  return titleProp?.title.map(t => t.plain_text).join('') || '(タイトルなし)';
}
function getProjectRelation_(page) {
  const prop = page.properties['プロジェクト'];
  return (prop?.type === 'relation') ? (prop.relation || []) : [];
}
function getPageDate_(page) {
  const prop = page.properties['期間'];
  return (prop?.type === 'date') ? (prop.date?.start || null) : null;
}


// ─────────────────────────────────────────────
// タイムトリガー設定（一度だけ手動実行）
// ─────────────────────────────────────────────
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['runDailyTaskReport', 'runExtractor', 'runDailyAiOrganizer'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('runDailyTaskReport')
    .timeBased()
    .atHour(21)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();

  Logger.log('✅ 日次タスクレポートトリガーを設定しました（毎日 21:00 JST）');
}


// ─────────────────────────────────────────────
// 接続テスト・動作確認
// ─────────────────────────────────────────────
function testDailyRun() {
  const props       = PropertiesService.getScriptProperties();
  const notionToken = props.getProperty('NOTION_TOKEN');
  const slackToken  = props.getProperty('SLACK_TOKEN');

  const notionRes = notionPost_(notionToken, `https://api.notion.com/v1/databases/${ALL_TASKS_DB_ID}/query`, { page_size: 1 });
  Logger.log('Notion: ' + (notionRes.object === 'list' ? `✅ OK（${notionRes.results?.length}件取得）` : '❌ NG: ' + JSON.stringify(notionRes)));

  const slackAuth = JSON.parse(UrlFetchApp.fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${slackToken}` },
    muteHttpExceptions: true,
  }).getContentText());
  Logger.log('Slack: ' + (slackAuth.ok ? `✅ OK (${slackAuth.user})` : '❌ NG: ' + slackAuth.error));

  const dmId = openDmChannel_(slackToken, SLACK_USER_DM);
  Logger.log(`DM Channel: ${dmId ? '✅ ' + dmId : '❌ 取得失敗（im:write スコープを確認）'}`);

  const msgs = fetchTodaySlackMessages_(slackToken);
  Logger.log(`本日のSlackメッセージ: ${msgs.length}件`);

  Logger.log('Slackへ送信します...');
  runDailyTaskReport();
  Logger.log('✅ 完了');
}
