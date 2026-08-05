# Notion → GitHub Actions（notion-ai-task）GAS 連携設計

**状態**: GAS 反映済み（Actions 側: 内容判定 + 設計→実装連結）
**日付**: 2026-08-04
**読者**: Notion ポーリング用 Google Apps Script（GAS）メンテ担当、core-rag CI メンテ
**関連**:
- ワークフロー本体: [`.github/workflows/notion-ai-task.yml`](../.github/workflows/notion-ai-task.yml)
- Notion DB: `[DB]オールタスク管理`（プロパティ `AIステータス` / `Dispatch ID` / `GitHubリポジトリ` 等）
- タスク雛形: Notion「【テンプレート】AI開発タスク」

---

## 1. 目的

GAS と GitHub Actions の **契約（トリガー条件・payload・ステータス遷移）** を固定する。

2026-08 以降の方針:

- タイトルに `（設計）` / `（実装）` を付ける必要は **ない**
- Actions の `resolve` が Notion 本文と既存 docs を見て **設計要否・実装要否を AI 判定**する
- 設計が無ければ **同一 Dispatch で設計ジョブ → 実装ジョブを連続実行**する
- ターン溢れ対策として、設計と実装は **別ジョブ・別 max-turns**（1 プロセスに両方を詰め込まない）

## 2. スコープ / 非スコープ

### 対象

- Notion `[DB]オールタスク管理` をポーリングし、`AIに依頼` を検出して `repository_dispatch` を打つ GAS
- `client_payload` の必須・推奨フィールド
- `Dispatch ID` の発行・再利用（resume）

### 対象外

- Claude / Docker / salvage 等の Actions 内部実装（ワークフローが正）
- Notion DB スキーマの新規プロパティ追加（現状は本文 + payload で足りる）
- リポジトリごとの secrets（`CLAUDE_CODE_OAUTH_TOKEN` 等）

---

## 3. 全体アーキテクチャ

```text
Notion (AIステータス = AIに依頼)
    │  定期ポーリング
    ▼
GAS
    │  1. dispatch_id 決定（既存があれば再利用、無ければ新規 UUID）
    │  2. Notion を AI設計中 + Dispatch ID 書き込み + 受付コメント
    │  3. GitHub repository_dispatch（task_kind は任意）
    ▼
GitHub Actions  workflow: notion-ai-task.yml
    │  resolve（AI assess）→ run_design / run_implement
    │  design（必要時, max-turns 60）
    │  implement（必要時, max-turns 100）※ design 成功 or skip 後
    ▼
Notion 書き戻し（Actions が実施）
    設計のみ / 実装のみ / 設計→実装 → PR作成済 or AI失敗（WIP 保全あり）
```

**ターン溢れ対策**: 設計と実装は別ジョブでターン予算を分離する。途中失敗時は salvage で WIP Draft PR を残し、同一 `Dispatch ID` 再実行で resume できる。

---

## 4. Notion 側の前提

### 4.1 監視対象プロパティ

| プロパティ | 用途（GAS） |
|---|---|
| `AIステータス` | トリガー。値が **`AIに依頼`** のページだけ dispatch |
| `GitHubリポジトリ` | dispatch 先リポ（例: `waka-ken/core-RAG`） |
| `Dispatch ID` | ブランチ名 `ai/notion-<先頭8桁>` に使う。**再実行時は既存値を再利用** |
| `プロジェクト名`（title） | payload `title`。サフィックス不要 |
| `PR URL` / `AI最終エラー` | GAS は原則触らない（Actions が更新） |

### 4.2 本文パース（従来どおり）

ページ本文から次を抽出して payload に載せる（見出し名はテンプレート準拠）。

| 見出し | payload キー |
|---|---|
| `## 背景` | `background` |
| `## やること` | `todo` |
| `## 完了条件` | `done_criteria` |
| ページ本文全体（Markdown） | `body_markdown` |

