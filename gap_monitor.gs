/**
 * ギャップ監視 — リポ内 docs/README/ADR のテキストだけで改善提案 → Notion
 * Google Apps Script
 *
 * ※ 共通ヘルパーは common.gs を参照
 * ※ 仕様: docs/gap-monitor-spec.md
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【大前提】
 *   ・判断材料は docs / README / ADR のテキストのみ
 *   ・ソースコード・Issue・PR・Actions は見ない
 *   ・GitHub への書き込みはしない（Notion 提案タスクのみ）
 *
 * 【処理】
 *   docs 取得 → Gemini が「改善 / 仕様 / 余剰」+ 適切な Notion プロジェクトを判断
 *   → fingerprint 冪等 → Notion 作成（最大10件/日）
 *   ※ リポ名≠単一プロジェクト。内容からプロジェクトを振分（メール取り込みと同系統）
 *
 * 【セットアップ】
 *   1. Notion に Fingerprint（済）。タグ「保留」「却下」推奨
 *   2. NOTION_TOKEN / GITHUB_PAT / GEMINI_API_KEY（SLACK_TOKEN 推奨）
 *   3. setupGapMonitorTrigger() → testGapMonitor()
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────
const GAP_TASKS_DB_ID = '380db617-4b67-80a9-bdc4-cad9411d207c';

/** @type {string[]} 初期は1本。マルチリポはここを増やす */
const GAP_TARGET_REPOS = ['waka-ken/core-RAG'];

const GAP_MAX_PER_DAY = 10;
const GAP_HOLD_DAYS = 30;
const GAP_GEMINI_MODEL = 'gemini-2.5-flash';
const GAP_MAX_DOC_FILES = 40;
const GAP_MAX_DOC_CHARS = 24000;
const GAP_USER_AGENT = 'notion-gas-gap-monitor';

const GAP_PREFIX = {
  improve: '[ギャップ/改善]',
  spec: '[ギャップ/仕様]',
  surplus: '[ギャップ/余剰]',
};

// ─────────────────────────────────────────────
// エントリ
// ─────────────────────────────────────────────
function pollGapMonitor() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('pollGapMonitor: 他の実行中のためスキップ');
    return;
  }

  try {
    runGapMonitor_({ notifySlack: true });
  } finally {
    lock.releaseLock();
  }
}

function testGapMonitor() {
  return runGapMonitor_({ notifySlack: true });
}

function setupGapMonitorTrigger() {
  removeGapMonitorTrigger();
  ScriptApp.newTrigger('pollGapMonitor').timeBased().atHour(9).everyDays(1).create();
  Logger.log('✅ pollGapMonitor を毎日 9:00 前後（スクリプトのタイムゾーン）に登録しました');
}

function removeGapMonitorTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollGapMonitor') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/**
 * 必須スクリプトプロパティの有無だけ確認（値は出さない）
 */
function checkGapMonitorProperties() {
  const props = PropertiesService.getScriptProperties();
  const required = ['NOTION_TOKEN', 'GITHUB_PAT', 'GEMINI_API_KEY'];
  const optional = ['SLACK_TOKEN'];
  const report = [];

  required.forEach(function (k) {
    report.push((props.getProperty(k) ? 'OK  ' : 'MISSING ') + k);
  });
  optional.forEach(function (k) {
    report.push((props.getProperty(k) ? 'OK  ' : 'empty ') + k + ' (optional)');
  });

  const text = report.join('\n');
  Logger.log(text);
  return text;
}

/**
 * スクリプトプロパティ UI が更新できないときの応急処置。
 * NEW_PAT に貼って実行 → 直後に '' に戻すこと。
 */
function resetGithubPatOnce() {
  const NEW_PAT = '';

  if (!NEW_PAT) {
    throw new Error('NEW_PAT が空です。関数内に ghp_... を貼ってから再実行してください');
  }
  if (String(NEW_PAT).indexOf('ghp_') !== 0 && String(NEW_PAT).indexOf('github_pat_') !== 0) {
    throw new Error('NEW_PAT は ghp_ または github_pat_ で始まる必要があります');
  }

  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('GITHUB_PAT');
  const afterDelete = props.getProperty('GITHUB_PAT');
  Logger.log('after delete: ' + (afterDelete ? 'STILL EXISTS' : 'GONE'));

  props.setProperty('GITHUB_PAT', String(NEW_PAT).trim());
  const v = props.getProperty('GITHUB_PAT') || '';
  Logger.log('after set prefix=' + v.slice(0, 4) + ' length=' + v.length);
  return { deleted: !afterDelete, prefix: v.slice(0, 4), length: v.length };
}

