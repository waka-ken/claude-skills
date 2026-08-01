# AI依頼の起動方法（Notion 無料プラン対応）

Notion の **オートメーションは有料プラン向け**のため、無料プランでは使えません。  
代わりに **GAS が「AIステータス = AIに依頼」を定期ポーリング**して GitHub へ Dispatch します。

## あなたがやること（これだけ）

### 1. 最新の `github_dispatch.gs` を GAS に反映

リポジトリの [`github_dispatch.gs`](../github_dispatch.gs) を開き直し、全文を GAS に貼り直す。

### 2. スクリプトプロパティ（ポーリングに必要なもの）

| キー | 必須 |
|------|------|
| `NOTION_TOKEN` | 必須 |
| `GITHUB_PAT` | 必須 |
| `SLACK_TOKEN` | 推奨（開始/失敗の DM 通知。無いと Slack 通知のみスキップ） |
| `WEBHOOK_SECRET` | **不要**（ポーリングだけなら） |

### 3. トリガーを一度だけ設定

GAS エディタで:

1. 関数セレクトで **`setupAiDispatchPollTrigger`** を選ぶ  
2. **実行**  
3. 権限を求められたら許可  
4. ログに「5分ごとに設定しました」と出れば OK  

（確認: 左メニュー **トリガー** に `pollAiRequests` / 5分ごと があること）

### 4. 動作確認

1. オールタスクでテストタスクを用意  
2. 本文（背景 / やること / 完了条件）を書く  
3. **`GitHubリポジトリ`** をプルダウンから選ぶ（推奨）  
   - 選択肢はプロジェクト管理のリポを `syncGithubRepoSelectOptions` で同期  
   - 空なら関連プロジェクトの `GitHubリポジトリ` にフォールバック（**単一リポのときのみ**）  
   - プロジェクトに複数リポがある場合は、必ずタスク側で1つ選ぶ（未選択だと `AI失敗`）  
4. **`AIステータス` = `AIに依頼`** にする  
5. すぐ試すなら関数 **`testPollAiRequests`** を手動実行  
   （待ってもよい。最大約5分で自動実行）  
6. 期待:
   - `AIステータス` → `AI設計中`
   - `Dispatch ID` が入る
   - Notion コメント「AI依頼を受け付けました」
   - Slack DM「AI依頼を開始」（`SLACK_TOKEN` 設定時）

---

## 運用イメージ

```
Notion で AIステータス = AIに依頼
        ↓（最大5分）
GAS pollAiRequests
        ↓ Slack「開始」+ Notionコメント
GitHub repository_dispatch (notion-ai-task)
        ↓
Actions: 設計 → 実装 → PR
        ↓ Slack「完了/失敗」+ Notionコメント（対応サマリー）
Notion: AIステータス / PR URL 更新
```

Web App デプロイや Notion Automation は **不要**です。

---

## 有料プランに上げた場合（任意）

オートメーションが使えるようになったら、従来どおり `doPost` + Web App でも起動できます。  
ポーリングと併用すると二重起動の恐れがあるので、どちらか一方にしてください。  
（`processAiDispatch_` に冪等チェックはあるが、基本は片方のみ推奨）

---

## トラブルシュート

| 症状 | 確認 |
|------|------|
| 何も起きない | トリガーがあるか / `AIステータス` が正確に `AIに依頼` か |
| プロジェクト未設定 | relation があるか |
| リポ未設定 | タスク（優先）またはプロジェクトの `GitHubリポジトリ`（`owner/repo`） |
| `GitHub Dispatch failed (404)` | プロジェクトにカンマ区切り複数リポがあり、タスク側未選択の可能性大。タスクで1つ選ぶ |
| 複数リポエラー | タスクの「GitHubリポジトリ」で PR 先を明示選択 |
| `重複スキップ:` | 同一リポで類似タイトル／同一 Message-ID のタスクが既に実行中（または同ポーリングで先に通った）。意図的なスキップ。勝者タスクの URL がコメントに付く |
| Dispatch 失敗 | `GITHUB_PAT` の権限（`repo` / `workflow`） |
