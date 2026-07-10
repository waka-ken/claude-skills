#!/bin/bash
set -euo pipefail

SETTINGS="/workspace/.claude/settings.json"

NOTION_TOKEN=$(jq -r '.env.NOTION_TOKEN' "$SETTINGS")
NOTION_DATABASE_ID="380db617-4b67-80a9-bdc4-cad9411d207c"
SLACK_WEBHOOK_URL=$(jq -r '.env.SLACK_WEBHOOK_URL' "$SETTINGS")

if [[ -z "$NOTION_TOKEN" || "$NOTION_TOKEN" == "null" ]]; then
  echo "ERROR: NOTION_TOKEN が未設定です ($SETTINGS を確認してください)" >&2
  exit 1
fi

export NOTION_TOKEN

RESPONSE=$(curl -s -X POST "https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query" \
  -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {"property": "タグ", "status": {"does_not_equal": "完了"}},
    "sorts": [{"property": "期間", "direction": "ascending"}],
    "page_size": 50
  }')

if echo "$RESPONSE" | jq -e '.object == "error"' > /dev/null 2>&1; then
  echo "ERROR: Notion API エラー: $(echo "$RESPONSE" | jq -r '.message')" >&2
  exit 1
fi

MESSAGE=$(echo "$RESPONSE" | python3 -c "
import json, sys, datetime, os, urllib.request
from collections import defaultdict

data = json.load(sys.stdin)
tasks = data.get('results', [])
today = datetime.date.today().isoformat()
notion_token = os.environ.get('NOTION_TOKEN', '')

# ユニークなプロジェクトIDを収集
all_project_ids = set()
for t in tasks:
    for r in t['properties'].get('プロジェクト', {}).get('relation', []):
        all_project_ids.add(r['id'])

# プロジェクト名を解決
project_names = {}
for pid in all_project_ids:
    req = urllib.request.Request(
        f'https://api.notion.com/v1/pages/{pid}',
        headers={
            'Authorization': f'Bearer {notion_token}',
            'Notion-Version': '2022-06-28',
        }
    )
    try:
        with urllib.request.urlopen(req) as resp:
            page_data = json.loads(resp.read())
            title_arr = page_data['properties'].get('プロジェクト名', {}).get('title', [])
            project_names[pid] = title_arr[0].get('plain_text', '(不明)') if title_arr else '(不明)'
    except Exception:
        project_names[pid] = '(不明)'

# タスクをプロジェクトごとに分類
project_tasks = defaultdict(list)

for t in tasks:
    p = t['properties']
    name = (p.get('プロジェクト名', {}).get('title') or [{}])[0].get('plain_text', '(無題)')
    status = (p.get('タグ', {}).get('status') or {}).get('name', '-')
    priority = (p.get('優先度', {}).get('select') or {}).get('name', '-')
    due_raw = (p.get('期間', {}).get('date') or {}).get('start')

    overdue = '⚠️ ' if due_raw and due_raw < today else ''
    due_str = f'⏰ 期日: {due_raw[5:]}  ' if due_raw else ''
    priority_icon = {'高': '🔴', '中': '🟡', '低': '🔵'}.get(priority, '⚪')
    status_icon = '🔄' if status == '進行中' else '📋'
    line = f'{status_icon} • {overdue}{name}  {due_str}{priority_icon} {priority}'

    relations = p.get('プロジェクト', {}).get('relation', [])
    proj_name = project_names.get(relations[0]['id'], '(不明)') if relations else 'その他'
    project_tasks[proj_name].append(line)

# メッセージ組み立て
parts = [f'🌅 おはようございます！今日のタスク一覧です ({today})']
total = sum(len(v) for v in project_tasks.values())

if total == 0:
    parts = [f'🌅 おはようございます！({today})\n本日のタスクはありません。良い一日を！']
else:
    sorted_projects = sorted(project_tasks.keys(), key=lambda x: (x == 'その他', x))
    for proj in sorted_projects:
        task_lines = project_tasks[proj]
        parts.append(f'\n📁 {proj} ({len(task_lines)}件)')
        parts.extend(task_lines)
    parts.append(f'\n📌 合計 {total}件のタスクが残っています。良い一日を！')

print('\n'.join(parts))
")

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  --data-binary "{\"text\": $(echo "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")

echo "$MESSAGE"
echo ""
if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "✅ Slack に送信しました"
else
  echo "❌ Slack 送信失敗 (HTTP $HTTP_STATUS)" >&2
  exit 1
fi