/**
 * docs 読み取り用 PAT の疎通（Issue/PR は不要）
 */
function testGithubPatForGap() {
  const pat = PropertiesService.getScriptProperties().getProperty('GITHUB_PAT');
  if (!pat) throw new Error('GITHUB_PAT が未設定です');

  const repo = GAP_TARGET_REPOS[0] || 'waka-ken/core-RAG';
  const checks = [
    { name: 'metadata (repo)', path: '/repos/' + repo },
    { name: 'contents (README)', path: '/repos/' + repo + '/contents/README.md' },
  ];

  const lines = ['repo=' + repo, 'pat_prefix=' + String(pat).slice(0, 11) + '…'];
  checks.forEach(function (c) {
    try {
      const res = UrlFetchApp.fetch('https://api.github.com' + c.path, {
        method: 'get',
        headers: {
          Authorization: 'Bearer ' + pat,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': GAP_USER_AGENT,
        },
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      let extra = '';
      if (code >= 400) {
        try {
          extra = ' ' + (JSON.parse(res.getContentText() || '{}').message || '');
        } catch (_) {
          /* ignore */
        }
      }
      lines.push(c.name + ': HTTP ' + code + extra);
    } catch (e) {
      lines.push(c.name + ': ERROR ' + (e.message || e));
    }
  });

  const text = lines.join('\n');
  Logger.log(text);
  return text;
}

/**
 * @param {{ notifySlack?: boolean }} opt
 */
function runGapMonitor_(opt) {
  const props = PropertiesService.getScriptProperties();
  const notionToken = props.getProperty('NOTION_TOKEN');
  const githubPat = props.getProperty('GITHUB_PAT');
  const geminiKey = props.getProperty('GEMINI_API_KEY');
  const slackToken = props.getProperty('SLACK_TOKEN');
  const notifySlack = !!(opt && opt.notifySlack);

  if (!notionToken || !githubPat || !geminiKey) {
    throw new Error('NOTION_TOKEN / GITHUB_PAT / GEMINI_API_KEY を設定してください');
  }

  const projects = fetchActiveProjects_(notionToken);
  const proposals = [];
  const errors = [];

  GAP_TARGET_REPOS.forEach(function (repo) {
    try {
      const docs = fetchGithubDocsForGap_(githubPat, repo);
      if (!docs.length) {
        Logger.log(repo + ': docs なし');
        return;
      }
      const items = reviewDocsWithGemini_(geminiKey, repo, docs, projects);
      items.forEach(function (it) {
        const assign = resolveGapProject_(projects, repo, it);
        it.projectId = assign.project ? assign.project.id : null;
        it.projectAssignLabel = formatGapProjectAssignLabel_(assign);
        Logger.log(
          'project assign: ' +
            it.title +
            ' → ' +
            it.projectAssignLabel +
            ' (gemini=' +
            (it.projectName || 'null') +
            ', conf=' +
            it.projectConfidence +
            ')'
        );
        proposals.push(it);
      });
    } catch (e) {
      const msg = repo + ': ' + (e.message || String(e));
      errors.push(msg);
      Logger.log('review 失敗: ' + msg);
    }
  });

  const open = [];
  proposals.forEach(function (p) {
    if (!shouldSkipGapFingerprint_(notionToken, p.fingerprint)) {
      open.push(p);
    }
  });

  const ordered = orderByPriority_(open).slice(0, GAP_MAX_PER_DAY);
  let created = 0;
  const createdTitles = [];
  const skipped = proposals.length - open.length;

  ordered.forEach(function (item) {
    try {
      const page = createGapTask_(notionToken, item);
      notionCreateComment_(
        notionToken,
        page.id,
        'ギャップ監視（docsテキストのみ / GAS）が作成しました\n' +
          'fingerprint: ' +
          item.fingerprint +
          '\n' +
          'kind: ' +
          item.kind +
          '\n' +
          'repo: ' +
          item.repo +
          '\n' +
          'プロジェクト: ' +
          (item.projectAssignLabel || '未分類') +
          (item.sourcePath ? '\n根拠docs: ' + item.sourcePath : '') +
          '\n操作: 採用するなら整えて AIステータス=AIに依頼 / 保留・却下はタグで'
      );
      created += 1;
      createdTitles.push(item.title);
    } catch (e) {
      const msg = 'create: ' + (e.message || String(e));
      errors.push(msg);
      Logger.log(msg);
    }
  });

  if (notifySlack && slackToken && (created > 0 || errors.length > 0)) {
    let msg =
      '🔍 ギャップ監視（docs）\n' +
      '提案候補: ' +
      proposals.length +
      ' / スキップ: ' +
      skipped +
      ' / 作成: ' +
      created;
    if (createdTitles.length) {
      msg +=
        '\n' +
        createdTitles
          .map(function (t) {
            return '・' + t;
          })
          .join('\n');
    }
    if (errors.length) {
      msg += '\n⚠️ ' + errors.slice(0, 5).join('\n');
    }
    notifySlack_(slackToken, msg);
  }

  Logger.log(
    'pollGapMonitor 完了 created=' +
      created +
      ' skipped=' +
      skipped +
      ' proposals=' +
      proposals.length
  );
  return {
    created: created,
    skipped: skipped,
    candidates: proposals.length,
    errors: errors,
  };
}

// ─────────────────────────────────────────────
// docs 取得（読み取り専用）
// ─────────────────────────────────────────────
function fetchGithubDocsForGap_(pat, repoFullName) {
  const repo = githubApiGetJson_(pat, '/repos/' + repoFullName);
  const branch = repo.default_branch || 'main';
  const treeRes = githubApiGetJson_(
    pat,
    '/repos/' + repoFullName + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
  );
  const paths = (treeRes.tree || [])
    .filter(function (n) {
      return n.type === 'blob' && isGapDocPath_(n.path);
    })
    .map(function (n) {
      return n.path;
    })
    .slice(0, GAP_MAX_DOC_FILES);

  const docs = [];
  let totalChars = 0;
  for (let i = 0; i < paths.length; i++) {
    if (totalChars >= GAP_MAX_DOC_CHARS) break;
    const path = paths[i];
    try {
      const file = githubApiGetJson_(
        pat,
        '/repos/' + repoFullName + '/contents/' + path.split('/').map(encodeURIComponent).join('/')
      );
      if (!file.content || file.encoding !== 'base64') continue;
      const text = Utilities.newBlob(
        Utilities.base64Decode(String(file.content).replace(/\n/g, ''))
      ).getDataAsString('UTF-8');
      const remain = GAP_MAX_DOC_CHARS - totalChars;
      const sliced = String(text || '').slice(0, Math.min(8000, remain));
      totalChars += sliced.length;
      docs.push({ path: path, content: sliced });
    } catch (e) {
      Logger.log('docs fetch skip ' + path + ': ' + (e.message || e));
    }
  }
  return docs;
}

function isGapDocPath_(path) {
  const p = String(path || '').replace(/\\/g, '/');
  if (!p) return false;
  if (/^readme\.md$/i.test(p)) return true;
  if (/^docs\//i.test(p) && /\.(md|mdx|txt)$/i.test(p)) return true;
  if (/docs\/adr\//i.test(p)) return true;
  if (/(^|\/)ADR[^/]*$/i.test(p) || /(^|\/)adr[^/]*\.(md|mdx)$/i.test(p)) return true;
  return false;
}

function githubApiGetJson_(pat, apiPath) {
  const res = UrlFetchApp.fetch('https://api.github.com' + apiPath, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + pat,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': GAP_USER_AGENT,
    },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText() || '{}';
  if (code < 200 || code >= 300) {
    throw new Error('GitHub API ' + code + ' ' + apiPath + ': ' + text.slice(0, 300));
  }
  return JSON.parse(text);
}

// ─────────────────────────────────────────────
// Gemini: docs レビュー → 改善 / 仕様 / 余剰
// ─────────────────────────────────────────────
function reviewDocsWithGemini_(apiKey, repoFullName, docs, projects) {
  const corpus = docs
    .map(function (d) {
      return '### FILE: ' + d.path + '\n' + d.content;
    })
    .join('\n\n')
    .slice(0, GAP_MAX_DOC_CHARS);

  const projectLines =
    (projects || []).length > 0
      ? projects
          .map(function (p, i) {
            const repos = String(p.repos || '');
            const sharesScanRepo =
              repos && repos.toLowerCase().indexOf(String(repoFullName).toLowerCase()) !== -1;
            let note = '';
            if (sharesScanRepo) {
              note =
                ' ※GitHubに ' +
                repoFullName +
                ' が紐づくが共有基盤の可能性大。本文・パスがこのプロジェクト専用と分かるときだけ選ぶ';
            } else if (repos) {
              note = ' | 参考GitHub: ' + repos;
            }
            return i + 1 + '. ' + p.name + note;
          })
          .join('\n')
      : '(候補なし)';

  const prompt =
    'あなたはプロダクトドキュメントのレビュー担当です。\n' +
    '与えられたテキストはリポジトリ「' +
    repoFullName +
    '」の README / docs / ADR のみです。\n' +
    'ソースコード・Issue・実装の有無は判断材料に使わず、この文書群だけから推論してください。\n\n' +
    '重要: リポジトリ名と Notion プロジェクトは1対1ではない。\n' +
    '「' +
    repoFullName +
    '」は複数クライアント向け基盤になり得る。\n' +
    '各提案の project_name は、文書のクライアント名／プロダクト名／ディレクトリ名から選ぶこと。\n' +
    'GitHubリポジトリ欄の一致だけで選んではいけない。\n' +
    '例: docs や記述が Takakyu / 高久向けなら Takakyu project。\n' +
    'Jackson Office 向けと明示されているときだけ Jackson office project。\n' +
    '確信が持てない場合は project_name を null（後段で別ルール）。\n\n' +
    '【Notion プロジェクト候補】\n' +
    projectLines +
    '\n\n' +
    '次の3種類の提案を出してください（合計最大 ' +
    GAP_MAX_PER_DAY +
    ' 件）:\n' +
    '- improve: 文書から見える、よりよい改善点（プロダクト価値に繋がるもの）\n' +
    '- spec: あるべきなのに書かれていない／曖昧な仕様\n' +
    '- surplus: 重複・陳腐化・過剰で削れそうな記述\n\n' +
    '【厳守】\n' +
    '- 実装手順の細かい書き直しや、単なる見出し整理だけの提案は出さない\n' +
    '- コード変更案・ファイルパスの実装指示は書かない\n' +
    '- リポジトリ操作は提案しない\n' +
    '- 人が「理想・現状・乖離」を読んで判断できる短文にする\n' +
    '- 出力は JSON のみ\n\n' +
    'ドキュメント:\n' +
    corpus +
    '\n\n' +
    '次の JSON だけ返せ:\n' +
    '{\n' +
    '  "items": [\n' +
    '    {\n' +
    '      "kind": "improve" | "spec" | "surplus",\n' +
    '      "key": "英数字とハイフンの短い安定キー（再提案防止用）",\n' +
    '      "priority": "高" | "中" | "低",\n' +
    '      "gap_level": "大" | "中" | "小",\n' +
    '      "title_body": "Prefixなし40字以内",\n' +
    '      "source_path": "根拠になったファイルパス（分かる範囲）",\n' +
    '      "project_name": "候補の正式名そのもの または null",\n' +
    '      "project_confidence": 0.0,\n' +
    '      "ideal": "理想の1〜3文",\n' +
    '      "current": "文書上の現状の1〜3文",\n' +
    '      "gap": "乖離・判断ポイントの1〜3文"\n' +
    '    }\n' +
    '  ]\n' +
    '}';

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    GAP_GEMINI_MODEL +
    ':generateContent?key=' +
    apiKey;

  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.3,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    muteHttpExceptions: true,
  });

  const raw = res.getContentText() || '';
  const data = JSON.parse(raw || '{}');
  if (data.error) {
    throw new Error('Gemini APIエラー: ' + (data.error.message || JSON.stringify(data.error)));
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 空レスポンス: ' + raw.slice(0, 400));

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Gemini JSON パース失敗');
    parsed = JSON.parse(m[0]);
  }

  return (parsed.items || [])
    .map(function (it) {
      return normalizeDocReviewItem_(repoFullName, it);
    })
    .filter(function (it) {
      return !!it;
    });
}

function normalizeDocReviewItem_(repoFullName, it) {
  const kind = normalizeGapKind_(it && it.kind);
  if (!kind) return null;

  const key = String((it && it.key) || it.title_body || kind)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!key) return null;

  const priority = normalizeGapPriority_(it.priority);
  const gapLevel = normalizeGapLevel_(it.gap_level);
  const titleBody = String(it.title_body || key).slice(0, 60);
  const prefix = GAP_PREFIX[kind] || '[ギャップ]';
  const confidence =
    typeof it.project_confidence === 'number'
      ? it.project_confidence
      : Number(it.project_confidence);

  return {
    kind: kind,
    repo: repoFullName,
    fingerprint: 'gap/' + kind + '/' + String(repoFullName).toLowerCase() + '/' + key,
    sourcePath: String(it.source_path || '').slice(0, 200),
    projectName: it.project_name == null ? null : String(it.project_name).trim(),
    projectConfidence: isNaN(confidence) ? 0 : confidence,
    priority: priority,
    gapLevel: gapLevel,
    title: (prefix + ' ' + titleBody).slice(0, 100),
    ideal: String(it.ideal || '').slice(0, 1500),
    current: String(it.current || '').slice(0, 1500),
    gap: String(it.gap || '').slice(0, 1500),
  };
}

function normalizeGapKind_(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'improve' || s === '改善') return 'improve';
  if (s === 'spec' || s === '仕様') return 'spec';
  if (s === 'surplus' || s === '余剰') return 'surplus';
  return null;
}

