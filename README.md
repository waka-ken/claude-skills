# Claude Code 開発環境（Docker）

このリポジトリは **Docker コンテナ内で Claude Code を実行する** ための開発環境です。

## 前提条件

- Docker Desktop または Docker Engine
- Docker Compose v2
- Cursor または VS Code（Dev Containers 拡張機能推奨）
- ホスト側に GitHub 用 SSH 鍵（`~/.ssh`）があること（推奨）

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

## マウント一覧

| ホスト | コンテナ | 用途 |
|--------|----------|------|
| ワークスペース | `/workspace` | リポジトリ本体 |
| Docker volume `claude-config` | `/home/node/.claude` | Claude Code 認証・設定の永続化 |
| `${HOME}/.ssh` | `/home/node/.ssh` | GitHub SSH 鍵（rw） |
| `${HOME}/.gitconfig` | `/home/node/.gitconfig` | git 作者情報（ro） |

Dev Container では `${localEnv:HOME}`、compose では `${HOME}` を参照します（WSL / Linux のホームを想定）。

## 認証

### Claude Code

| 方法 | 手順 |
|------|------|
| OAuth（推奨） | コンテナ内で `claude` を実行し、ブラウザでログイン |
| API キー | `.env` に `ANTHROPIC_API_KEY` を設定 |

認証情報は Docker ボリューム `claude-config`（または devcontainer の `claude-code-config-*`）に永続化されます。

### GitHub（git push / gh）

ホストの `~/.ssh` をコンテナにマウントし、SSH で GitHub に接続する想定です。

**前提**

- ホストに `~/.ssh/id_ed25519`（または `id_rsa`）など GitHub 登録済みの鍵がある
- 秘密鍵の権限は `600`、ディレクトリは `700`（`postCreate` でも軽く整える）

**動作確認（コンテナ内）**

```bash
ls -la ~/.ssh
ssh -T git@github.com
```

成功例: `Hi <user>! You've successfully authenticated...`

**フォールバック（SSH が使えない場合）**

```bash
gh auth login
# Git operations は HTTPS を選択
git -c credential.helper='!gh auth git-credential' push https://github.com/OWNER/REPO.git BRANCH
```

`gh` のトークン認証は HTTPS 向けです。`origin` が `git@github.com:...` のままだと SSH 鍵が必要になります。

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

設定変更（マウント追加など）後は **Rebuild Container** または `docker compose up -d --build` が必要です。

## ディレクトリ構成

```
.devcontainer/
  Dockerfile          # Claude Code + 開発ツール
  devcontainer.json   # Cursor/VS Code 用設定
docker-compose.yml    # スタンドアロン実行用
scripts/dev-shell.sh  # コンテナ起動ヘルパー
github_dispatch.gs    # Notion → GitHub Dispatch 中継（GAS）
email_alert_ingestor.gs  # 必須対応メール監視 → Notion（GAS）
docs/notion-claude-pipeline-spec.md  # AIパイプライン仕様
docs/mandatory-email-setup.md        # メール監視セットアップ
```

## Notion × Claude 自動開発パイプライン

仕様とセットアップ手順:

- [仕様](docs/notion-claude-pipeline-spec.md)
- [Notion Automation](docs/notion-automation-setup.md)
- [GitHub Actions 導入](docs/github-actions-setup.md)
- [必須対応メール → Notion 提案](docs/mandatory-email-to-notion-proposal.md)
- [必須対応メール監視セットアップ](docs/mandatory-email-setup.md)
