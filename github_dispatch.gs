/**
 * Notion → GitHub Repository Dispatch 中継
 * Google Apps Script
 *
 * ※ 共通定数・ヘルパーは common.gs を参照
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【起動方法（無料プラン向け・推奨）】
 *   Notion オートメーションは有料プラン向けのため、
 *   代わりに「AIステータス = AIに依頼」を定期ポーリングする。
 *
 *   1. このファイルを既存 GAS プロジェクトに追加
 *   2. スクリプトプロパティに GITHUB_PAT を設定
 *      （WEBHOOK_SECRET は doPost 利用時のみ必須）
 *   3. setupAiDispatchPollTrigger() を一度だけ手動実行
 *   4. Notion で AIステータスを「AIに依頼」にする → 最大数分で Dispatch
 *
 * 【有料プラン向け: Web App / doPost】
 *   デプロイして Notion Automation から POST してもよい（任意）。
 *   受信 JSON: { "secret": "<WEBHOOK_SECRET>", "page_id": "<UUID>" }
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

const DISPATCH_EVENT_TYPE = 'notion-ai-task';
const DISPATCH_TASKS_DB_ID = '380db617-4b67-80a9-bdc4-cad9411d207c';
const DISPATCH_PROJECTS_DB_ID = '380db617-4b67-80ab-bc76-c2287da389ee';

/**
 * 無料プラン向け: 「AIに依頼」タスクを拾って Dispatch
 * 時間トリガーから呼ばれる（setupAiDispatchPollTrigger）
 */
function pollAiRequests() {
  const props = PropertiesService.getScriptProperties();
  const notionToken = props.getProperty('NOTION_TOKEN');
  const githubPat = props.getProperty('GITHUB_PAT');
  const slackToken = props.getProperty('SLACK_TOKEN');

  if (!notionToken || !githubPat) {
    throw new Error('NOTION_TOKEN / GITHUB_PAT をスクリプトプロパティに設定してください');
  }

  const pages = queryAiRequestPages_(notionToken);
  const results = [];

  pages.forEach(page => {
    const pageId = page.id;
    const title = getTitleFromPage_(page);
    try {
      const result = processAiDispatch_(notionToken, githubPat, pageId);
      if (!result.skipped && slackToken) {
        notifySlack_(
          slackToken,
          `🚀 AI依頼を開始\n` +
            `タスク: ${title}\n` +
            `リポ: ${result.repository}\n` +
            `Dispatch ID: ${result.dispatch_id}\n` +
            `Notion: https://www.notion.so/${String(pageId).replace(/-/g, '')}`
        );
      }
      results.push({ pageId, title, ok: true, ...result });
    } catch (err) {
      const message = err?.message || String(err);
      try {
        markAiFailure_(notionToken, pageId, message);
        notionCreateComment_(notionToken, pageId, `⚠️ AI依頼の起動に失敗しました\n${message}`);
      } catch (_) {
        /* ignore */
      }
      if (slackToken) {
        notifySlack_(slackToken, `⚠️ AI Dispatch 失敗\n${title}\n${message}`);
      }
      results.push({ pageId, title, ok: false, error: message });
    }
  });

  Logger.log(JSON.stringify({ polled: pages.length, results }, null, 2));
  return results;
}

/**
 * ポーリング用トリガーを設定（一度だけ手動実行）
 * 既定: 5分ごと
 * 併せてプロジェクトDBのリポ一覧をタスクの select 選択肢へ同期する
 */
