/**
 * 必須対応メール監視 → Notion タスク化
 * Google Apps Script
 *
 * ※ 共通定数・ヘルパーは common.gs を参照
 * ※ 仕様: docs/mandatory-email-to-notion-proposal.md
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【処理フロー】（15分ごと）
 *
 *   ① 監視アドレス宛の未読を取得（Promotions/Social・処理済・カットオフ以前は除外）
 *   ② denylist に当たれば処理済にしてスキップ
 *   ③ Gemini で要対応判定 + Notionプロジェクト分類
 *   ④ 要対応・要確認のみ Notion オールタスクへ作成（プロジェクト relation 付き）+ Slack DM（受信日時付き）
 *   ⑤ Slack スレッド返信で「無視」(denylist) / コメント(Notion) を受付
 *   ⑥ Gmail に処理済ラベルを付与して既読化
 *
 *   プロジェクト一覧はハードコードせず、毎回 [DB]プロジェクト管理 から取得する。
 *   Slack スレッド操作は Web App doPost + Event Subscriptions が必要
 *   （手順: docs/mandatory-email-setup.md）

 * 【初回セットアップ】
 *   1. common.gs / email_alert_ingestor.gs を GAS に貼り付け
 *   2. スクリプトプロパティに EMAIL_MONITOR_ADDRESS を設定
 *      （加えて NOTION_TOKEN / GEMINI_API_KEY / SLACK_TOKEN）
 *   3. setupEmailAlertTrigger() を一度だけ実行
 *   4. testEmailAlertIngest() で動作確認
 *
 * 【クォータ余裕】
 *   - ポーリング: 15分間隔（1日96回）
 *   - 1回あたり最大 8通（Gemini 呼び出し上限）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─────────────────────────────────────────────
// 定数（監視アドレスのコード上デフォルト。運用はスクリプトプロパティ優先）
// ─────────────────────────────────────────────
/** @type {string} 監視対象メール。空のままなら EMAIL_MONITOR_ADDRESS プロパティ必須 */
var EMAIL_MONITOR_ADDRESS = '';

const EMAIL_TASKS_DB_ID = '380db617-4b67-80a9-bdc4-cad9411d207c'; // [DB] オールタスク管理
const EMAIL_PROJECTS_DB_ID = '380db617-4b67-80ab-bc76-c2287da389ee'; // [DB] プロジェクト管理
/** どのプロジェクトにも当てはまらない／自信が低いときのデフォルト */
const EMAIL_DEFAULT_PROJECT_NAME = 'Jackson office project';
/**
 * この日付（JST・当日含む）以降のメールだけ監視する。
 * スクリプトプロパティ EMAIL_LOOKBACK_AFTER（YYYY-MM-DD）があればそちら優先。
 */
const EMAIL_LOOKBACK_AFTER_DEFAULT = '2026-07-22';
const EMAIL_DONE_LABEL = 'email-ingestor/done';
const EMAIL_POLL_MINUTES = 15;
const EMAIL_MAX_PER_RUN = 8;
const EMAIL_BODY_MAX_CHARS = 6000;
const EMAIL_PROCESSED_KEY = 'EMAIL_PROCESSED_IDS_JSON';
const EMAIL_PROCESSED_MAX = 400;
const EMAIL_DENYLIST_KEY = 'EMAIL_DENYLIST_JSON';
const EMAIL_SLACK_THREAD_KEY = 'EMAIL_SLACK_THREAD_MAP_JSON';
const EMAIL_SLACK_THREAD_MAX = 120;
const EMAIL_SLACK_EVENT_KEY = 'EMAIL_SLACK_EVENT_IDS_JSON';
const EMAIL_SLACK_EVENT_MAX = 80;
const EMAIL_GEMINI_MODEL = 'gemini-2.5-flash';

