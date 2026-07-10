FROM node:20-bookworm

ARG CLAUDE_CODE_VERSION=latest

# 基本開発ツール
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gh \
    jq \
    less \
    nano \
    procps \
    sudo \
    unzip \
    vim \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# npm グローバルパッケージ用ディレクトリ
RUN mkdir -p /usr/local/share/npm-global \
    && chown -R node:node /usr/local/share

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH="${PATH}:/usr/local/share/npm-global/bin"
ENV DEVCONTAINER=true
ENV SHELL=/bin/bash

# 作業ディレクトリと Claude 設定ディレクトリ
RUN mkdir -p /workspace /home/node/.claude \
    && chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

USER node

# Claude Code CLI
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Cursor ターミナル等で PATH が短縮される場合でも claude を使えるようにする
USER root
RUN ln -sf /usr/local/share/npm-global/bin/claude /usr/local/bin/claude
USER node

CMD ["bash"]