/**
 * ギャップ監視専用のプロジェクト解決。
 * 優先順: 本文/パスのヒューリスティック → Gemini 高信頼 → デフォルト
 * （メール用 resolve は GitHub 欄一致で Jackson に寄りやすいため使わない）
 */
function resolveGapProject_(projects, scanRepo, item) {
  const textBlob = [item.sourcePath, item.title, item.titleBody, item.ideal, item.current, item.gap]
    .filter(Boolean)
    .join('\n');

  const hinted = inferProjectFromText_(projects, textBlob);
  if (hinted) {
    return { project: hinted, mode: 'content' };
  }

  const geminiName = String(item.projectName || '').trim();
  const conf =
    typeof item.projectConfidence === 'number'
      ? item.projectConfidence
      : Number(item.projectConfidence);
  if (geminiName && geminiName.toLowerCase() !== 'null' && !isNaN(conf) && conf >= 0.55) {
    const matched = findProjectByName_(projects, geminiName);
    if (matched) {
      // スキャン対象リポが紐づくプロジェクトへ、根拠なしで寄せるのは避ける
      const repos = String(matched.repos || '').toLowerCase();
      const onlyBecauseSharedRepo =
        repos.indexOf(String(scanRepo || '').toLowerCase()) !== -1 &&
        !textMentionsProject_(textBlob, matched);
      if (!onlyBecauseSharedRepo) {
        return { project: matched, mode: 'match' };
      }
    }
  }

  const fallback = findDefaultProject_(projects);
  if (fallback) return { project: fallback, mode: 'default' };
  return { project: null, mode: 'none' };
}

