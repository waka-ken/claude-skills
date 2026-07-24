#!/usr/bin/env bash
# Before the agent stops, fail closed on remaining .gs lint/format issues.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Always acknowledge stop payload
cat >/dev/null

if [[ ! -d "$ROOT/node_modules/eslint" ]]; then
  echo '{}'
  exit 0
fi

check_out="$(npm run check --silent 2>&1 || true)"
if echo "$check_out" | grep -Eq 'error|✖|failed|Code style issues'; then
  node -e '
    const msg = process.argv[1].slice(0, 3500);
    console.log(JSON.stringify({
      followup_message:
        "`.gs` の lint/format チェックが失敗しています。修正してから完了してください。\n\n" + msg
    }));
  ' "$check_out"
else
  echo '{}'
fi
exit 0