// ─────────────────────────────────────────────
// メイン（時間トリガー）
// ─────────────────────────────────────────────
function pollEmailAlerts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('pollEmailAlerts: 他の実行中のためスキップ');
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('EMAIL_ALERTS_ENABLED') === 'false') {
      Logger.log('pollEmailAlerts: EMAIL_ALERTS_ENABLED=false のためスキップ');
      return;
    }

    const notionToken = props.getProperty('NOTION_TOKEN');
    const geminiApiKey = props.getProperty('GEMINI_API_KEY');
    const slackToken = props.getProperty('SLACK_TOKEN');
    const monitorAddr = resolveMonitorAddress_();

    if (!notionToken || !geminiApiKey || !slackToken) {
      throw new Error('NOTION_TOKEN / GEMINI_API_KEY / SLACK_TOKEN のいずれかが未設定です');
    }
    assertMonitorMailbox_(monitorAddr);

    const doneLabel = getOrCreateLabel_(EMAIL_DONE_LABEL);
    const threads = fetchCandidateThreads_(monitorAddr, doneLabel);
    if (threads.length === 0) {
      Logger.log('pollEmailAlerts: 新規候補なし');
      return;
    }

    // 毎回 Notion から現行プロジェクトを取得（ハードコードしない）
    const projects = fetchActiveProjects_(notionToken);
    const denylist = loadDenylist_();
    const processedIds = loadProcessedIds_();
    const summary = { created: 0, skipped: 0, ignored: 0, errors: 0 };

    for (const thread of threads) {
      const messages = thread.getMessages();
      const message = messages[messages.length - 1];
      try {
        const result = processOneMessage_({
          message,
          thread,
          doneLabel,
          denylist,
          processedIds,
          projects,
          notionToken,
          geminiApiKey,
          slackToken,
          monitorAddr,
        });
        summary[result] = (summary[result] || 0) + 1;
      } catch (e) {
        summary.errors++;
        Logger.log('メール処理エラー: ' + e.message);
        notifySlack_(
          slackToken,
          `⚠️ メール監視で1通の処理に失敗しました\n件名: ${safeSubject_(message)}\nエラー: ${e.message}`
        );
        markThreadDone_(thread, doneLabel);
      }
    }

    saveProcessedIds_(processedIds);
    Logger.log('pollEmailAlerts 完了: ' + JSON.stringify(summary));
  } catch (e) {
    const slackToken = PropertiesService.getScriptProperties().getProperty('SLACK_TOKEN');
    if (slackToken) {
      notifySlack_(slackToken, `⚠️ メール監視ジョブ自体が失敗しました\nエラー: ${e.message}`);
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────────────────────
// 1通処理
// ─────────────────────────────────────────────
function processOneMessage_({
  message,
  thread,
  doneLabel,
  denylist,
  processedIds,
  projects,
  notionToken,
  geminiApiKey,
  slackToken,
  monitorAddr,
}) {
  const messageId = String(message.getId());
  const from = String(message.getFrom() || '');
  const subject = safeSubject_(message);

  if (processedIds.indexOf(messageId) !== -1) {
    markThreadDone_(thread, doneLabel);
    return 'skipped';
  }

  if (isDenied_(from, denylist)) {
    processedIds.push(messageId);
    markThreadDone_(thread, doneLabel);
    return 'ignored';
  }

  const received = message.getDate();
  const lookbackAfter = resolveEmailLookbackAfter_();
  if (received.getTime() < lookbackAfter.getTime()) {
    // カットオフより前 → 確認済として処理済みラベルのみ付与
    processedIds.push(messageId);
    markThreadDone_(thread, doneLabel);
    return 'skipped';
  }

  const bodyText = extractPlainBody_(message).slice(0, EMAIL_BODY_MAX_CHARS);
  const receivedIso = Utilities.formatDate(received, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
  const receivedDisplay = Utilities.formatDate(received, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

  const judgment = classifyEmailWithGemini_(geminiApiKey, {
    monitorAddr,
    from,
    subject,
    receivedIso,
    bodyText,
    projects,
  });

  processedIds.push(messageId);

  const category = judgment.category || 'uncertain';
  if (category === 'fyi' || category === 'ignore') {
    markThreadDone_(thread, doneLabel);
    return 'ignored';
  }

  const projectAssign = resolveProjectFromJudgment_(projects, judgment);
  const page = createEmailTask_(notionToken, {
    judgment,
    from,
    subject,
    receivedIso,
    messageId,
    monitorAddr,
    projectAssign,
  });

  const pageUrl = page?.url || '(URL不明)';
  const urgency =
    judgment.urgency === 'urgent' ? '🚨緊急' : judgment.urgency === 'low' ? '低' : '通常';
  const projectLabel = formatProjectAssignLabel_(projectAssign);
  const textLines = [
    `📨 *必須対応メールを検知*（${urgency}）`,
    `受信: *${receivedDisplay}*（JST）`,
    `監視: ${monitorAddr}`,
    `プロジェクト: ${projectLabel}`,
    `サービス: ${judgment.service || 'Other'}`,
    `件名: ${subject}`,
    `From: ${from}`,
    `判定: ${category}`,
    `要約: ${judgment.summary || ''}`,
    `Notion: ${pageUrl}`,
  ].join('\n');

  const blocks = buildEmailAlertSlackBlocks_(textLines, pageUrl);
  const slackRes = postSlackDm_(slackToken, textLines, { blocks: blocks });

  if (slackRes.ok && slackRes.ts) {
    saveEmailSlackThreadContext_(slackRes.ts, {
      from: from,
      notionPageId: page?.id || null,
      subject: subject,
      messageId: messageId,
      pageUrl: pageUrl,
    });
  } else {
    Logger.log('Slack 投稿失敗: ' + (slackRes.error || 'unknown'));
  }

  markThreadDone_(thread, doneLabel);
  return 'created';
}

function buildEmailAlertSlackBlocks_(textLines, pageUrl) {
  const elements = [
    {
      type: 'button',
      action_id: 'email_deny',
      text: { type: 'plain_text', text: '送信元を無視', emoji: true },
      style: 'danger',
      value: 'deny',
    },
    {
      type: 'button',
      action_id: 'email_comment',
      text: { type: 'plain_text', text: 'コメント投稿', emoji: true },
      value: 'comment',
    },
  ];

  if (pageUrl && String(pageUrl).indexOf('http') === 0) {
    elements.push({
      type: 'button',
      action_id: 'email_open_notion',
      text: { type: 'plain_text', text: 'Notionを開く', emoji: true },
      url: String(pageUrl),
    });
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: String(textLines).slice(0, 2900) },
    },
    {
      type: 'actions',
      block_id: 'email_alert_actions',
      elements: elements,
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '「コメント投稿」= Slackモーダル / 「Notionを開く」= ブラウザで直接コメント',
        },
      ],
    },
  ];
}

// ─────────────────────────────────────────────
// Gmail 取得
// ─────────────────────────────────────────────
function fetchCandidateThreads_(monitorAddr, _doneLabel) {
  const lookback = resolveEmailLookbackAfter_();
  // Gmail after: は「その日の始まり以降」。年月はゼロ埋めなしでも可
  const afterToken = Utilities.formatDate(lookback, 'Asia/Tokyo', 'yyyy/M/d');

  const query = [
    'is:unread',
    '-category:promotions',
    '-category:social',
    `-label:${EMAIL_DONE_LABEL}`,
    'after:' + afterToken,
    `(to:${monitorAddr} OR deliveredto:${monitorAddr} OR cc:${monitorAddr})`,
  ].join(' ');

  Logger.log('Gmail search: ' + query);
  return GmailApp.search(query, 0, EMAIL_MAX_PER_RUN);
}