function findProjectByName_(projects, name) {
  const lower = String(name || '')
    .trim()
    .toLowerCase();
  if (!lower || !projects) return null;
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].name.toLowerCase() === lower) return projects[i];
  }
  for (var j = 0; j < projects.length; j++) {
    const n = projects[j].name.toLowerCase();
    if (n.indexOf(lower) !== -1 || lower.indexOf(n) !== -1) return projects[j];
  }
  return null;
}

/**
 * パス・本文にプロジェクト名（やそのトークン）が出ていればそれを返す。
 * 複数ヒット時はより長い名前（具体的）を優先。
 */
function inferProjectFromText_(projects, text) {
  if (!projects || !projects.length) return null;
  const blob = normalizeGapProjectText_(text);
  if (!blob) return null;

  let best = null;
  let bestScore = 0;
  projects.forEach(function (p) {
    const score = scoreProjectMention_(blob, p);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return bestScore > 0 ? best : null;
}

function textMentionsProject_(text, project) {
  return scoreProjectMention_(normalizeGapProjectText_(text), project) > 0;
}

function scoreProjectMention_(normalizedBlob, project) {
  if (!project || !normalizedBlob) return 0;
  const name = String(project.name || '');
  const nameNorm = normalizeGapProjectText_(name);
  if (nameNorm && normalizedBlob.indexOf(nameNorm) !== -1) return 100 + nameNorm.length;

  // 「Takakyu project」→ takakyu / 「Jackson office project」→ jackson など
  const tokens = name
    .split(/\s+/)
    .map(function (t) {
      return normalizeGapProjectText_(t);
    })
    .filter(function (t) {
      return t && t.length >= 3 && t !== 'project' && t !== 'office';
    });

  let score = 0;
  tokens.forEach(function (t) {
    if (normalizedBlob.indexOf(t) !== -1) score += 10 + t.length;
  });
  return score;
}

function normalizeGapProjectText_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s_\-/]+/g, '')
    .replace(/project/g, '');
}

