#!/usr/bin/env bash
# リポ直下の *.gs を Apps Script プロジェクトへ反映する（GitHub Actions の gas-deploy から実行。ローカルでも可）
#
# 必要な環境変数:
#   GAS_SCRIPT_ID            : 反映先のスクリプト ID（GAS エディタ →「プロジェクトの設定」→「スクリプト ID」）
#   GAS_WEBAPP_DEPLOYMENT_ID : （任意）Web App のデプロイ ID。指定すると新バージョンを作り、このデプロイに割り当てる
#                              時間トリガーは常に最新コードで動くが、Web App（doPost）はバージョン固定のため
#   GAS_BASE_REF             : （任意）前回反映したはずのコミット。リモートがこれと一致すれば反映する（ずれ検知）
#   GAS_SKIP_DRIFT_CHECK     : （任意）'true' でずれ検知を省略する（リモートの変更は消える）
# 前提: ~/.clasprc.json（`npx @google/clasp@2.4.2 login` の結果）があること
set -euo pipefail

# .clasprc.json の形式が clasp 2 系と 3 系で異なるため、login と同じ版に固定する
CLASP_VERSION=2.4.2

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_DIR="$ROOT_DIR/.gas-deploy"

: "${GAS_SCRIPT_ID:?GAS_SCRIPT_ID が未設定です}"

clasp() { npx --yes "@google/clasp@${CLASP_VERSION}" "$@"; }

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cd "$STAGE_DIR"
printf '{"scriptId":"%s","rootDir":".","fileExtension":"gs"}\n' "$GAS_SCRIPT_ID" > .clasp.json

# マニフェスト（appsscript.json: タイムゾーン・OAuth スコープ・Web App 設定）はリポで管理していないため、
# リモートの現行版を取得してそのまま使う
clasp pull

# clasp push はリモートを丸ごと置き換える。GAS エディタで直接直した内容を古いリポの内容で
# 巻き戻さないよう、リモートが「前回反映したコミット（GAS_BASE_REF）」か「今回のコミット（HEAD）」と
# 一致するときだけ進める。どちらとも違えば、リポに無い変更がリモートにある（ずれ）とみなして止める
remote_files() { find . -type f ! -name .clasp.json ! -name appsscript.json | sed 's|^\./||' | sort; }
ref_files() { git -C "$ROOT_DIR" ls-tree --name-only "$1" | grep '\.gs$' | sort; }
remote_matches_ref() {
  local ref="$1" f
  git -C "$ROOT_DIR" rev-parse --verify --quiet "$ref^{commit}" > /dev/null || return 1
  [[ "$(remote_files)" == "$(ref_files "$ref")" ]] || return 1
  while IFS= read -r f; do
    git -C "$ROOT_DIR" show "$ref:$f" | cmp -s - "$f" || return 1
  done < <(remote_files)
}

if [[ "${GAS_SKIP_DRIFT_CHECK:-}" == "true" ]]; then
  echo "::warning::ずれ検知を省略して反映します（GAS_SKIP_DRIFT_CHECK=true）"
elif remote_matches_ref HEAD; then
  echo "リモートは HEAD と同じ内容です（再反映）"
elif [[ -n "${GAS_BASE_REF:-}" ]] && remote_matches_ref "$GAS_BASE_REF"; then
  echo "リモートは ${GAS_BASE_REF} と同じ内容です。HEAD を反映します"
else
  echo "::error::リモートにリポに無い変更があります（GAS エディタでの直接編集など）。リモートの内容をリポに取り込んでから再実行してください: $(remote_files | tr '\n' ' ')"
  exit 1
fi

find . -type f ! -name .clasp.json ! -name appsscript.json -delete
cp "$ROOT_DIR"/*.gs .
# --force: マニフェストの上書き確認を出さない（中身はリモートから取得した現行版）
clasp push --force

if [[ -n "${GAS_WEBAPP_DEPLOYMENT_ID:-}" ]]; then
  rev="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
  clasp deploy --deploymentId "$GAS_WEBAPP_DEPLOYMENT_ID" --description "auto deploy ${rev}"
fi
