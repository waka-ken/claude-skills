/**
 * 毎朝タスクまとめ通知スクリプト
 * Google Apps Script
 *
 * ※ 共通定数・ヘルパーは common.gs を参照
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【初回セットアップ手順】
 *
 * 1. script.google.com で新規プロジェクト作成
 * 2. common.gs / morning_tasks.gs を貼り付け
 * 3. スクリプトプロパティを common.gs の説明に従って設定（NOTION_TOKEN / SLACK_TOKEN）
 * 4. setupMorningTrigger() を一度だけ手動実行
 * 5. testMorningRun() で動作確認（Slackに実際に送信されます）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────
const MORNING_TASKS_DB_ID = '380db617-4b67-80a9-bdc4-cad9411d207c'; // [DB] オールタスク管理

// ─────────────────────────────────────────────
// メインエントリーポイント（平日7:00 JSTに実行）
// ─────────────────────────────────────────────
function sendMorningTasks() {
  const props = PropertiesService.getScriptProperties();
  const notionToken = props.getProperty('NOTION_TOKEN');
  const slackToken = props.getProperty('SLACK_TOKEN');

  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  const todayIso = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  try {
    const tasks = fetchIncompleteTasks_(notionToken);
    const message = formatMessage_(tasks, today, todayIso);
    notifySlack_(slackToken, message);
  } catch (e) {
    notifySlack_(
      slackToken,
      `⚠️ 朝のタスク通知でエラーが発生しました（${today}）\nエラー内容: ${e.message}`
    );
    throw e;
  }
}

// ─────────────────────────────────────────────
// NOTION: 未完了タスクを取得
// ─────────────────────────────────────────────
function fetchIncompleteTasks_(token) {
  const url = `https://api.notion.com/v1/databases/${MORNING_TASKS_DB_ID}/query`;

  const res = notionPost_(token, url, {
    filter: {
      or: [
        { property: 'タグ', status: { equals: '未着手' } },
        { property: 'タグ', status: { equals: '進行中' } },
      ],
    },
    sorts: [
      { property: 'タグ', direction: 'ascending' }, // 進行中→未着手
      { property: '期間', direction: 'ascending' }, // 期限が近い順
    ],
    page_size: 30,
  });

  const tasks = (res.results || []).map(page => {
    const props = page.properties;

    const titleProp = Object.values(props).find(p => p.type === 'title');
    const title = titleProp?.title?.map(t => t.plain_text).join('') || '(無題)';

    const statusProp = props['タグ'];
    const status = statusProp?.status?.name || statusProp?.select?.name || '';

    const dueDate = props['期間']?.date?.start || null;
    const priority = props['優先度']?.select?.name || null;

    // プロジェクトリレーションのID（複数ある場合は最初の1件を使用）
    const projectIds = props['プロジェクト']?.relation?.map(r => r.id) || [];

    return { title, status, dueDate, priority, projectIds };
  });

  // プロジェクト名を一括取得（同一プロジェクトはキャッシュして重複APIコールを防ぐ）
  const projectNameCache = {};
  for (const task of tasks) {
    for (const id of task.projectIds) {
      if (!projectNameCache[id]) {
        const page = notionGet_(token, `https://api.notion.com/v1/pages/${id}`);
        const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
        projectNameCache[id] = titleProp?.title?.map(t => t.plain_text).join('') || '(名称不明)';
      }
    }
    task.projectName =
      task.projectIds.length > 0
        ? task.projectIds.map(id => projectNameCache[id]).join(' / ')
        : 'その他';
  }

  return tasks;
}

// ─────────────────────────────────────────────
// タスクリストをSlack向けメッセージに整形
// ─────────────────────────────────────────────
function formatMessage_(tasks, today, todayIso) {
  if (tasks.length === 0) {
    return `🌅 おはようございます！ (${today})\n本日のタスクはありません 🎉`;
  }

  // プロジェクトごとにグルーピング（「その他」は末尾）
  const OTHER = 'その他';
  const grouped = {};
  for (const task of tasks) {
    const key = task.projectName || OTHER;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(task);
  }
  const sortedKeys = Object.keys(grouped)
    .filter(k => k !== OTHER)
    .sort()
    .concat(grouped[OTHER] ? [OTHER] : []);

  const lines = [`🌅 おはようございます！今日のタスク一覧です (${today})\n`];

  for (const projectName of sortedKeys) {
    lines.push(`*【${projectName}】*`);
    for (const task of grouped[projectName]) {
      const statusEmoji = task.status === '進行中' ? '🔄' : '📋';
      const priorityEmoji =
        task.priority === '高'
          ? ' 🔴'
          : task.priority === '中'
            ? ' 🟡'
            : task.priority === '低'
              ? ' 🟢'
              : '';
      const overdueEmoji = task.dueDate && task.dueDate <= todayIso ? ' ⚠️' : '';
      const dueLabel = task.dueDate ? ` (期限: ${task.dueDate})` : '';
      lines.push(`　${statusEmoji}${priorityEmoji}${overdueEmoji} ${task.title}${dueLabel}`);
    }
    lines.push('');
  }

  lines.push(`📌 合計 ${tasks.length}件のタスクが残っています。良い一日を！`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// タイムトリガー設定（一度だけ手動実行）
// ─────────────────────────────────────────────
function setupMorningTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendMorningTasks')
    .forEach(t => ScriptApp.deleteTrigger(t));

  const weekdays = [
    ScriptApp.WeekDay.MONDAY,
    ScriptApp.WeekDay.TUESDAY,
    ScriptApp.WeekDay.WEDNESDAY,
    ScriptApp.WeekDay.THURSDAY,
    ScriptApp.WeekDay.FRIDAY,
  ];
  for (const day of weekdays) {
    ScriptApp.newTrigger('sendMorningTasks')
      .timeBased()
      .onWeekDay(day)
      .atHour(7)
      .inTimezone('Asia/Tokyo')
      .create();
  }

  Logger.log('✅ 朝タスク通知トリガーを設定しました（平日 07:00 JST）');
}

// ─────────────────────────────────────────────
// 動作テスト
// ─────────────────────────────────────────────
function testMorningRun() {
  const props = PropertiesService.getScriptProperties();
  const notionToken = props.getProperty('NOTION_TOKEN');
  const slackToken = props.getProperty('SLACK_TOKEN');

  const notionRes = notionPost_(
    notionToken,
    `https://api.notion.com/v1/databases/${MORNING_TASKS_DB_ID}/query`,
    { page_size: 1 }
  );
  Logger.log(
    'Notion: ' +
      (notionRes.object === 'list'
        ? `✅ OK（${notionRes.results?.length}件取得）`
        : '❌ NG: ' + JSON.stringify(notionRes))
  );

  const slackRes = UrlFetchApp.fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${slackToken}` },
    muteHttpExceptions: true,
  });
  const slackData = JSON.parse(slackRes.getContentText());
  Logger.log(
    'Slack: ' + (slackData.ok ? `✅ OK (${slackData.user})` : '❌ NG: ' + slackData.error)
  );

  // 実際にメッセージを送信して確認
  Logger.log('実際にSlackへ送信します...');
  sendMorningTasks();
  Logger.log('✅ 送信完了');
}
