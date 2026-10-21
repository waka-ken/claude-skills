#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# コンテナ起動時に VS Code / Cursor 拡張機能を自動インストールする。
#
# 「Reopen in Container」なら devcontainer.json の customizations.vscode.extensions
# が効くが、Cursor / VS Code の「Attach to Running Container」ではそれが無視される。
# どちらの繋ぎ方でも拡張が入るよう、コンテナ側からインストールを実行する。
#
# インストール対象は .devcontainer/devcontainer.json の
# customizations.vscode.extensions を唯一の情報源として読み取る（二重管理しない）。
# 一覧の更新方法: `code --list-extensions` の出力と突き合わせて devcontainer.json を編集。
#
# 呼び出し元:
#   - docker-compose.yml の command（バックグラウンドで起動。エディタ接続待ちを含む）
#   - devcontainer.json の postStartCommand（Reopen in Container 用）
# ---------------------------------------------------------------------------
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DEVCONTAINER_JSON="${SCRIPT_DIR}/devcontainer.json"

# エディタのサーバ（code-server CLI）が注入されるまで待つ秒数。
# `docker compose up` 直後はまだエディタが繋がっていないため待機する。
TIMEOUT="${EXT_INSTALL_TIMEOUT:-600}"
INTERVAL=5

log() { printf '[install-extensions] %s\n' "$*"; }

# --- devcontainer.json から拡張 ID の一覧を取り出す ------------------------
# JSONC（コメント付き JSON）なので `//` 行コメントを除去してから
# "publisher.name" 形式のトークンだけを拾う。
read_extension_ids() {
  sed -n '/"extensions": *\[/,/\]/p' "$DEVCONTAINER_JSON" \
    | sed 's://.*$::' \
    | grep -oE '"[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]+"' \
    | tr -d '"'
}

# --- code-server CLI を探す（VS Code / Cursor 両対応） --------------------
find_code_cli() {
  for base in "$HOME/.vscode-server" "$HOME/.vscode-server-insiders" "$HOME/.cursor-server"; do
    for cli in "$base"/bin/*/bin/code-server; do
      [ -x "$cli" ] && { echo "$cli"; return 0; }
    done
  done
  return 1
}

wait_for_code_cli() {
  waited=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    CODE_CLI=$(find_code_cli) && { echo "$CODE_CLI"; return 0; }
    sleep "$INTERVAL"
    waited=$((waited + INTERVAL))
  done
  return 1
}

# --- 本体 --------------------------------------------------------------------
if [ ! -f "$DEVCONTAINER_JSON" ]; then
  log "devcontainer.json が見つからない: $DEVCONTAINER_JSON"
  exit 0
fi

WANT=$(read_extension_ids)
if [ -z "$WANT" ]; then
  log "インストール対象の拡張が devcontainer.json に定義されていない"
  exit 0
fi

log "エディタサーバ (code-server CLI) を待機中 (最大 ${TIMEOUT}s)..."
CODE_CLI=$(wait_for_code_cli) || {
  log "エディタサーバが見つからなかったため中断（拡張は未インストール）"
  exit 0
}
log "code-server CLI: $CODE_CLI"

INSTALLED=$("$CODE_CLI" --list-extensions 2>/dev/null | tr '[:upper:]' '[:lower:]')

installed_count=0
skipped_count=0
failed_count=0
for ext in $WANT; do
  ext_lc=$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')
  if printf '%s\n' "$INSTALLED" | grep -qx "$ext_lc"; then
    skipped_count=$((skipped_count + 1))
    continue
  fi
  log "インストール: $ext"
  if "$CODE_CLI" --install-extension "$ext" --force >/dev/null 2>&1; then
    installed_count=$((installed_count + 1))
  else
    log "  失敗: $ext"
    failed_count=$((failed_count + 1))
  fi
done

log "完了: 新規 ${installed_count} / 既存 ${skipped_count} / 失敗 ${failed_count}"
exit 0
