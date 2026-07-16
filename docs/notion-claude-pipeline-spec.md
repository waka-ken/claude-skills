# Notion ✕ Claude Code 自動開発パイプライン — 最終構成仕様

## 1. 全体システム構造（データの流れ）

タスク管理（Notion）、中継（Google Apps Script）、実行（GitHub Actions）の3つが、以下の流れで完全に連携する。

```
[ 1. Notion（司令塔） ]
  │  ・タスク本文に仕様を書く
  │  ・AIステータスを「AIに依頼」に変更
  ▼ 【Webhook (HTTPS POST)】 page_id + secret
[ 2. Google Apps Script（中継役） ] ※Web App / doPost
  │  ・タスク本文（背景/やること/完了条件）を取得
  │  ・タスクの GitHubリポジトリ（無ければプロジェクト）を解決
  │  ・Repository Dispatch API を呼び出す
  ▼ 【GitHub API (HTTPS POST)】
[ 3. GitHub Actions（実行役：公式 Claude Code Action） ]
     ├─ 【Phase 1: 設計】コード解析 ➔ `.ai_todo.md` 生成 ➔ AIステータス=AI実装中
     └─ 【Phase 2: 実装】手順書どおり修正＆テスト ➔ PR作成 ➔ PR URL / AIステータス更新
```

## 2. Notion データ設計

### 方針

| 置き場 | 役割 |
|--------|------|
| **ページ本文** | タスク定義の正（背景 / やること / 完了条件） |
| **プロパティ** | AI メタ情報（進捗・PR・エラー・Dispatch ID）＋ **PR 先リポ**（`GitHubリポジトリ`） |
| **プロジェクトDB** | 業務上のプロジェクト紐付け。`GitHubリポジトリ` はフォールバック用（任意） |

### [DB]オールタスク管理 — AIメタ用プロパティ

| プロパティ | 型 | 用途 |
|------------|-----|------|
| `AIステータス` | select | `AIに依頼` / `AI設計中` / `AI実装中` / `PR作成済` / `AI失敗` |
| `GitHubリポジトリ` | **select** | PR 作成先。選択肢はプロジェクト管理に登録されたリポを同期 |
| `PR URL` | url | 作成された PR |
| `AI最終エラー` | text | 失敗時メッセージ |
| `Dispatch ID` | text | 冪等・追跡用 |
| `タグ` | status | 人用進捗（`未着手` / `進行中` / `完了`） |

> `領域（FE / BE）` は削除済み（未使用のため）。

### リポ解決ルール

1. タスクの `GitHubリポジトリ`（select・プルダウン）
2. 未設定なら、関連プロジェクトの `GitHubリポジトリ`（フォールバック）
3. どちらも無ければ `AI失敗`

**選択肢の同期:** プロジェクトDBにリポを追加・変更したら、GAS で `syncGithubRepoSelectOptions()` を実行する（`setupAiDispatchPollTrigger` でも同期される）。

## 3. 使用ツールとそれぞれの役割

| ツール名 | 役割 | 処理内容 |
|----------|------|----------|
| Notion | 司令塔 | 本文で仕様、`AIステータス` で起動、AIメタで進捗把握 |
| Google Apps Script（`doPost`） | 中継 | Webhook受信 → 本文取得 → リポ解決 → Repository Dispatch |
| GitHub Actions | 実行 | クローンし Claude を実行 |
| Claude API（Phase 1） | 設計 | `.ai_todo.md` 生成 |
| 公式 Claude Code Action（Phase 2） | 実装 | コード修正・テスト・PR |

## 4. 中継（Google Apps Script）

実装ファイル: `github_dispatch.gs`（共通は `common.gs`）

### スクリプトプロパティ

| プロパティ | 用途 |
|------------|------|
| `NOTION_TOKEN` | タスク本文・リポ解決に使用 |
| `GITHUB_PAT` | Repository Dispatch 認証 |
| `WEBHOOK_SECRET` | Notion → GAS 簡易認証 |
| `SLACK_TOKEN` | 失敗通知（任意・既存） |

### 受信（From: Notion Automation）

```json
{
  "secret": "<WEBHOOK_SECRET>",
  "page_id": "<タスクページID>"
}
```

### GAS 内部処理

1. `secret` 検証
2. Notion でタスク取得（タイトル・AIステータス・プロジェクト relation）
3. ブロック API で本文を取得し「背景 / やること / 完了条件」を抽出
4. `GitHubリポジトリ` を解決（タスク優先 → プロジェクトフォールバック。未設定なら `AI失敗`）
5. `POST /repos/{owner}/{repo}/dispatches`（`event_type: notion-ai-task`）
6. 成功: `AIステータス=AI設計中`、`Dispatch ID` 記録 / 失敗: `AI失敗` + `AI最終エラー`

### Repository Dispatch payload（client_payload）

| キー | 内容 |
|------|------|
| `notion_page_id` | タスクページ ID |
| `title` | タスクタイトル |
| `background` / `todo` / `done_criteria` | 本文から抽出 |
| `body_markdown` | 本文生テキスト |

## 5. Notion からの起動（無料プラン）

Notion オートメーションは有料のため、**GAS の5分ポーリング**で `AIステータス=AIに依頼` を検知する。

詳細: [`docs/notion-automation-setup.md`](notion-automation-setup.md)

- 関数: `pollAiRequests` / 初期設定: `setupAiDispatchPollTrigger`
- Web App（`doPost`）は有料プラン向けの任意オプション

## 6. GitHub Actions（対象リポ）

- トリガー: `repository_dispatch` / `notion-ai-task`
- Phase 1: 設計 → `.ai_todo.md` → Notion `AI実装中`
- Phase 2: Claude Code Action → PR → Notion `PR作成済` + `PR URL`
- 失敗: `AI失敗` + `AI最終エラー`
- サンプル: [`docs/workflows/notion-ai-task.yml`](workflows/notion-ai-task.yml)

## 7. なぜこの構成か

- Notion ボード1枚で横断進捗が分かる（AIメタプロパティ）
- 本文で仕様を固定し、設計AI → `.ai_todo.md` → 実装AIで迷子を防ぐ
- ヘッドレス: `AIステータス` を変えるだけで PR まで到達する