### 4.3 タスク命名

タイトルへの `（設計）` / `（実装）` 付与は **任意・非必須**。Actions はタイトルではなく本文と既存 docs で判定する。

人間が明示したい場合のみ、任意で `client_payload.task_kind` を送ってよい（§5.3）。

---

## 5. GitHub `repository_dispatch` 契約

### 5.1 エンドポイント

```http
POST https://api.github.com/repos/{owner}/{repo}/dispatches
Accept: application/vnd.github+json
Authorization: Bearer <GITHUB_PAT>
```

- `{owner}/{repo}` = Notion の `GitHubリポジトリ` プロパティ値
- PAT 権限: `repo`（`actions` で dispatch 可能なこと）

### 5.2 Body（必須）

```json
{
  "event_type": "notion-ai-task",
  "client_payload": {
    "notion_page_id": "3afdb617-4b67-81a8-bba9-e1011424312b",
    "title": "Maruya チャットUX CX9: スレッドのリネーム",
    "background": "…",
    "todo": "…",
    "done_criteria": "…",
    "body_markdown": "## 背景\n…\n## やること\n…\n## 完了条件\n…",
    "dispatch_id": "0b9df224-22e6-4e93-9833-13aeb2469539"
  }
}
```

### 5.3 `client_payload` フィールド定義

| キー | 必須 | 説明 |
|---|---|---|
| `notion_page_id` | ✅ | Notion page UUID |
| `title` | ✅ | タスクタイトル（サフィックス不要） |
| `background` | ✅ | 背景テキスト（空文字可だがキーは送る） |
| `todo` | ✅ | やること |
| `done_criteria` | ✅ | 完了条件 |
| `body_markdown` | ✅ | 本文 Markdown |
| `dispatch_id` | ✅ | UUID 文字列。ブランチ `ai/notion-<先頭8桁>` |
| `task_kind` | 任意 | `"design"` / `"implement"` / `"both"` のみ。**未送信なら AI が判定** |

### 5.4 Actions 側の判定（GAS は触らない）

優先順位:

1. `task_kind` が明示されていればそれを使う（override）
2. それ以外は resolve ジョブが Claude で `run_design` / `run_implement` を判定
3. assess 失敗時はフォールバックで `run_design=true` + `run_implement=true`

判定の目安（Actions プロンプトに固定）:

- 該当設計 doc / checklist の確定設計が無い → 設計を走らせる
- コード変更が完了条件に含まれる → 実装を走らせる
- 小変更で既存設計が十分 → 実装のみ

---

## 6. `Dispatch ID` と resume

Actions は `dispatch_id` の先頭 8 文字でブランチ `ai/notion-XXXXXXXX` を決める。  
**同一 ID の再 dispatch = 同一ブランチの続き（WIP resume）**。

| 状況 | GAS の振る舞い |
|---|---|
| 初回（`Dispatch ID` 空） | 新規 UUID を発行 → Notion に保存 → その値で dispatch |
| `AI失敗` → 再たび `AIに依頼` | **既存 `Dispatch ID` を再利用**（新規発行しない） |

設計→実装の連続実行も同一ブランチ上で行う。

---

## 7. GAS が Notion に書くタイミング

dispatch **直前**（成功前提で楽観更新してよい）:

1. `AIステータス` → `AI設計中`
2. `Dispatch ID` → 今回使う UUID（新規 or 再利用）
3. ページコメント例:

```text
🚀 AI依頼を受け付けました
リポジトリ: waka-ken/core-RAG
Dispatch ID: <uuid>
ステータス: AI設計中
次の工程: Actions が内容判定 → 必要なら設計 → 必要なら実装 → Draft PR
```

**書かない / 上書きしない（Actions 担当）**:

- `PR URL`（成功時 Actions が設定）
- `AI最終エラー`（失敗時 Actions が設定。再依頼時は GAS がクリアしてよい）
- `AIステータス` の `PR作成済` / `AI失敗` / `AI実装中` への遷移（Actions）

