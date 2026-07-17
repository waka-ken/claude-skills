# GitHub Actions 導入手順（対象リポジトリ）

対象例: `waka-ken/jackson-office-api`（プロジェクトDBの `GitHubリポジトリ`）

## 1. ファイルをコピー

| このリポ | 対象リポ |
|----------|----------|
| [`docs/workflows/notion-ai-task.yml`](workflows/notion-ai-task.yml) | `.github/workflows/notion-ai-task.yml` |
| [`scripts/notion-ai-update.sh`](../scripts/notion-ai-update.sh) | `scripts/notion-ai-update.sh`（任意・フォールバック付き） |

## 2. Secrets

対象リポの Settings → Secrets and variables → Actions:

| Name | 内容 |
|------|------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth（`claude setup-token` で生成。Pro/Max 枠を使用） |
| `NOTION_TOKEN` | Notion Integration（オールタスク管理 / プロジェクトDBへ接続済み） |

`GITHUB_TOKEN` は Actions 既定で足りる（contents / pull-requests）。

## 2.1. リポジトリ設定（マージ後ブランチ削除）

Settings → General → Pull Requests で **Automatically delete head branches** を ON にする。

```bash
gh api -X PATCH repos/OWNER/REPO -f delete_branch_on_merge=true
```

AI が作る `ai/notion-*` ブランチが、PR マージ後に残らないようにするため。

## 3. PAT（GAS 側）との関係

GAS の `GITHUB_PAT` は対象リポへ `repository_dispatch` を送るため、少なくとも:

- `repo`
- `workflow`（private リポで dispatch する場合に必要になることが多い）

**対象リポを増やすとき:** Fine-grained PAT なら Repository access に新リポ（例: `waka-ken/core-RAG`）を追加する。Classic PAT なら所有者アカウントが当該 private リポへアクセスできること。アクセスが無いと GitHub は `404 Not Found` を返し、Notion は `AI失敗` になる（jackson だけ通って core-RAG だけ落ちる、という症状になりやすい）。

## 4. 手動 smoke test

```bash
gh api repos/waka-ken/jackson-office-api/dispatches \
  -f event_type=notion-ai-task \
  -f client_payload[notion_page_id]='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' \
  -f client_payload[title]='smoke test' \
  -f client_payload[background]='test' \
  -f client_payload[todo]='noop' \
  -f client_payload[done_criteria]='Draft PR' \
  -f client_payload[body_markdown]='## 背景\ntest' \
  -f client_payload[dispatch_id]='manual-smoke-1'
```

## 5. 期待フロー

1. `design` job が `.ai_todo.md` を生成して push
2. Notion `AIステータス` → `AI実装中`
3. `implement` job が Claude Code Action で実装し PR 作成
4. Notion `AIステータス` → `PR作成済`、`PR URL` 書き戻し
5. 失敗時 → `AI失敗` + `AI最終エラー`
