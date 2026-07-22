# 必須対応メール監視セットアップ（GAS）

実装: [`email_alert_ingestor.gs`](../email_alert_ingestor.gs)  
仕様: [`mandatory-email-to-notion-proposal.md`](mandatory-email-to-notion-proposal.md)

## できること

- 指定メールアドレス宛の **未読** を定期取得
- Gemini で要対応判定
- 要対応・要確認のみ Notion オールタスクへ起票 + Slack DM
- 送信元の無視リスト（denylist）を手動追加可能

サービスや件名の事前登録は不要です。

## 監視間隔（クォータ余裕）

| 項目 | 値 | 理由 |
|------|-----|------|
| ポーリング | **15分ごと** | 1日96回。5分間隔より UrlFetch / Gmail / Gemini に余裕 |
| 1回あたり上限 | **最大8通** | Gemini 呼び出しと実行時間の上限対策 |

必須対応メール用途では数分〜十数分の遅れで足りる想定です。

## セットアップ手順

### 1. GAS にコードを反映

同一プロジェクトに次を置く（既存プロジェクトへ追加で可）。

- `common.gs`
- `email_alert_ingestor.gs`

### 2. スクリプトプロパティ

| キー | 必須 | 内容 |
|------|------|------|
| `EMAIL_MONITOR_ADDRESS` | **必須** | 監視するメールアドレス（例: `you@gmail.com`） |
| `EMAIL_LOOKBACK_AFTER` | 任意 | この日（YYYY-MM-DD）以降のみ監視。未設定時は `2026-07-22` |
| `NOTION_TOKEN` | 必須 | 既存 |
| `GEMINI_API_KEY` | 必須 | 既存 |
| `SLACK_TOKEN` | 必須 | 既存 |
| `EMAIL_ALERTS_ENABLED` | 任意 | `false` で停止。未設定なら有効 |
| `EMAIL_DENYLIST_JSON` | 任意 | 無視ルール（通常は自動/手動関数で更新） |

**重要:** `EMAIL_MONITOR_ADDRESS` は、その GAS を実行する Google アカウントの **本体アドレスまたはエイリアス** である必要があります。別アカウントの受信箱は、この方式では読めません（転送で寄せてください）。

コード先頭の `EMAIL_MONITOR_ADDRESS = ''` に直書きしても動きますが、**プロパティ設定を推奨**します（プロパティ優先）。

### 3. 権限とトリガー

1. 関数 `testEmailAlertIngest` を一度実行し、Gmail / Notion / Slack / Gemini の権限を許可  
2. 関数 `setupEmailAlertTrigger` を実行（15分ごとの `pollEmailAlerts` が登録される）  
3. トリガー一覧に `pollEmailAlerts` / 15分 があることを確認  

停止するとき: `removeEmailAlertTrigger` を実行するか、`EMAIL_ALERTS_ENABLED=false` を設定。

#### 「未検証のアプリ」警告が出る場合（よくある）

`testEmailAlertIngest` 実行時にブラウザで **「このアプリは Google で確認されていません」** のような警告が出ることがあります。  
これは外部の怪しいサイトではなく、**自分の GAS プロジェクトが OAuth 検証済みアプリとして登録されていない**ときの Google 標準表示です（個人用・社内用スクリプトでは普通に出ます）。

進み方:

1. 「詳細」または **Advanced** を開く  
2. **「（プロジェクト名）に移動」** / **Go to … (unsafe)** を選ぶ  
3. 要求されている権限（Gmail・外部接続など）を確認して **許可**  

確認ポイント:

- 表示されている Google アカウントが、監視したい Gmail のアカウントであること  
- 遷移先ドメインが `accounts.google.com` / `script.google.com` であること  

Notion・Slack・Gemini への通信は、許可後に GAS サーバー側の `UrlFetchApp` で行われるため、この警告画面の原因ではありません。

### 4. 動作確認