function getOrCreateLabel_(name) {
  const existing = GmailApp.getUserLabelByName(name);
  if (existing) return existing;
  return GmailApp.createLabel(name);
}

function markThreadDone_(thread, doneLabel) {
  thread.addLabel(doneLabel);
  thread.markRead();
}

function extractPlainBody_(message) {
  try {
    const plain = message.getPlainBody();
    if (plain && plain.trim()) return plain;
  } catch (_) {}
  try {
    return String(message.getBody() || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (_) {
    return '';
  }
}

function safeSubject_(message) {
  try {
    return String(message.getSubject() || '(件名なし)');
  } catch (_) {
    return '(件名なし)';
  }
}

// ─────────────────────────────────────────────
// 監視アドレス
// ─────────────────────────────────────────────
/**
 * スクリプトプロパティ EMAIL_MONITOR_ADDRESS を優先。
 * 無ければコード先頭の EMAIL_MONITOR_ADDRESS 定数を使う。
 */
function resolveMonitorAddress_() {
  const fromProps = (
    PropertiesService.getScriptProperties().getProperty('EMAIL_MONITOR_ADDRESS') || ''
  ).trim();
  const fromConst = String(EMAIL_MONITOR_ADDRESS || '').trim();
  const addr = fromProps || fromConst;
  if (!addr) {
    throw new Error(
      '監視メールアドレスが未設定です。スクリプトプロパティ EMAIL_MONITOR_ADDRESS を設定するか、' +
        'email_alert_ingestor.gs の EMAIL_MONITOR_ADDRESS に代入してください。'
    );
  }
  return addr.toLowerCase();
}

/**
 * 監視開始日（この日時以降のみ対象）。JST 0:00 起点。
 * @returns {Date}
 */
function resolveEmailLookbackAfter_() {
  const raw = (
    PropertiesService.getScriptProperties().getProperty('EMAIL_LOOKBACK_AFTER') ||
    EMAIL_LOOKBACK_AFTER_DEFAULT ||
    ''
  ).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(
      'EMAIL_LOOKBACK_AFTER は YYYY-MM-DD 形式で指定してください（現在: ' + raw + '）'
    );
  }
  // Asia/Tokyo の 0:00 を作る
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

function assertMonitorMailbox_(monitorAddr) {
  const effective = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const aliases = GmailApp.getAliases().map(function (a) {
    return String(a).toLowerCase();
  });
  const allowed = [effective].concat(aliases);

  if (allowed.indexOf(monitorAddr) === -1) {
    throw new Error(
      'EMAIL_MONITOR_ADDRESS (' +
        monitorAddr +
        ') は、この GAS 実行アカウントの' +
        'メール / エイリアスではありません。実行ユーザー: ' +
        effective +
        ' / エイリアス: ' +
        (aliases.join(', ') || '(なし)')
    );
  }
}

// ─────────────────────────────────────────────
// denylist / 処理済み ID
// ─────────────────────────────────────────────
function loadDenylist_() {
  const raw = PropertiesService.getScriptProperties().getProperty(EMAIL_DENYLIST_KEY) || '[]';
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.map(function (x) {
          return String(x).toLowerCase();
        })
      : [];
  } catch (_) {
    return [];
  }
}

function saveDenylist_(list) {
  PropertiesService.getScriptProperties().setProperty(EMAIL_DENYLIST_KEY, JSON.stringify(list));
}

/**
 * 手動学習用: 送信元アドレスまたはドメインを今後スキップする
 * 例: addEmailDenylist('newsletter.example.com')
 *     addEmailDenylist('promo@example.com')
 */
function addEmailDenylist(fromOrDomain) {
  const value = String(fromOrDomain || '')
    .trim()
    .toLowerCase();
  if (!value) throw new Error('fromOrDomain が空です');
  const list = loadDenylist_();
  if (list.indexOf(value) === -1) {
    list.push(value);
    saveDenylist_(list);
  }
  Logger.log('denylist 更新: ' + JSON.stringify(list));
  return list;
}

function isDenied_(fromHeader, denylist) {
  const from = String(fromHeader || '').toLowerCase();
  const emailMatch = from.match(/[\w.+-]+@[\w.-]+/);
  const email = emailMatch ? emailMatch[0] : '';
  const domain = email.includes('@') ? email.split('@')[1] : '';

  for (var i = 0; i < denylist.length; i++) {
    const rule = denylist[i];
    if (!rule) continue;
    if (from.indexOf(rule) !== -1) return true;
    if (email && email === rule) return true;
    if (domain && (domain === rule || domain.endsWith('.' + rule))) return true;
  }
  return false;
}

function loadProcessedIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty(EMAIL_PROCESSED_KEY) || '[]';
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (_) {
    return [];
  }
}

function saveProcessedIds_(ids) {
  const trimmed = ids.slice(-EMAIL_PROCESSED_MAX);
  PropertiesService.getScriptProperties().setProperty(EMAIL_PROCESSED_KEY, JSON.stringify(trimmed));
}

// ─────────────────────────────────────────────
// Notion プロジェクト一覧（差分は都度取得で吸収）
// ─────────────────────────────────────────────
/**
 * [DB]プロジェクト管理から未完了プロジェクトを取得する。
 * 名前変更・追加・削除は次回ポーリングで反映される（コードへの固定リストなし）。
 * @returns {{ id: string, name: string, repos: string }[]}
 */
