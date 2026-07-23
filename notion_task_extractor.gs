/**
 * 議事録タスク抽出
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
 *   ※ Slack への日次通知は行わない（結果は Logger に出力）
 *
 * 【初回セットアップ手順】
 *   1. script.google.com で common.gs / notion_task_extractor.gs /
 *      morning_tasks.gs を貼り付け
 *      ※ daily_ai_task_organizer.gs は本ファイルに統合済みのため不要
 *   2. スクリプトプロパティを common.gs の説明に従って設定
 *   3. setupDailyTrigger() を一度だけ手動実行
 *   4. testDailyRun() で動作確認
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
  const today        = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  try {
    // ① 議事録 → Notionタスク登録（Slack通知なし）
    const minutesResult = processMinutes_(notionToken, geminiApiKey, today);
    Logger.log(
      `議事録抽出完了（${today}）: ` +
      `処理 ${minutesResult.processedMinutes.length}件 / ` +
      `追加タスク ${minutesResult.addedTasks.length}件`
    );
    for (const m of minutesResult.processedMinutes) {
      Logger.log(`  • ${m.title} → ${m.taskCount}タスク`);
    }
  } catch (e) {
    Logger.log(`⚠️ 議事録抽出でエラー（${today}）: ${e.message}`);
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

  const notionRes = notionPost_(notionToken, `https://api.notion.com/v1/databases/${ALL_TASKS_DB_ID}/query`, { page_size: 1 });
  Logger.log('Notion: ' + (notionRes.object === 'list' ? `✅ OK（${notionRes.results?.length}件取得）` : '❌ NG: ' + JSON.stringify(notionRes)));

  Logger.log('議事録抽出を実行します（Slack通知なし）...');
  runDailyTaskReport();
  Logger.log('✅ 完了');
}
