# Claude Code 開発環境（Docker）

このリポジトリは **Docker コンテナ内で Claude Code を実行する** ための開発環境です。

## 前提条件

- Docker Desktop または Docker Engine
- Docker Compose v2
- Cursor または VS Code（Dev Containers 拡張機能推奨）

## セットアップ

### 方法 A: Cursor / VS Code でコンテナ内開発（推奨）

1. このリポジトリを Cursor で開く
2. コマンドパレット（`Ctrl+Shift+P`）→ **Dev Containers: Reopen in Container**
3. 初回ビルド完了後、ターミナルで認証:

```bash
claude
```

ブラウザ認証が完了すれば、以降はコンテナ再ビルド後も `~/.claude` ボリュームに認証情報が保持されます。

### 方法 B: docker compose でシェルに入る

```bash
cp .env.example .env   # API キーを使う場合のみ編集
chmod +x scripts/dev-shell.sh
./scripts/dev-shell.sh
```

コンテナ内で Claude Code を起動:

```bash
claude --version
claude
```

## 認証

| 方法 | 手順 |
|------|------|
| OAuth（推奨） | コンテナ内で `claude` を実行し、ブラウザでログイン |
| API キー | `.env` に `ANTHROPIC_API_KEY` を設定 |

認証情報は Docker ボリューム `claude-config`（または devcontainer の `claude-code-config-*`）に永続化されます。

## よく使うコマンド

```bash
# イメージをビルド
docker compose build

# バックグラウンド起動
docker compose up -d

# コンテナに入る
docker compose exec claude-dev bash

# 停止
docker compose down
```

## ディレクトリ構成

```
.devcontainer/
  Dockerfile          # Claude Code + 開発ツール
  devcontainer.json   # Cursor/VS Code 用設定
docker-compose.yml    # スタンドアロン実行用
scripts/dev-shell.sh  # コンテナ起動ヘルパー
```