1. 監視アドレス宛にテストメールを送る（または既存未読を残す）  
2. `testEmailAlertIngest` を実行  
3. 期待:
   - 要対応なら Notion に未着手タスクが作成される  
   - Slack DM に通知が来る  
   - Gmail にラベル `email-ingestor/done` が付き既読になる  
   - ニュースレター等はタスク化されず処理済になることがある  

## プロジェクト分類

起票時、`[DB]プロジェクト管理` の **未着手 / 進行中** を毎回取得し、Gemini がメール内容から候補を選びます。  
プロジェクトの追加・改名・完了はコード変更なしで次回ポーリングに反映されます。

| 判定結果 | 動作 |
|----------|------|
| Maruya / Takakyu 等に自信を持ってマッチ | そのプロジェクトの relation を設定 |
| いずれでもない / 自信が低い / 不明 | **`Jackson office project` にデフォルト紐付け**（未分類扱い） |

Slack / タスク本文には `Jackson office project（デフォルト・未分類）` と明示するので、後から付け替えやすいです。  
デフォルト名は定数 `EMAIL_DEFAULT_PROJECT_NAME` で変更できます。

## Slack 操作（無視 / コメント）

エージェントアプリでは **スレッド返信や通常メッセージが使えない** ことがあるため、通知に付く **ボタン操作** を主系統にしています。

| 操作 | 動作 |
|------|------|
| **送信元を無視** ボタン | 通知の送信元を denylist に追加 |
| **Notionでコメント** ボタン | Notion タスクをブラウザで開く（そこでコメント） |

> `views:open` は現行 Slack の Bot Token Scopes 一覧に出ないことがあり、追加不要です（モーダル用 API は特別な scope なし）。  
> エージェントアプリ向けに、コメントはモーダルではなく **Notion URL ボタン** にしています。

### 追加セットアップ（ボタン用）

1. GAS を最新コードで **新バージョンデプロイ**
2. Slack App の **Interactivity & Shortcuts** を ON
   - Request URL: ウェブアプリと同じ URL（「送信元を無視」用）
3. 反映ファイル: `common.gs` / `email_alert_ingestor.gs` / `github_dispatch.gs`

> Slack が「アプリに接続できません」と出す場合、GAS が独自 JSON を返しているか、デプロイが古いことが多いです。  
> Interactivity への応答は **空ボディ** である必要があります（修正済み）。必ず新バージョンデプロイしてください。

### エージェントアプリでボタンも動かない場合

Slack 側の制約が強いときは次で代替できます。

| やりたいこと | 代替 |
|--------------|------|
| コメント | Notion タスク上で直接コメント |
| 送信元無視 | GAS で `addEmailDenylist('addr-or-domain')` を実行 |

### 動作確認

1. `testEmailAlertIngest` で通知を出す  
2. **送信元を無視** を押す → denylist 追加の確認が出る  
3. **コメント追加** を押す → モーダル入力 → Notion にコメントが付く  

## 誤検知を減らす（denylist）

スレッドで `無視` と返す方法が簡単です。手動でも可:

```javascript
addEmailDenylist('newsletter.example.com')
// または
addEmailDenylist('promo@example.com')
```

## 取得クエリ（参考）

```
is:unread -category:promotions -category:social -label:email-ingestor/done
(to:監視アドレス OR deliveredto:監視アドレス OR cc:監視アドレス)
```

## トラブルシュート

| 症状 | 確認 |
|------|------|
| 監視アドレスエラー | `EMAIL_MONITOR_ADDRESS` が実行アカウント / エイリアスと一致しているか |
| 何も拾わない | 未読か / Promotions に入っていないか / すでに `email-ingestor/done` か |
| Notion 作成失敗 | `NOTION_TOKEN` とオールタスク DB への接続 |
| Gemini エラー | `GEMINI_API_KEY` と無料枠 |
| スレッド返信が無反応 | Web App デプロイ済みか / Event Subscriptions の `message.im` / 最新デプロイ URL か |
| 止めたい | `EMAIL_ALERTS_ENABLED=false` またはトリガー削除 |