function formatGapProjectAssignLabel_(assign) {
  if (!assign || !assign.project) return '未分類（デフォルトプロジェクト未検出）';
  if (assign.mode === 'default') return assign.project.name + '（デフォルト・未分類）';
  if (assign.mode === 'content') return assign.project.name + '（内容・パスから判定）';
  return assign.project.name;
}

function normalizeGapPriority_(v) {
  const s = String(v || '');
  if (s === '高' || s === '中' || s === '低') return s;
  if (/high/i.test(s)) return '高';
  if (/low/i.test(s)) return '低';
  return '中';
}

function normalizeGapLevel_(v) {
  const s = String(v || '');
  if (s === '大' || s === '中' || s === '小') return s;
  if (/high|large/i.test(s)) return '大';
  if (/low|small/i.test(s)) return '小';
  return '中';
}

function orderByPriority_(items) {
  const rank = { 高: 0, 中: 1, 低: 2 };
  return items.slice().sort(function (a, b) {
    return (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
  });
}

// ─────────────────────────────────────────────
// fingerprint / Notion
// ─────────────────────────────────────────────
function shouldSkipGapFingerprint_(token, fingerprint) {
  const pages = queryPagesByFingerprint_(token, fingerprint);
  if (!pages.length) return false;

  const now = Date.now();
  const holdMs = GAP_HOLD_DAYS * 24 * 60 * 60 * 1000;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const tag = page.properties?.['タグ']?.status?.name || '';
    if (tag === '却下') return true;
    if (tag === '保留') {
      const edited = Date.parse(page.last_edited_time);
      if (!isNaN(edited) && now - edited <= holdMs) return true;
      continue;
    }
    return true;
  }
  return false;
}

