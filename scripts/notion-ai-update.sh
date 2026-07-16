#!/usr/bin/env bash
# Notion AIメタ更新ヘルパー（対象リポにコピー可）
# 使い方:
#   NOTION_TOKEN=... NOTION_PAGE_ID=... ./notion-ai-update.sh implement
#   NOTION_TOKEN=... NOTION_PAGE_ID=... PR_URL=... ./notion-ai-update.sh pr
#   NOTION_TOKEN=... NOTION_PAGE_ID=... ERROR_MSG=... ./notion-ai-update.sh fail

set -euo pipefail

MODE="${1:-}"
PAGE_ID="${NOTION_PAGE_ID:-}"
TOKEN="${NOTION_TOKEN:-}"
VERSION="2022-06-28"

if [[ -z "$MODE" || -z "$PAGE_ID" || -z "$TOKEN" ]]; then
  echo "Usage requires MODE, NOTION_PAGE_ID, NOTION_TOKEN" >&2
  exit 1
fi

case "$MODE" in
  implement)
    BODY='{"properties":{"AIステータス":{"select":{"name":"AI実装中"}}}}'
    ;;
  pr)
    PR_URL="${PR_URL:-}"
    if [[ -z "$PR_URL" ]]; then
      echo "PR_URL required" >&2
      exit 1
    fi
    BODY=$(jq -n --arg url "$PR_URL" '{
      properties: {
        "AIステータス": { select: { name: "PR作成済" } },
        "PR URL": { url: $url },
        "AI最終エラー": { rich_text: [] }
      }
    }')
    ;;
  fail)
    MSG="${ERROR_MSG:-unknown error}"
    BODY=$(jq -n --arg msg "${MSG:0:1900}" '{
      properties: {
        "AIステータス": { select: { name: "AI失敗" } },
        "AI最終エラー": { rich_text: [{ type: "text", text: { content: $msg } }] }
      }
    }')
    ;;
  *)
    echo "Unknown mode: $MODE (implement|pr|fail)" >&2
    exit 1
    ;;
esac

curl -sS -X PATCH "https://api.notion.com/v1/pages/${PAGE_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Notion-Version: ${VERSION}" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo
