# GAS リモート反映（clasp）

コピペせず、ローカルの `*.gs` を Google Apps Script プロジェクトへ push する手順。

## 前提

- 既存の GAS プロジェクト（エディタで運用中のもの）がある
- Google アカウントでそのプロジェクトを編集できる
- このリポジトリの `*.gs` がそのプロジェクトのソースと対応している（1 プロジェクト想定）

## 初回セットアップ（1 回だけ）

### 1. Script ID を控える

GAS エディタ → プロジェクト設定 → **スクリプト ID**

または URL の `.../projects/<SCRIPT_ID>/edit` 部分。

### 2. `.clasp.json` を作る

```bash
cp .clasp.json.example .clasp.json
# scriptId を実際の値に書き換える
```

`.clasp.json` は gitignore 済み（チームで共有したい場合はコミットしてよいが、誤 push 先防止のため既定はローカルのみ）。

### 3. Google にログイン

```bash
npm run gas:login
```

ブラウザが開くので、GAS を編集する Google アカウントで許可する。  
認証情報は `~/.clasprc.json` に保存される（リポジトリ外）。

Dev Container 内で login しづらい場合は、**ホスト（WSL）側**で一度:

```bash
cd /path/to/this/repo
npx clasp login
```

その後、`~/.clasprc.json` をコンテナにコピーするか、`devcontainer.json` / `docker-compose.yml` に次を追加して Rebuild:

```text
source=${localEnv:HOME}/.clasprc.json,target=/home/node/.clasprc.json,type=bind
```

（ホストにファイルが無い状態でマウントするとディレクトリ扱いになり壊れるので、login 後に追加すること）

### 4. リモートのマニフェストを一度取り込む（推奨）

ローカルの `appsscript.json` は雛形です。既存プロジェクトの OAuth スコープや webapp 設定を壊さないため:

```bash
# 退避してから pull（既存 .gs を上書きしないよう注意）
npm run gas:pull
```

`appsscript.json` だけリモート版を残し、`*.gs` はリポジトリ側を正とするなら、pull 後に git で `.gs` を戻してから push する。

初めてつなぐときは、**エディタ側に未保存のコピペ差分が無いこと**を確認してから push する。

## 日常の反映

```bash
# 品質チェック → push
npm run gas:push

# エディタをブラウザで開く
npm run gas:open

# リモートの変更を取り込む（エディタで直接直したあと）
npm run gas:pull
```

`gas:push` は内部で `npm run check` のあと `clasp push` する。

## 注意

| 項目 | 内容 |
|------|------|
| スクリプトプロパティ | `NOTION_TOKEN` 等は clasp では同期されない（エディタのまま） |
| トリガー | 時間トリガーもコード外。`setupAiDispatchPollTrigger()` 等は従来どおり手動 |
| Web App デプロイ | `clasp push` はソース更新のみ。新デプロイ URL が必要ならエディタまたは `clasp deploy` |
| 上書き | push はリモートの同名ファイルを上書きする。エディタだけの未反映変更は消える |
| ファイル名 | ローカル `foo.gs` ↔ エディタ上のファイル名は拡張子なし `foo` になる |

## トラブルシュート

**`User has not enabled the Apps Script API`**  
[Apps Script API](https://script.google.com/home/usersettings) を ON にする。  
反映まで数分かかることがある。ON にしたら `npm run gas:push` を再実行。

**`Manifest file has been updated...`**  
`gas:push` は `--force` 付きなので確認なしで上書きする。リモートの `appsscript.json`（スコープ等）を守りたい場合は、先に `npm run gas:pull` でマニフェストだけ取り込む。

**ログインできない（コンテナ）**  
ホスト側で `npx clasp login` し、生成された `~/.clasprc.json` をコンテナへマウントする。

**push 先が違う**  
`.clasp.json` の `scriptId` を確認。`npm run gas:open` で意図したプロジェクトが開くか見る。