function setupAiDispatchPollTrigger() {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (notionToken) {
    syncGithubRepoSelectOptions();
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pollAiRequests')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('pollAiRequests').timeBased().everyMinutes(5).create();

  Logger.log('✅ pollAiRequests を 5分ごとに設定しました（リポ選択肢も同期）');
}

/**
 * プロジェクト管理の GitHubリポジトリ を集約し、
 * オールタスク管理の「GitHubリポジトリ」(select) 選択肢を更新する。
 * プロジェクトにリポを追加・変更したらこの関数を再実行する。
 */
function syncGithubRepoSelectOptions() {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('NOTION_TOKEN 未設定');

  const repos = collectProjectRepos_(token);
  if (repos.length === 0) {
    Logger.log('プロジェクトに GitHubリポジトリ が無いため、選択肢更新をスキップ');
    return { updated: false, repos: [] };
  }

  const colors = ['blue', 'green', 'purple', 'yellow', 'orange', 'pink', 'red', 'gray', 'brown'];
  const options = repos.map((name, i) => ({
    name: name,
    color: colors[i % colors.length],
  }));

  // 注意: select options は「送った一覧が全量」になる（省略した選択肢は消える）
  const res = notionPatch_(token, `https://api.notion.com/v1/databases/${DISPATCH_TASKS_DB_ID}`, {
    properties: {
      GitHubリポジトリ: {
        select: { options: options },
      },
    },
  });

  if (res.object === 'error') {
    throw new Error('select options 更新失敗: ' + JSON.stringify(res));
  }

  Logger.log('✅ GitHubリポジトリ選択肢を同期: ' + repos.join(', '));
  return { updated: true, repos: repos };
}

/**
 * Notion Automation / 外部からの Webhook 入口
 * - Slack Interactivity（ボタン / モーダル）
 * - Slack Events
 * - Notion Automation（AI Dispatch）
 */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();

  // Slack Interactivity / Slash は application/x-www-form-urlencoded で payload=JSON
  const formPayload = parseSlackFormPayload_(e);
  if (formPayload) {
    try {
      Logger.log('Slack interaction type=' + formPayload.type);
      const result = handleEmailAlertSlackInteraction_(formPayload);
      // Slack は空 200、または response_action のみ受け付ける（独自 JSON は「接続できない」になる）
      return slackAckResponse_(result);
    } catch (err) {
      Logger.log('Slack interaction error: ' + (err?.message || err));
      return slackAckResponse_(null);
    }
  }

  let body = {};
  try {
    body = JSON.parse(e?.postData?.contents || '{}');
  } catch (_err) {
    return jsonResponse_(400, { ok: false, error: 'invalid_json' });
  }

  // Slack URL 検証 / イベント
  if (body.type === 'url_verification') {
    return ContentService.createTextOutput(body.challenge || '');
  }
  if (body.type === 'event_callback' || body.event) {
    try {
      const result = handleEmailAlertSlackEvent_(body, e);
      return jsonResponse_(200, result || { ok: true });
    } catch (err) {
      Logger.log('Slack event handler error: ' + (err?.message || err));
      return jsonResponse_(200, { ok: false, error: err?.message || String(err) });
    }
  }

  const notionToken = props.getProperty('NOTION_TOKEN');
  const githubPat = props.getProperty('GITHUB_PAT');
  const webhookSecret = props.getProperty('WEBHOOK_SECRET');
  const slackToken = props.getProperty('SLACK_TOKEN');

  if (!webhookSecret || body.secret !== webhookSecret) {
    return jsonResponse_(401, { ok: false, error: 'unauthorized' });
  }

  const pageId = normalizeNotionId_(body.page_id || body.pageId || '');
  if (!pageId) {
    return jsonResponse_(400, { ok: false, error: 'page_id_required' });
  }

  if (!notionToken || !githubPat) {
    return jsonResponse_(500, { ok: false, error: 'missing_script_properties' });
  }

  try {
    const result = processAiDispatch_(notionToken, githubPat, pageId);
    if (!result.skipped && slackToken) {
      notifySlack_(
        slackToken,
        `🚀 AI依頼を開始\n` +
          `タスク: ${result.title}\n` +
          `リポ: ${result.repository}\n` +
          `Dispatch ID: ${result.dispatch_id}\n` +
          `Notion: https://www.notion.so/${String(pageId).replace(/-/g, '')}`
      );
    }
    return jsonResponse_(200, { ok: true, ...result });
  } catch (err) {
    const message = err?.message || String(err);
    try {
      markAiFailure_(notionToken, pageId, message);
      notionCreateComment_(notionToken, pageId, `⚠️ AI依頼の起動に失敗しました\n${message}`);
    } catch (_) {
      /* ignore secondary failure */
    }

    if (slackToken) {
      notifySlack_(slackToken, `⚠️ AI Dispatch 失敗\npage: ${pageId}\n${message}`);
    }
    return jsonResponse_(500, { ok: false, error: message });
  }
}