function queryPagesByFingerprint_(token, fingerprint) {
  const url = 'https://api.notion.com/v1/databases/' + GAP_TASKS_DB_ID + '/query';
  const res = notionPost_(token, url, {
    filter: { property: 'Fingerprint', rich_text: { equals: fingerprint } },
    page_size: 10,
  });
  if (res.object === 'error') {
    throw new Error('Fingerprint 照会失敗: ' + (res.message || JSON.stringify(res)));
  }
  return res.results || [];
}

function createGapTask_(token, item) {
  const properties = {
    プロジェクト名: {
      title: [{ type: 'text', text: { content: String(item.title || '').slice(0, 100) } }],
    },
    タグ: { status: { name: '未着手' } },
    優先度: { select: { name: item.priority || '中' } },
    Fingerprint: {
      rich_text: [{ type: 'text', text: { content: String(item.fingerprint).slice(0, 200) } }],
    },
  };

  if (item.repo) {
    properties['GitHubリポジトリ'] = { select: { name: item.repo } };
  }
  if (item.projectId) {
    properties['プロジェクト'] = { relation: [{ id: item.projectId }] };
  }

  const gapLine = '程度: ' + (item.gapLevel || '中') + '\n内容: ' + (item.gap || '');
  const children = [
    gapHeading2_('理想'),
    gapParagraph_(item.ideal || ''),
    gapHeading2_('現状'),
    gapParagraph_(item.current || ''),
    gapHeading2_('乖離'),
    gapParagraph_(gapLine),
  ];
  if (item.sourcePath) {
    children.push(gapParagraph_('根拠docs: ' + item.sourcePath));
  }
  if (item.projectAssignLabel) {
    children.push(gapParagraph_('分類プロジェクト: ' + item.projectAssignLabel));
  }

  const res = notionPost_(token, 'https://api.notion.com/v1/pages', {
    parent: { database_id: GAP_TASKS_DB_ID },
    properties: properties,
    children: children,
  });
  if (res.object === 'error') {
    throw new Error('Notion ページ作成失敗: ' + (res.message || JSON.stringify(res)));
  }
  return res;
}

function gapHeading2_(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: String(text).slice(0, 2000) } }],
    },
  };
}

function gapParagraph_(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: String(text || '').slice(0, 1900) } }],
    },
  };
}