function fetchActiveProjects_(token) {
  const url = `https://api.notion.com/v1/databases/${EMAIL_PROJECTS_DB_ID}/query`;
  const projects = [];
  let cursor = undefined;

  do {
    const payload = {
      page_size: 100,
      filter: {
        or: [
          { property: 'タグ', status: { equals: '未着手' } },
          { property: 'タグ', status: { equals: '進行中' } },
        ],
      },
    };
    if (cursor) payload.start_cursor = cursor;

    const res = notionPost_(token, url, payload);
    if (res.object === 'error') {
      throw new Error('プロジェクト一覧取得失敗: ' + (res.message || JSON.stringify(res)));
    }

    (res.results || []).forEach(function (page) {
      const titleProp = Object.values(page.properties || {}).find(function (p) {
        return p.type === 'title';
      });
      const name = (titleProp?.title || [])
        .map(function (t) {
          return t.plain_text || '';
        })
        .join('')
        .trim();
      if (!name) return;

      const repoProp = page.properties?.['GitHubリポジトリ'];
      let repos = '';
      if (repoProp?.type === 'rich_text') {
        repos = (repoProp.rich_text || [])
          .map(function (t) {
            return t.plain_text || '';
          })
          .join('')
          .trim();
      } else if (repoProp?.type === 'title') {
        repos = (repoProp.title || [])
          .map(function (t) {
            return t.plain_text || '';
          })
          .join('')
          .trim();
      }

      projects.push({ id: page.id, name: name, repos: repos });
    });

    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  Logger.log(
    '有効プロジェクト: ' +
      projects
        .map(function (p) {
          return p.name;
        })
        .join(', ')
  );
  return projects;
}

/**
 * Gemini が返したプロジェクト名を Notion relation 用に解決する。
 * 候補に当てはまらない／自信が低い／不明 → Jackson office project（デフォルト・未分類）
 * @returns {{ project: {id:string,name:string,repos:string}|null, mode: 'match'|'default'|'none' }}
 */
function resolveProjectFromJudgment_(projects, judgment) {
  const fallback = findDefaultProject_(projects);

  if (!projects || projects.length === 0) {
    return { project: null, mode: 'none' };
  }

  const picked = String(judgment.project_name || '').trim();
  const lowConfidence =
    !picked ||
    picked.toLowerCase() === 'null' ||
    picked === '未分類' ||
    (typeof judgment.project_confidence === 'number' && judgment.project_confidence < 0.55);

  if (!lowConfidence) {
    const lower = picked.toLowerCase();
    for (var i = 0; i < projects.length; i++) {
      if (projects[i].name.toLowerCase() === lower) {
        return { project: projects[i], mode: 'match' };
      }
    }
    for (var j = 0; j < projects.length; j++) {
      const n = projects[j].name.toLowerCase();
      if (n.indexOf(lower) !== -1 || lower.indexOf(n) !== -1) {
        return { project: projects[j], mode: 'match' };
      }
    }
  }

  // いずれでもない / 未マッチ → Jackson office の未分類枠
  if (fallback) {
    return { project: fallback, mode: 'default' };
  }
  return { project: null, mode: 'none' };
}

function findDefaultProject_(projects) {
  if (!projects || projects.length === 0) return null;
  const target = EMAIL_DEFAULT_PROJECT_NAME.toLowerCase();
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].name.toLowerCase() === target) return projects[i];
  }
  // 名前が多少違っても Jackson を拾う
  for (var j = 0; j < projects.length; j++) {
    const n = projects[j].name.toLowerCase().replace(/\s+/g, '');
    if (n.indexOf('jackson') !== -1) return projects[j];
  }
  return null;
}

function formatProjectAssignLabel_(projectAssign) {
  if (!projectAssign || !projectAssign.project) {
    return '未分類（デフォルトプロジェクト未検出）';
  }
  if (projectAssign.mode === 'default') {
    return projectAssign.project.name + '（デフォルト・未分類）';
  }
  return projectAssign.project.name;
}

// ─────────────────────────────────────────────
// Gemini 判定
// ─────────────────────────────────────────────
function classifyEmailWithGemini_(
  apiKey,
  { monitorAddr, from, subject, receivedIso, bodyText, projects }
) {
  const projectLines =
    (projects || []).length > 0
      ? projects
          .map(function (p, i) {
            const repoPart = p.repos ? ' | GitHub: ' + p.repos : '';
            return i + 1 + '. ' + p.name + repoPart;
          })
          .join('\n')
      : '(候補なし)';

  const prompt =
    'あなたは業務メールのトリアージ担当です。\n' +
    'このメールを放置すると、課金停止・サービス停止・セキュリティ侵害・契約/証明書の期限切れなどの実害があり得るかを判定してください。\n' +
    'サービス名の事前リストは使いません。本文から推定してください。\n' +
    'フィッシングの可能性がある場合は phishing_risk を上げ、リンクをクリックする手順は書かないでください。\n' +
    'action_steps は公式コンソールをブックマークから開く前提の手順にしてください。\n\n' +
    'また、次の Notion プロジェクト候補から最も関連が強いものを1つ選んでください。\n' +
    'メール文面・送信元・リポジトリ名・サービス名を根拠にしてください。\n' +
    '確信が持てない場合は project_name を null にしてください（無理に当てはめない）。\n\n' +
    '【プロジェクト候補】\n' +
    projectLines +
    '\n\n' +
    '監視メール: ' +
    monitorAddr +
    '\n' +
    'From: ' +
    from +
    '\n' +
    'Subject: ' +
    subject +
    '\n' +
    'Received: ' +
    receivedIso +
    '\n\n' +
    'Body:\n' +
    bodyText +
    '\n\n' +
    '次の JSON オブジェクトだけを返してください（説明文禁止）:\n' +
    '{\n' +
    '  "category": "action_required" | "review" | "fyi" | "ignore" | "uncertain",\n' +
    '  "service": "文字列（未知なら Other）",\n' +
    '  "project_name": "候補の正式名そのもの または null",\n' +
    '  "project_confidence": 0.0,\n' +
    '  "urgency": "urgent" | "normal" | "low",\n' +
    '  "due_date": "YYYY-MM-DD または null",\n' +
    '  "title": "50文字以内の日本語タスク名",\n' +
    '  "summary": "2〜3文の要約",\n' +
    '  "action_steps": ["手順1", "手順2"],\n' +
    '  "done_criteria": ["完了条件1"],\n' +
    '  "phishing_risk": "low" | "medium" | "high",\n' +
    '  "confidence": 0.0\n' +
    '}';

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    EMAIL_GEMINI_MODEL +
    ':generateContent?key=' +
    apiKey;

  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.2,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    muteHttpExceptions: true,
  });

  const raw = res.getContentText();
  const data = JSON.parse(raw);
  if (data.error) {
    throw new Error('Gemini APIエラー: ' + (data.error.message || JSON.stringify(data.error)));
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    Logger.log('Gemini 空レスポンス: ' + raw);
    return fallbackJudgment_(subject);
  }

  try {
    const parsed = JSON.parse(text);
    return normalizeJudgment_(parsed, subject);
  } catch (_) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return normalizeJudgment_(JSON.parse(m[0]), subject);
      } catch (e2) {
        Logger.log('Gemini JSON パース失敗: ' + e2.message);
      }
    }
    return fallbackJudgment_(subject);
  }
}