/** Slack の form POST から payload JSON を取り出す */
function parseSlackFormPayload_(e) {
  if (e?.parameter?.payload) {
    try {
      return JSON.parse(e.parameter.payload);
    } catch (_) {
      return null;
    }
  }
  const contents = e?.postData?.contents || '';
  const type = e?.postData?.type || '';
  if (
    type.indexOf('application/x-www-form-urlencoded') === -1 &&
    contents.indexOf('payload=') === -1
  ) {
    return null;
  }
  const params = {};
  String(contents)
    .split('&')
    .forEach(function (pair) {
      const idx = pair.indexOf('=');
      if (idx < 0) return;
      const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
      const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
      params[k] = v;
    });
  if (!params.payload) return null;
  try {
    return JSON.parse(params.payload);
  } catch (_) {
    return null;
  }
}

/**
 * 動作確認用（エディタから手動実行）
 * スクリプトプロパティ TEST_PAGE_ID にタスクページ ID を入れて実行
 */
function testAiDispatch() {
  const props = PropertiesService.getScriptProperties();
  const pageId = props.getProperty('TEST_PAGE_ID');
  if (!pageId) {
    throw new Error('スクリプトプロパティ TEST_PAGE_ID を設定してください');
  }
  const result = processAiDispatch_(
    props.getProperty('NOTION_TOKEN'),
    props.getProperty('GITHUB_PAT'),
    normalizeNotionId_(pageId)
  );
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * ポーリングの手動一発実行（トリガー設定前の動作確認用）
 */
function testPollAiRequests() {
  pollAiRequests();
}

// ─────────────────────────────────────────────
// 中核処理
// ─────────────────────────────────────────────
function queryAiRequestPages_(token) {
  const url = `https://api.notion.com/v1/databases/${DISPATCH_TASKS_DB_ID}/query`;
  const pages = [];
  let cursor = undefined;

  do {
    const payload = {
      filter: {
        property: 'AIステータス',
        select: { equals: 'AIに依頼' },
      },
      page_size: 50,
    };
    if (cursor) payload.start_cursor = cursor;

    const res = notionPost_(token, url, payload);
    if (res.object === 'error') {
      throw new Error('Notion query failed: ' + JSON.stringify(res));
    }
    (res.results || []).forEach(p => pages.push(p));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return pages;
}

function processAiDispatch_(notionToken, githubPat, pageId) {
  const page = notionGet_(notionToken, `https://api.notion.com/v1/pages/${pageId}`);
  if (page.object !== 'page') {
    throw new Error('Notion page not found: ' + JSON.stringify(page));
  }

  const title = getTitleFromPage_(page);
  const aiStatus = page.properties?.['AIステータス']?.select?.name || '';
  const existingDispatchId = richTextPlain_(page.properties?.['Dispatch ID']);

  // 冪等: すでに設計以降に進んでいる／同一 Dispatch 済みならスキップ
  if (['AI設計中', 'AI実装中', 'PR作成済'].includes(aiStatus) && existingDispatchId) {
    return {
      skipped: true,
      reason: 'already_dispatched',
      title,
      dispatch_id: existingDispatchId,
      ai_status: aiStatus,
    };
  }

  const projectIds = (page.properties?.['プロジェクト']?.relation || []).map(r => r.id);
  // タスク単位のリポ指定を優先（同一プロジェクトでも PR 先が分かれるため）
  const repoFullName = resolveGithubRepoFromTask_(page, notionToken, projectIds);
  if (!repoFullName || !repoFullName.includes('/')) {
    throw new Error(
      'GitHubリポジトリ が未設定です。タスクに owner/repo を入れるか、プロジェクト側のフォールバックを設定してください'
    );
  }

  const bodyParsed = fetchAndParseTaskBody_(notionToken, pageId);
  const dispatchId = Utilities.getUuid();

  const clientPayload = {
    notion_page_id: pageId,
    title: title,
    background: bodyParsed.background,
    todo: bodyParsed.todo,
    done_criteria: bodyParsed.done_criteria,
    body_markdown: bodyParsed.raw,
    repository: repoFullName,
    dispatch_id: dispatchId,
  };

  const ghRes = githubRepositoryDispatch_(
    githubPat,
    repoFullName,
    DISPATCH_EVENT_TYPE,
    clientPayload
  );
  if (ghRes.code < 200 || ghRes.code >= 300) {
    throw new Error(`GitHub Dispatch failed (${ghRes.code}) for ${repoFullName}: ${ghRes.body}`);
  }

  notionPatch_(notionToken, `https://api.notion.com/v1/pages/${pageId}`, {
    properties: {
      AIステータス: { select: { name: 'AI設計中' } },
      'Dispatch ID': { rich_text: [{ type: 'text', text: { content: dispatchId } }] },
      AI最終エラー: { rich_text: [] },
      タグ: { status: { name: '進行中' } },
    },
  });

  notionCreateComment_(
    notionToken,
    pageId,
    `🚀 AI依頼を受け付けました\n` +
      `リポジトリ: ${repoFullName}\n` +
      `Dispatch ID: ${dispatchId}\n` +
      `ステータス: AI設計中\n` +
      `次の工程: 設計（.ai_todo.md）→ 実装 → Draft PR 作成`
  );

  return {
    skipped: false,
    title,
    repository: repoFullName,
    dispatch_id: dispatchId,
    event_type: DISPATCH_EVENT_TYPE,
  };
}

function markAiFailure_(notionToken, pageId, message) {
  const truncated = String(message).slice(0, 1900);
  notionPatch_(notionToken, `https://api.notion.com/v1/pages/${pageId}`, {
    properties: {
      AIステータス: { select: { name: 'AI失敗' } },
      AI最終エラー: { rich_text: [{ type: 'text', text: { content: truncated } }] },
    },
  });
}

// ─────────────────────────────────────────────
// Notion: リポ解決 / 本文パース
// ─────────────────────────────────────────────
/**
 * プロジェクト rich_text は「owner/repo」またはカンマ区切り複数を許容する。
 * 例: "waka-ken/jackson-office-api, waka-ken/core-RAG"
 * そのまま API パスに使うと 404 になるため、必ず parse してから使う。
 */
function parseGithubRepoList_(raw) {
  return String(raw || '')
    .split(/[,，;\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s));
}

/**
 * 優先: タスクの GitHubリポジトリ（select・単一）
 * フォールバック: 関連プロジェクトの GitHubリポジトリ（text・単一のみ）
 * プロジェクトに複数リポがある場合はタスク側の明示選択を必須にする
 * （複数を連結したまま Dispatch すると GitHub 404 になる）
 */
function resolveGithubRepoFromTask_(taskPage, token, projectIds) {
  const fromTask = selectPropPlain_(taskPage.properties?.['GitHubリポジトリ']).trim();
  if (fromTask) {
    const taskRepos = parseGithubRepoList_(fromTask);
    if (taskRepos.length === 1) return taskRepos[0];
    if (fromTask.includes('/')) {
      throw new Error(
        `タスクの GitHubリポジトリ が不正です: "${fromTask}"。owner/repo 形式で1つ選んでください`
      );
    }
  }

  if (projectIds && projectIds.length > 0) {
    const fromProject = resolveGithubRepoFromProject_(token, projectIds[0]);
    if (fromProject) return fromProject;
  }
  return '';
}

function resolveGithubRepoFromProject_(token, projectPageId) {
  const project = notionGet_(
    token,
    `https://api.notion.com/v1/pages/${normalizeNotionId_(projectPageId)}`
  );
  const raw = richTextPlain_(project.properties?.['GitHubリポジトリ']).trim();
  const repos = parseGithubRepoList_(raw);
  if (repos.length === 0) return '';
  if (repos.length === 1) return repos[0];
  throw new Error(
    `プロジェクトに複数の GitHubリポジトリがあります（${repos.join(', ')}）。` +
      'タスクの「GitHubリポジトリ」で PR 先を1つ選んでから「AIに依頼」にしてください'
  );
}

function collectProjectRepos_(token) {
  const url = `https://api.notion.com/v1/databases/${DISPATCH_PROJECTS_DB_ID}/query`;
  const set = {};
  let cursor = undefined;

  do {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const res = notionPost_(token, url, payload);
    if (res.object === 'error') {
      throw new Error('プロジェクト取得失敗: ' + JSON.stringify(res));
    }
    (res.results || []).forEach(page => {
      parseGithubRepoList_(richTextPlain_(page.properties?.['GitHubリポジトリ'])).forEach(repo => {
        set[repo] = true;
      });
    });
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return Object.keys(set).sort();
}

function selectPropPlain_(prop) {
  if (!prop) return '';
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'rich_text') return richTextPlain_(prop);
  return '';
}

function fetchAndParseTaskBody_(token, pageId) {
  const lines = [];
  let cursor = undefined;
  do {
    const url =
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100` +
      (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '');
    const res = notionGet_(token, url);
    (res.results || []).forEach(block => {
      const text = blockPlainText_(block);
      if (text) lines.push(text);
    });
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const raw = lines.join('\n').trim();
  return {
    raw: raw,
    background: extractSection_(raw, '背景'),
    todo: extractSection_(raw, 'やること'),
    done_criteria: extractSection_(raw, '完了条件'),
  };
}

function extractSection_(markdown, heading) {
  const re = new RegExp(
    '(?:^|\\n)##?\\s*' + heading + '[^\\n]*\\n([\\s\\S]*?)(?=\\n##?\\s|$)',
    'i'
  );
  const m = markdown.match(re);
  return m ? m[1].trim() : '';
}

function blockPlainText_(block) {
  const type = block.type;
  const data = block[type];
  if (!data) return '';

  if (type === 'heading_1' || type === 'heading_2' || type === 'heading_3') {
    const level = type === 'heading_1' ? '#' : type === 'heading_2' ? '##' : '###';
    return level + ' ' + richTextArrayPlain_(data.rich_text);
  }
  if (type === 'paragraph' || type === 'quote' || type === 'callout') {
    return richTextArrayPlain_(data.rich_text);
  }
  if (type === 'bulleted_list_item' || type === 'numbered_list_item' || type === 'to_do') {
    const prefix = type === 'numbered_list_item' ? '1. ' : '- ';
    return prefix + richTextArrayPlain_(data.rich_text);
  }
  if (type === 'code') {
    return '```\n' + richTextArrayPlain_(data.rich_text) + '\n```';
  }
  if (type === 'divider') return '---';
  return richTextArrayPlain_(data.rich_text || []);
}

function richTextArrayPlain_(arr) {
  return (arr || []).map(t => t.plain_text || '').join('');
}

function richTextPlain_(prop) {
  if (!prop || prop.type !== 'rich_text') return '';
  return (prop.rich_text || []).map(t => t.plain_text).join('');
}

function getTitleFromPage_(page) {
  const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
  return titleProp?.title?.map(t => t.plain_text).join('') || '(無題)';
}

// ─────────────────────────────────────────────
// GitHub
// ─────────────────────────────────────────────
function githubRepositoryDispatch_(pat, repoFullName, eventType, clientPayload) {
  const url = `https://api.github.com/repos/${repoFullName}/dispatches`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'notion-gas-ai-dispatch',
    },
    payload: JSON.stringify({
      event_type: eventType,
      client_payload: clientPayload,
    }),
    muteHttpExceptions: true,
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

// ─────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────
function normalizeNotionId_(id) {
  if (!id) return '';
  let s = String(id).trim();
  // URL から末尾 ID を抽出
  const m = s.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) s = m[1];
  s = s.replace(/-/g, '');
  if (s.length !== 32) return s;
  return s.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function jsonResponse_(_status, obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/**
 * Slack Interactivity 用レスポンス。
 * - null / 通常オブジェクト → 空ボディ（成功）
 * - { response_action: ... } → そのまま JSON
 */
function slackAckResponse_(result) {
  if (result && result.response_action) {
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
      ContentService.MimeType.JSON
    );
  }
  return ContentService.createTextOutput('');
}
