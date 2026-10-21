# GAS 自動反映（main マージ → Apps Script）

main に `*.gs` の変更がマージされると、GitHub Actions（[`.github/workflows/gas-deploy.yml`](../.github/workflows/gas-deploy.yml)）が
[clasp](https://github.com/google/clasp) で Apps Script プロジェクトへ反映する。GAS エディタへの貼り直しは不要。

## 何が起きるか

1. `npm run check`（lint / format）。失敗したら反映しない
2. リモートの `appsscript.json`（マニフェスト）を取得し、リポの `*.gs` と合わせて `clasp push`
3. `GAS_WEBAPP_DEPLOYMENT_ID` があれば新バージョンを作り、Web App のデプロイに割り当てる（URL は変わらない）

時間トリガー（`pollAiRequests` など）は常に最新コードで動くため、2 の時点で反映される。
Web App（Slack の doPost など）はバージョン固定のため 3 が必要。

**GAS 側にリポに無い変更があると止まる**（ずれ検知）。`clasp push` は GAS 側を丸ごと置き換えるため、
GAS エディタで直接直した内容を古いリポの内容で巻き戻さないよう、GAS 側が「マージ前の main」か「今回のコミット」と
一致するときだけ反映する。GAS エディタで直接編集した場合は、その内容をリポに取り込んでからマージする。

## 初回設定（1 回だけ）

### 1. Apps Script API を有効にする

https://script.google.com/home/usersettings で「Google Apps Script API」をオンにする（GAS を実行している Google アカウントで）。

### 2. clasp でログインする

コンテナ内のターミナルで実行する（ブラウザで Google 認証。VS Code / Cursor が localhost のポートを自動転送する）。

```bash
npx @google/clasp@2.4.2 login
```

`~/.clasprc.json` が作られる。版を変えると形式が変わり CI で読めなくなるため、`2.4.2` のまま使う。

### 3. GitHub に登録する

```bash
# 認証情報（中身は表示しない）
gh secret set CLASPRC_JSON < ~/.clasprc.json

# GAS エディタ →「プロジェクトの設定」→「スクリプト ID」
gh variable set GAS_SCRIPT_ID --body '<スクリプト ID>'

# （Web App を使っている場合）「デプロイ」→「デプロイを管理」→ ウェブアプリのデプロイ ID（AKfy... で始まる）
gh variable set GAS_WEBAPP_DEPLOYMENT_ID --body '<デプロイ ID>'
```

登録後は `~/.clasprc.json` を残しておく必要はない（ローカルで clasp を使わないなら削除してよい）。

### 4. 動作確認

```bash
gh workflow run gas-deploy.yml
gh run watch
```

成功したら GAS エディタで内容が更新されていることを確認する。

## 再設定が必要になるとき

| 症状 | 対応 |
|------|------|
| `invalid_grant` などの認証エラー | Google アカウントのパスワード変更・アクセス取り消しでトークンが無効化された。2〜3 をやり直す |
| `User has not enabled the Apps Script API` | 1 を実施 |
| `リモートにリポに無い変更があります` | GAS 側の内容を `clasp pull` でリポに取り込む PR を出す。GAS 側を捨ててよい場合は手動実行で `skip_drift_check` をオンにする |

`CLASPRC_JSON` は Google アカウントで Apps Script を操作できる認証情報。リポの secret 以外に置かない。
