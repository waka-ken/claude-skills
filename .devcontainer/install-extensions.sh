#!/usr/bin/env bash
# Cursor / VS Code 拡張機能をイメージに事前インストールする
set -euo pipefail

TARGET_ARCH="${1:-}"
if [[ -z "${TARGET_ARCH}" ]]; then
  case "$(uname -m)" in
    x86_64|amd64) TARGET_ARCH=amd64 ;;
    aarch64|arm64) TARGET_ARCH=arm64 ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
fi

case "${TARGET_ARCH}" in
  amd64) PLATFORM=linux-x64 ;;
  arm64) PLATFORM=linux-arm64 ;;
  *)
    echo "Unsupported TARGETARCH: ${TARGET_ARCH}" >&2
    exit 1
    ;;
esac

EXT_ROOTS=(
  /home/node/.cursor-server/extensions
  /home/node/.vscode-server/extensions
)

install_vsix() {
  local vsix_url="$1"
  local platform_suffix="$2"
  local tmp dest folder publisher name version root

  tmp="$(mktemp -d)"
  curl -fsSL "${vsix_url}" -o "${tmp}/ext.vsix"
  unzip -q "${tmp}/ext.vsix" -d "${tmp}/extracted"

  publisher="$(jq -r '.publisher' "${tmp}/extracted/extension/package.json")"
  name="$(jq -r '.name' "${tmp}/extracted/extension/package.json")"
  version="$(jq -r '.version' "${tmp}/extracted/extension/package.json")"
  folder="$(printf '%s.%s-%s-%s' "${publisher,,}" "${name}" "${version}" "${platform_suffix}")"

  for root in "${EXT_ROOTS[@]}"; do
    mkdir -p "${root}"
    dest="${root}/${folder}"
    rm -rf "${dest}"
    mkdir -p "${dest}"
    cp -a "${tmp}/extracted/extension/." "${dest}/"
    if [[ -f "${tmp}/extracted/extension.vsixmanifest" ]]; then
      cp "${tmp}/extracted/extension.vsixmanifest" "${dest}/.vsixmanifest"
    fi
  done

  rm -rf "${tmp}"
  echo "Installed ${publisher,,}.${name}@${version} (${platform_suffix})"
}

echo "Installing editor extensions for ${PLATFORM}..."

GG_URL="$(curl -fsSL "https://open-vsx.org/api/mhutchie/git-graph/latest" | jq -r '.files.download')"
CC_URL="$(curl -fsSL "https://open-vsx.org/api/Anthropic/claude-code/${PLATFORM}/latest" | jq -r '.files.download')"

if [[ -z "${GG_URL}" || "${GG_URL}" == "null" ]]; then
  echo "Failed to resolve mhutchie.git-graph download URL" >&2
  exit 1
fi
if [[ -z "${CC_URL}" || "${CC_URL}" == "null" ]]; then
  echo "Failed to resolve anthropic.claude-code download URL" >&2
  exit 1
fi

install_vsix "${GG_URL}" "universal"
install_vsix "${CC_URL}" "${PLATFORM}"

chown -R node:node /home/node/.cursor-server /home/node/.vscode-server
echo "Editor extensions installed."