function normalizeJudgment_(j, subject) {
  const allowedCat = { action_required: 1, review: 1, fyi: 1, ignore: 1, uncertain: 1 };
  const allowedUrg = { urgent: 1, normal: 1, low: 1 };
  const category = allowedCat[j.category] ? j.category : 'uncertain';
  const urgency = allowedUrg[j.urgency] ? j.urgency : 'normal';
  const confidence = typeof j.confidence === 'number' ? j.confidence : 0.5;
  const projectConfidence = typeof j.project_confidence === 'number' ? j.project_confidence : 0;

  let finalCategory = category;
  if (confidence < 0.6 && (category === 'fyi' || category === 'ignore')) {
    finalCategory = 'uncertain';
  }
  if (j.phishing_risk === 'high') {
    finalCategory = 'uncertain';
  }

  let projectName = j.project_name;
  if (projectName == null || projectName === 'null') projectName = null;
  else projectName = String(projectName).trim() || null;

  return {
    category: finalCategory,
    service: String(j.service || 'Other').slice(0, 40),
    project_name: projectName,
    project_confidence: projectConfidence,
    urgency: urgency,
    due_date: j.due_date || null,
    title: String(j.title || subject || 'メール要確認').slice(0, 50),
    summary: String(j.summary || ''),
    action_steps: Array.isArray(j.action_steps) ? j.action_steps.map(String) : [],
    done_criteria: Array.isArray(j.done_criteria) ? j.done_criteria.map(String) : [],
    phishing_risk: j.phishing_risk || 'low',
    confidence: confidence,
  };
}

function fallbackJudgment_(subject) {
  return {
    category: 'uncertain',
    service: 'Other',
    project_name: null,
    project_confidence: 0,
    urgency: 'normal',
    due_date: null,
    title: String(subject || 'メール要確認').slice(0, 50),
    summary: 'AI判定に失敗したため要確認として起票しました。',
    action_steps: ['公式サイト/コンソールをブックマークから開き、同趣旨の通知がないか確認する'],
    done_criteria: ['対応不要と分かったら Notion を完了にする'],
    phishing_risk: 'medium',
    confidence: 0,
  };
}

// ─────────────────────────────────────────────
// Notion 起票
// ─────────────────────────────────────────────
function createEmailTask_(
  token,
  { judgment, from, subject, receivedIso, messageId, monitorAddr, projectAssign }
) {
  const title = judgment.title || subject || 'メール要確認';
  const properties = {
    プロジェクト名: { title: [{ text: { content: title.slice(0, 100) } }] },
    タグ: { status: { name: '未着手' } },
  };

  const project = projectAssign?.project;
  if (project?.id) {
    properties['プロジェクト'] = { relation: [{ id: project.id }] };
  }

  if (judgment.due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(judgment.due_date))) {
    properties['期間'] = { date: { start: String(judgment.due_date) } };
  }

  const steps =
    (judgment.action_steps || [])
      .map(function (s, i) {
        return i + 1 + '. ' + s;
      })
      .join('\n') || '1. 公式コンソールをブックマークから開いて確認する';

  const criteria =
    (judgment.done_criteria || [])
      .map(function (s) {
        return '- [ ] ' + s;
      })
      .join('\n') || '- [ ] 対応完了または対象外と判断した';

  const projectLine = '分類プロジェクト: ' + formatProjectAssignLabel_(projectAssign);

  const children = [
    emailHeading2_('背景'),
    emailParagraph_('サービス: ' + (judgment.service || 'Other')),
    emailParagraph_(projectLine),
    emailParagraph_('監視アドレス: ' + monitorAddr),
    emailParagraph_('From: ' + from),
    emailParagraph_('件名: ' + subject),
    emailParagraph_('受信: ' + receivedIso),
    emailParagraph_('Message-ID: ' + messageId),
    emailParagraph_('判定: ' + judgment.category + ' / 緊急度: ' + judgment.urgency),
    emailParagraph_('要約: ' + (judgment.summary || '')),
    { object: 'block', type: 'divider', divider: {} },
    emailHeading2_('やること'),
    emailParagraph_(steps),
    emailHeading2_('完了条件'),
    emailParagraph_(criteria),
    emailHeading2_('参考'),
    emailParagraph_(
      'メール内リンクはフィッシングの可能性があるため、ブックマークから公式コンソールへ入ること。'
    ),
  ];

  const res = notionPost_(token, 'https://api.notion.com/v1/pages', {
    parent: { database_id: EMAIL_TASKS_DB_ID },
    properties: properties,
    children: children,
  });

  if (res.object === 'error') {
    throw new Error('Notion ページ作成失敗: ' + (res.message || JSON.stringify(res)));
  }
  return res;
}

