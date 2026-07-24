/**
 * 共通定数・ヘルパー関数
 * notion_task_extractor.gs / morning_tasks.gs / github_dispatch.gs / email_alert_ingestor.gs から共有
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
 *
 *   --- 必須対応メール監視（email_alert_ingestor.gs）---
 *   EMAIL_MONITOR_ADDRESS : 監視対象のメールアドレス（必須）
 *                           GAS 実行アカウントの Gmail / エイリアスであること
 *   EMAIL_ALERTS_ENABLED  : （任意）'false' で監視停止。未設定・'true' で有効
 *   EMAIL_DENYLIST_JSON   : （任意）無視する From / ドメインの JSON 配列（自動更新可）
 *   EMAIL_LOOKBACK_AFTER  : （任意）この日以降のメールのみ監視（YYYY-MM-DD）
 *                           未設定時はコード定数 EMAIL_LOOKBACK_AFTER_DEFAULT を使用
 *
 *   SLACK_SIGNING_SECRET  : （任意）Slack Event 署名検証用。未設定なら検証スキップ
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─────────────────────────────────────────────
// 共通定数
// ─────────────────────────────────────────────
const NOTION_VERSION = '2022-06-28';
const SLACK_CHANNEL = 'C0APWTARQJV'; // #all-jackson-office-ワークスペース
const SLACK_USER_DM = 'U0AP2H08DE3'; // wakaken.business へのDM

// ─────────────────────────────────────────────
// Slack通知（DM のみに送信）
// ─────────────────────────────────────────────
function notifySlack_(token, message) {
  postSlackDm_(token, message);
}

/**
 * Slack DM 投稿。成功時は { ok, ts, channel, raw } を返す
 * opt: { thread_ts, reply_broadcast, blocks }
 */
function postSlackDm_(token, message, opt) {
  const payload = {
    channel: SLACK_USER_DM,
    text: message,
  };
  if (opt?.thread_ts) payload.thread_ts = opt.thread_ts;
  if (opt?.reply_broadcast) payload.reply_broadcast = true;
  if (opt?.blocks) payload.blocks = opt.blocks;

  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const raw = JSON.parse(res.getContentText() || '{}');
  return {
    ok: !!raw.ok,
    ts: raw.ts || null,
    channel: raw.channel || SLACK_USER_DM,
    error: raw.error || null,
    raw: raw,
  };
}

/**
 * Slack モーダルを開く（コメント入力用）
 */
function openSlackModal_(token, triggerId, view) {
  const res = UrlFetchApp.fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    contentType: 'application/json',
    payload: JSON.stringify({ trigger_id: triggerId, view: view }),
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText() || '{}');
}

// ─────────────────────────────────────────────
// Notion APIヘルパー
// ─────────────────────────────────────────────
function notionGet_(token, url) {
  const res = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

function notionPost_(token, url, payload) {
  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

function notionPatch_(token, url, payload) {
  const res = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

/**
 * ページへのコメント投稿（結果・進捗の見える化用）
 * 1) Comments API（要: インテグレーションの Insert comments）
 * 2) 失敗時はページ末尾にコールアウト追記（既存の Insert content 権限で可）
 */
function notionCreateComment_(token, pageId, text) {
  const content = String(text || '').slice(0, 1900);
  if (!content || !pageId) return null;

  const commentRes = notionPost_(token, 'https://api.notion.com/v1/comments', {
    parent: { page_id: pageId },
    rich_text: [{ type: 'text', text: { content: content } }],
  });

  if (commentRes && commentRes.object !== 'error') {
    return commentRes;
  }

  const msg = String(commentRes?.message || '');
  const canFallback =
    commentRes?.status === 403 ||
    /insufficient permissions/i.test(msg) ||
    /Insert comments/i.test(msg);

  if (!canFallback) {
    return commentRes;
  }

  // フォールバック: ページ本文末尾に追記
  const appendRes = notionPatch_(token, `https://api.notion.com/v1/blocks/${pageId}/children`, {
    children: [
      {
        object: 'block',
        type: 'callout',
        callout: {
          icon: { type: 'emoji', emoji: '💬' },
          rich_text: [{ type: 'text', text: { content: content } }],
        },
      },
    ],
  });

  if (appendRes && appendRes.object !== 'error') {
    appendRes._fallback = 'page_append';
    return appendRes;
  }
  return commentRes;
}
