#!/usr/bin/env bash
# Format + lint a .gs file after the agent edits it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

input="$(cat)"
file_path="$(
  printf '%s' "$input" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        const p = j.file_path || j.path || j.file || "";
        process.stdout.write(String(p));
      } catch {
        process.stdout.write("");
      }
    });
  '
)"

# Resolve relative paths against project root
if [[ -n "$file_path" && "$file_path" != /* ]]; then
  file_path="$ROOT/${file_path#./}"
fi

if [[ -z "$file_path" || "$file_path" != *.gs ]]; then
  echo '{}'
  exit 0
fi

if [[ ! -f "$file_path" ]]; then
  echo '{}'
  exit 0
fi

if [[ ! -d "$ROOT/node_modules/eslint" ]]; then
  node -e 'console.log(JSON.stringify({
    additional_context: "GAS lint tooling is not installed. Run: npm install"
  }))'
  exit 0
fi

rel="${file_path#"$ROOT"/}"
npm run gas:globals --silent >/dev/null
npx prettier --write --log-level warn "$rel" >/dev/null
lint_out="$(npx eslint --no-warn-ignored "$rel" 2>&1 || true)"

if [[ -n "$lint_out" ]]; then
  node -e '
    const msg = process.argv[1];
    console.log(JSON.stringify({
      additional_context:
        "GAS lint found issues in the edited .gs file. Fix before finishing:\n" + msg
    }));
  ' "$lint_out"
else
  echo '{}'
fi
exit 0
