/**
 * 共通定数・ヘルパー関数
 * notion_task_extractor.gs / morning_tasks.gs / github_dispatch.gs から共有
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【スクリプトプロパティ（全スクリプト共通）】
 *
 *   NOTION_TOKEN   : Notionインテグレーショントークン
 *                    取得: https://www.notion.so/my-integrations
 *
 *   GEMINI_API_KEY : Gemini APIキー（無料枠あり）
 *                    取得: https://aistudio.google.com/app/apikey
 *
 *   SLACK_TOKEN    : Slack Bot Token（xoxb-... で始まるもの）
 *                    取得: https://api.slack.com/apps
 *                    必要スコープ: chat:write, im:write
 *
 *   GITHUB_PAT     : GitHub PAT（repo + workflow 権限）
 *                    AIパイプライン Repository Dispatch 用（github_dispatch.gs）
 *
 *   WEBHOOK_SECRET : Notion Automation → GAS doPost の共有シークレット
 *
 *   TEST_PAGE_ID   : （任意）testAiDispatch() 用の Notion タスクページ ID
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─────────────────────────────────────────────
// 共通定数
// ─────────────────────────────────────────────
const NOTION_VERSION = '2022-06-28';
const SLACK_CHANNEL  = 'C0APWTARQJV';  // #all-jackson-office-ワークスペース
const SLACK_USER_DM  = 'U0AP2H08DE3';  // wakaken.business へのDM


// ─────────────────────────────────────────────
// Slack通知（DM のみに送信）
// ─────────────────────────────────────────────
function notifySlack_(token, message) {
  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method:             'POST',
    headers:            { Authorization: `Bearer ${token}` },
    contentType:        'application/json',
    payload:            JSON.stringify({ channel: SLACK_USER_DM, text: message }),
    muteHttpExceptions: true,
  });
}


// ─────────────────────────────────────────────
// Notion APIヘルパー
// ─────────────────────────────────────────────
function notionGet_(token, url) {
  const res = UrlFetchApp.fetch(url, {
    method:             'GET',
    headers:            { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

function notionPost_(token, url, payload) {
  const res = UrlFetchApp.fetch(url, {
    method:             'POST',
    headers:            { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

function notionPatch_(token, url, payload) {
  const res = UrlFetchApp.fetch(url, {
    method:             'PATCH',
    headers:            { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}