再依頼時の推奨:

- `AI最終エラー` を空にする
- `AIステータス` を `AIに依頼` にしたあと、ポーリングで拾って上記 1–3 + dispatch

---

## 8. Actions 側の振る舞い（GAS が知っておくべき結果）

| 判定結果 | 実行ジョブ | 成功時 Notion |
|---|---|---|
| 設計のみ | Design | `PR作成済` + `PR URL` |
| 実装のみ | Implement | `PR作成済` + `PR URL` |
| 設計→実装 | Design → Implement | 設計完了時は `AI実装中`（仮 PR URL 可）。最終成功時に `PR作成済` |
| 失敗 | salvage で WIP 保全の場合あり | `AI失敗` + `AI最終エラー` |

ターン上限で中断しても WIP Draft PR が残る場合は、同一 `Dispatch ID` で再依頼すれば続きから再開できる。

---

## 9. GAS 改修チェックリスト（指示書）

- [x] `event_type` は従来どおり `notion-ai-task`
- [x] タイトルに `（設計）` / `（実装）` が無くても **dispatch する**
- [x] `task_kind` は送らなくてよい（明示 override したいときだけ `design` / `implement` / `both`）
- [x] `Dispatch ID` が空のときだけ新規 UUID。再依頼は既存を再利用
- [x] 再依頼時に `AI最終エラー` をクリア
- [x] 受付コメントに「内容判定 → 設計/実装」の旨を含めてよい

### 疑似コード（参考）

```javascript
function acceptAiRequest_(page) {
  let dispatchId = page.props['Dispatch ID'];
  if (!dispatchId) {
    dispatchId = Utilities.getUuid();
    patchNotion_(page.id, { 'Dispatch ID': dispatchId, 'AIステータス': 'AI設計中', 'AI最終エラー': '' });
  } else {
    patchNotion_(page.id, { 'AIステータス': 'AI設計中', 'AI最終エラー': '' });
  }
  comment_(page.id, `🚀 AI依頼受付\nDispatch ID: ${dispatchId}\n次: Actions が内容判定し設計/実装を実行`);
  const payload = {
    notion_page_id: page.id,
    title: page.title,
    background: page.background,
    todo: page.todo,
    done_criteria: page.doneCriteria,
    body_markdown: page.bodyMarkdown,
    dispatch_id: dispatchId,
  };
  // 任意: payload.task_kind = 'both'; // 明示 override したいときだけ
  githubDispatch_(page.repo, {
    event_type: 'notion-ai-task',
    client_payload: payload,
  });
}
```

---

## 10. 互換・移行

| 時期 | 振る舞い |
|---|---|
| 旧（設計/実装排他 + タイトル必須） | サフィックス無しは resolve 失敗 |
| 本改訂後 | サフィックス無しでも AI 判定。必要なら設計→実装を連続実行 |
| `task_kind` を送り続ける GAS | 引き続き override として有効（破壊的ではない） |

main に `.ai_todo.md` を残さない（作業ブランチ専用）。残骸があると実装 Todo の誤再利用の原因になる。

---

## 11. 検証手順（GAS / Actions）

1. サフィックス無しの小タスクを `AIに依頼` → implement のみ（または assess 結果どおり）が走る
2. 設計未着手の大きめタスク → design → implement が同一 run / 同一ブランチで連続
3. `AI失敗` のタスクを同一 Dispatch ID で再依頼 → resume
4. （任意）`task_kind=design` を明示送信 → 設計のみ

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-08-04 | GAS を改訂方針に追従（task_kind 未送信・タイトルゲート廃止） |
| 2026-08-04 | 内容判定 + 設計→実装連結。タイトルサフィックス / task_kind 必須を廃止 |
| 2026-08-04 | 初版。設計/実装排他・`task_kind`・Dispatch 再利用を GAS 契約として固定 |