function emailHeading2_(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: String(text).slice(0, 2000) } }] },
  };
}

function emailParagraph_(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: String(text || '').slice(0, 1900) } }],
    },
  };
}

// ─────────────────────────────────────────────
// Slack 操作（ボタン主系統 / スレッド返信は互換用）
// ─────────────────────────────────────────────
/**
 * Slack Interactivity（ボタン・モーダル）
 * message.ts をキーに通知コンテキストを引く。
 */
function handleEmailAlertSlackInteraction_(payload) {
  const props = PropertiesService.getScriptProperties();
  const slackToken = props.getProperty('SLACK_TOKEN');
  const notionToken = props.getProperty('NOTION_TOKEN');

  if (payload.type === 'block_actions') {
    const action = (payload.actions && payload.actions[0]) || {};
    const messageTs = payload.message?.ts || payload.container?.message_ts || '';
    const ctx = loadEmailSlackThreadContext_(messageTs);
    if (!ctx) {
      postSlackDm_(
        slackToken,
        '⚠️ この通知のコンテキストが見つかりません。`testEmailAlertSlackButtons` を再実行してください。'
      );
      return null;
    }

    if (action.action_id === 'email_deny') {
      const target = extractEmailAddress_(ctx.from) || ctx.from;
      if (!target) {
        postSlackDm_(slackToken, '⚠️ 無視対象の送信元を特定できませんでした。', {
          thread_ts: messageTs,
        });
        return null;
      }
      addEmailDenylist(target);
      postSlackDm_(slackToken, `✅ 送信元を denylist に追加しました: \`${target}\``, {
        thread_ts: messageTs,
      });
      return null;
    }

    if (action.action_id === 'email_open_notion') {
      return null;
    }

    if (action.action_id === 'email_comment') {
      const triggerId = payload.trigger_id;
      if (!triggerId) {
        postSlackDm_(slackToken, '⚠️ trigger_id がありません。', { thread_ts: messageTs });
        return null;
      }
      if (!ctx.notionPageId) {
        postSlackDm_(
          slackToken,
          '⚠️ コメント先 Notion が未設定です。`TEST_PAGE_ID` を設定して再テストするか、本番通知から試してください。',
          { thread_ts: messageTs }
        );
        return null;
      }

      // trigger_id は約3秒で失効するため、先に views.open だけ行う
      const viewRes = openSlackModal_(slackToken, triggerId, {
        type: 'modal',
        callback_id: 'email_comment_modal',
        private_metadata: JSON.stringify({
          messageTs: messageTs,
          notionPageId: ctx.notionPageId,
        }),
        title: { type: 'plain_text', text: 'コメント追加' },
        submit: { type: 'plain_text', text: '投稿' },
        close: { type: 'plain_text', text: 'キャンセル' },
        blocks: [
          {
            type: 'input',
            block_id: 'comment_block',
            label: { type: 'plain_text', text: 'Notion タスクへのコメント' },
            element: {
              type: 'plain_text_input',
              action_id: 'comment_text',
              multiline: true,
              placeholder: { type: 'plain_text', text: '対応メモや次アクションなど' },
            },
          },
        ],
      });
      if (!viewRes.ok) {
        postSlackDm_(
          slackToken,
          '⚠️ モーダルを開けませんでした: `' + (viewRes.error || 'unknown') + '`',
          { thread_ts: messageTs }
        );
      }
      return null;
    }

    return null;
  }

  if (payload.type === 'view_submission' && payload.view?.callback_id === 'email_comment_modal') {
    // 重要: Slack は投稿から約3秒以内に「空200」か response_action が必要。
    // ここで Slack へ追加投稿するとタイムアウトしやすいので Notion のみ行う。
    try {
      let meta = {};
      try {
        meta = JSON.parse(payload.view.private_metadata || '{}');
      } catch (_) {}

      const notionPageId = normalizeNotionId_(meta.notionPageId || '');
      const comment = payload.view?.state?.values?.comment_block?.comment_text?.value || '';
      const text = String(comment).trim();

      if (!text) {
        return {
          response_action: 'errors',
          errors: { comment_block: 'コメントを入力してください' },
        };
      }

      if (!notionPageId || !notionToken) {
        return {
          response_action: 'errors',
          errors: {
            comment_block: 'Notion 連携不足です。TEST_PAGE_ID / NOTION_TOKEN を確認してください',
          },
        };
      }

      const commentRes = notionCreateComment_(notionToken, notionPageId, '💬 Slackより:\n' + text);
      if (commentRes?.object === 'error') {
        Logger.log('Notion comment error: ' + JSON.stringify(commentRes));
        return {
          response_action: 'errors',
          errors: {
            comment_block:
              'Notion投稿失敗: ' +
              String(commentRes.message || commentRes.code || 'error').slice(0, 80),
          },
        };
      }
      // Comments API 権限不足時は本文追記にフォールバック済み
      return null;
    } catch (err) {
      Logger.log('view_submission error: ' + (err?.message || err));
      return {
        response_action: 'errors',
        errors: {
          comment_block: '処理エラー: ' + String(err?.message || err).slice(0, 80),
        },
      };
    }
  }

  return null;
}

