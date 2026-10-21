FROM node:20-bookworm

ARG CLAUDE_CODE_VERSION=latest

# 基本開発ツール
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    less \
    nano \
    openssh-client \
    procps \
    sudo \
    unzip \
    vim \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI（Debian 標準の gh は古い版で止まっているため、公式 apt リポジトリから入れる）
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version

# npm グローバルパッケージ用ディレクトリ
RUN mkdir -p /usr/local/share/npm-global \
    && chown -R node:node /usr/local/share

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH="${PATH}:/usr/local/share/npm-global/bin"
ENV DEVCONTAINER=true
ENV SHELL=/bin/bash

# 作業ディレクトリと、ボリュームで永続化するディレクトリ
# 空の named volume は初回マウント時にイメージ側の所有者を引き継ぐため、node 所有で先に作っておく
# （作らないと root 所有になり、拡張のインストールや gh auth login が権限エラーになる）
RUN mkdir -p /workspace \
        /home/node/.claude \
        /home/node/.config/gh \
        /home/node/.vscode-server/extensions \
        /home/node/.cursor-server/extensions \
    && chown -R node:node /workspace /home/node

WORKDIR /workspace

USER node

# Claude Code CLI
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Cursor ターミナル等で PATH が短縮される場合でも claude を使えるようにする
USER root
RUN ln -sf /usr/local/share/npm-global/bin/claude /usr/local/bin/claude
USER node

CMD ["bash"]