/**
 * Slack Event Subscriptions（スレッド返信・互換用）
 */
function handleEmailAlertSlackEvent_(body, gasEvent) {
  verifySlackRequestIfConfigured_(gasEvent);

  const event = body.event || {};
  const eventId = body.event_id || event.client_msg_id || event.ts || '';

  if (event.type !== 'message') {
    return { ok: true, skipped: 'not_message' };
  }
  if (event.subtype && event.subtype !== 'file_share') {
    return { ok: true, skipped: 'subtype_' + event.subtype };
  }
  if (event.bot_id || event.bot_profile) {
    return { ok: true, skipped: 'bot' };
  }
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return { ok: true, skipped: 'not_thread_reply' };
  }

  if (eventId && wasSlackEventProcessed_(eventId)) {
    return { ok: true, skipped: 'duplicate_event' };
  }
  if (eventId) markSlackEventProcessed_(eventId);

  const threadTs = event.thread_ts;
  const ctx = loadEmailSlackThreadContext_(threadTs);
  if (!ctx) {
    return { ok: true, skipped: 'unknown_thread' };
  }

  const text = String(event.text || '').trim();
  if (!text) return { ok: true, skipped: 'empty' };

  const props = PropertiesService.getScriptProperties();
  const slackToken = props.getProperty('SLACK_TOKEN');
  const notionToken = props.getProperty('NOTION_TOKEN');

  const ignoreMatch = text.match(/^(?:無視|ignore|deny)\s*(.*)$/i);
  if (ignoreMatch) {
    const arg = String(ignoreMatch[1] || '').trim();
    const target = arg || extractEmailAddress_(ctx.from) || ctx.from;
    if (!target) {
      replyEmailSlackThread_(slackToken, threadTs, '⚠️ 無視対象の送信元を特定できませんでした。');
      return { ok: false, error: 'no_deny_target' };
    }
    addEmailDenylist(target);
    replyEmailSlackThread_(
      slackToken,
      threadTs,
      `✅ 送信元を denylist に追加しました: \`${target}\``
    );
    return { ok: true, action: 'denylist', target: target };
  }

  if (!ctx.notionPageId || !notionToken) {
    replyEmailSlackThread_(slackToken, threadTs, '⚠️ Notion コメントできませんでした。');
    return { ok: false, error: 'no_notion_page' };
  }

  const commentRes = notionCreateComment_(notionToken, ctx.notionPageId, '💬 Slackより:\n' + text);
  if (commentRes?.object === 'error') {
    replyEmailSlackThread_(slackToken, threadTs, '⚠️ Notion コメント追加に失敗しました。');
    return { ok: false, error: 'notion_comment_failed' };
  }

  replyEmailSlackThread_(slackToken, threadTs, '✅ Notion タスクにコメントを追加しました。');
  return { ok: true, action: 'comment', pageId: ctx.notionPageId };
}

function replyEmailSlackThread_(token, threadTs, text) {
  if (!token || !threadTs) return;
  postSlackDm_(token, text, { thread_ts: threadTs });
}

function extractEmailAddress_(fromHeader) {
  const m = String(fromHeader || '').match(/[\w.+-]+@[\w.-]+/);
  return m ? m[0].toLowerCase() : '';
}

function saveEmailSlackThreadContext_(threadTs, ctx) {
  const map = loadEmailSlackThreadMap_();
  map[String(threadTs)] = {
    from: ctx.from || '',
    notionPageId: ctx.notionPageId || null,
    subject: ctx.subject || '',
    messageId: ctx.messageId || '',
    pageUrl: ctx.pageUrl || '',
    savedAt: new Date().toISOString(),
  };
  const keys = Object.keys(map);
  if (keys.length > EMAIL_SLACK_THREAD_MAX) {
    keys.sort(function (a, b) {
      return String(map[a].savedAt || '').localeCompare(String(map[b].savedAt || ''));
    });
    keys.slice(0, keys.length - EMAIL_SLACK_THREAD_MAX).forEach(function (k) {
      delete map[k];
    });
  }
  PropertiesService.getScriptProperties().setProperty(EMAIL_SLACK_THREAD_KEY, JSON.stringify(map));
}

function loadEmailSlackThreadContext_(threadTs) {
  const map = loadEmailSlackThreadMap_();
  return map[String(threadTs)] || null;
}

function loadEmailSlackThreadMap_() {
  const raw = PropertiesService.getScriptProperties().getProperty(EMAIL_SLACK_THREAD_KEY) || '{}';
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function wasSlackEventProcessed_(eventId) {
  const ids = loadSlackEventIds_();
  return ids.indexOf(String(eventId)) !== -1;
}

function markSlackEventProcessed_(eventId) {
  const ids = loadSlackEventIds_();
  ids.push(String(eventId));
  const trimmed = ids.slice(-EMAIL_SLACK_EVENT_MAX);
  PropertiesService.getScriptProperties().setProperty(
    EMAIL_SLACK_EVENT_KEY,
    JSON.stringify(trimmed)
  );
}

function loadSlackEventIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty(EMAIL_SLACK_EVENT_KEY) || '[]';
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (_) {
    return [];
  }
}

/**
 * SLACK_SIGNING_SECRET があるときだけ署名検証する。
 */
function verifySlackRequestIfConfigured_(gasEvent) {
  const secret = PropertiesService.getScriptProperties().getProperty('SLACK_SIGNING_SECRET');
  if (!secret) return;

  // Apps Script ではヘッダ取得が限られるため、可能な範囲で検証
  // HtmlService/WebApp: e.parameter には来ない。一部環境では取得不可のため、
  // Signing Secret 設定時は「検証スキップ不可」ではなく警告ログに留める実装もあるが、
  // ここでは X-Slack-Signature が取れる場合のみ厳密検証する。
  const signature =
    gasEvent?.parameter?.['x-slack-signature'] ||
    (typeof gasEvent?.headers === 'object'
      ? gasEvent.headers['X-Slack-Signature'] || gasEvent.headers['x-slack-signature']
      : null);
  const timestamp =
    gasEvent?.parameter?.['x-slack-request-timestamp'] ||
    (typeof gasEvent?.headers === 'object'
      ? gasEvent.headers['X-Slack-Request-Timestamp'] ||
        gasEvent.headers['x-slack-request-timestamp']
      : null);

  if (!signature || !timestamp) {
    Logger.log('SLACK_SIGNING_SECRET 設定済みだが署名ヘッダを取得できないため検証スキップ');
    return;
  }

  const base = 'v0:' + timestamp + ':' + (gasEvent?.postData?.contents || '');
  const digest = Utilities.computeHmacSha256Signature(base, secret);
  const hex = digest
    .map(function (b) {
      const v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');
  const expected = 'v0=' + hex;
  if (expected !== signature) {
    throw new Error('invalid_slack_signature');
  }
}

// ─────────────────────────────────────────────
// トリガー設定・テスト
// ─────────────────────────────────────────────
function setupEmailAlertTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) {
      return t.getHandlerFunction() === 'pollEmailAlerts';
    })
    .forEach(function (t) {
      ScriptApp.deleteTrigger(t);
    });

  ScriptApp.newTrigger('pollEmailAlerts').timeBased().everyMinutes(EMAIL_POLL_MINUTES).create();

  Logger.log('pollEmailAlerts を ' + EMAIL_POLL_MINUTES + ' 分ごとに設定しました');
}

function removeEmailAlertTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) {
      return t.getHandlerFunction() === 'pollEmailAlerts';
    })
    .forEach(function (t) {
      ScriptApp.deleteTrigger(t);
    });
  Logger.log('pollEmailAlerts トリガーを削除しました');
}

/** 手動テスト（本番と同じ処理を1回実行） */
function testEmailAlertIngest() {
  pollEmailAlerts();
}

/**
 * Slack ボタン動作の単体テスト（メール不要）
 * オールタスク管理に仮タスクを1件作成し、その個別ページへコメントできることを確認する。
 * （TEST_PAGE_ID にプロジェクト親を入れると、親のコメント欄に付いてしまう）
 *
 * スクリプトプロパティ: SLACK_TOKEN / NOTION_TOKEN 必須
 */
function testEmailAlertSlackButtons() {
  const props = PropertiesService.getScriptProperties();
  const slackToken = props.getProperty('SLACK_TOKEN');
  const notionToken = props.getProperty('NOTION_TOKEN');
  if (!slackToken) throw new Error('SLACK_TOKEN が未設定です');
  if (!notionToken) throw new Error('NOTION_TOKEN が未設定です');

  // 個別タスクを新規作成（プロジェクト親ページではない）
  const created = createEmailTask_(notionToken, {
    judgment: {
      title: '【テスト】Slackコメント確認用',
      service: 'Test',
      category: 'review',
      urgency: 'low',
      summary: 'Slackボタンからのコメント先確認用。不要なら削除してよい。',
      action_steps: ['コメントがこのタスクに付くことを確認する'],
      done_criteria: ['確認後に削除または完了にする'],
      due_date: null,
    },
    from: 'Test Sender <test-ignore@example.com>',
    subject: 'Slack button test',
    receivedIso: Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    messageId: 'test-msg-' + Date.now(),
    monitorAddr: (function () {
      try {
        return resolveMonitorAddress_();
      } catch (_) {
        return 'test@example.com';
      }
    })(),
    projectAssign: {
      mode: 'default',
      project: findDefaultProject_(fetchActiveProjects_(notionToken)),
    },
  });

  if (!created?.id) {
    throw new Error('テスト用タスク作成失敗: ' + JSON.stringify(created));
  }

  const taskPageId = created.id;
  const pageUrl = created.url || 'https://www.notion.so/' + String(taskPageId).replace(/-/g, '');
  Logger.log('テスト用個別タスク: ' + pageUrl);

  const textLines = [
    '📨 *【テスト】必須対応メール通知（ボタン確認用）*',
    'プロジェクト: Jackson office project（デフォルト・未分類）',
    'サービス: Test',
    '件名: Slack button test',
    'From: Test Sender <test-ignore@example.com>',
    '判定: review',
    '要約: 「コメント投稿」すると *この個別タスク* にコメントが付きます。',
    'Notion: ' + pageUrl,
  ].join('\n');

  const slackRes = postSlackDm_(slackToken, textLines, {
    blocks: buildEmailAlertSlackBlocks_(textLines, pageUrl),
  });

  if (!slackRes.ok || !slackRes.ts) {
    throw new Error('Slack 投稿失敗: ' + (slackRes.error || JSON.stringify(slackRes.raw)));
  }

  saveEmailSlackThreadContext_(slackRes.ts, {
    from: 'Test Sender <test-ignore@example.com>',
    notionPageId: taskPageId,
    subject: 'Slack button test',
    messageId: 'test-' + slackRes.ts,
    pageUrl: pageUrl,
  });

  Logger.log(
    '✅ テスト通知を送信しました。Slack の Notion リンクが個別タスクであることを確認してからコメントしてください。'
  );
  Logger.log('taskPageId=' + taskPageId);
}
