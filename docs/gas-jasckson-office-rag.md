# Notion → GitHub Actions（notion-ai-task）GAS 連携設計

**状態**: GAS 反映済み（Actions 側 PR #43 と合わせて運用）
**日付**: 2026-08-04
**読者**: Notion ポーリング用 Google Apps Script（GAS）メンテ担当、core-rag CI メンテ
**関連**:
- ワークフロー本体: [`.github/workflows/notion-ai-task.yml`](../.github/workflows/notion-ai-task.yml)
- Notion DB: `[DB]オールタスク管理`（プロパティ `AIステータス` / `Dispatch ID` / `GitHubリポジトリ` 等）
- タスク雛形: Notion「【テンプレート】AI開発タスク」

---

## 1. 目的

GAS と GitHub Actions の **契約（トリガー条件・payload・ステータス遷移）** を固定する。  
2026-08 以降、Actions は **設計ジョブと実装ジョブを排他実行**する。GAS は `task_kind` を送り、1 タスク = 1 種類の実行に揃える。

## 2. スコープ / 非スコープ

### 対象

- Notion `[DB]オールタスク管理` をポーリングし、`AIに依頼` を検出して `repository_dispatch` を打つ GAS
- `client_payload` の必須・推奨フィールド
- `Dispatch ID` の発行・再利用（resume）
- タイトル命名（`（設計）` / `（実装）`）との整合

### 対象外

- Claude / Docker / salvage 等の Actions 内部実装（ワークフローが正）
- Notion DB スキーマの新規プロパティ追加（現状はタイトル + payload で足りる。将来 `AI種別` select を足す場合は改訂）
- リポジトリごとの secrets（`CLAUDE_CODE_OAUTH_TOKEN` 等）

---

## 3. 全体アーキテクチャ

```text
Notion (AIステータス = AIに依頼)
    │  定期ポーリング
    ▼
GAS
    │  1. task_kind 解決（design | implement）
    │  2. dispatch_id 決定（既存があれば再利用、無ければ新規 UUID）
    │  3. Notion を AI設計中 + Dispatch ID 書き込み + 受付コメント
    │  4. GitHub repository_dispatch
    ▼
GitHub Actions  workflow: notion-ai-task.yml
    │  resolve → design XOR implement
    ▼
Notion 書き戻し（Actions が実施）
    AI設計中 / AI実装中相当の経過 → PR作成済 or AI失敗
```

**重要**: 1 回の `repository_dispatch` で設計と実装の両方は走らない。  
設計完了後に実装したい場合は、**別 Notion タスク**（タイトルに `（実装）`）を `AIに依頼` にする。

---

## 4. Notion 側の前提

### 4.1 監視対象プロパティ

| プロパティ | 用途（GAS） |
|---|---|
| `AIステータス` | トリガー。値が **`AIに依頼`** のページだけ dispatch |
| `GitHubリポジトリ` | dispatch 先リポ（例: `waka-ken/core-RAG`） |
| `Dispatch ID` | ブランチ名 `ai/notion-<先頭8桁>` に使う。**再実行時は既存値を再利用** |
| `プロジェクト名`（title） | payload `title`。`（設計）` / `（実装）` を含める |
| `PR URL` / `AI最終エラー` | GAS は原則触らない（Actions が更新） |

### 4.2 本文パース（従来どおり）

ページ本文から次を抽出して payload に載せる（見出し名はテンプレート準拠）。

| 見出し | payload キー |
|---|---|
| `## 背景` | `background` |
| `## やること` | `todo` |
| `## 完了条件` | `done_criteria` |
| ページ本文全体（Markdown） | `body_markdown` |

### 4.3 タスク命名規約（運用必須）

| 種類 | タイトル例 | Actions の動き |
|---|---|---|
| 設計 | `Maruya … CX7: …（設計）` | Design only ジョブ |
| 実装 | `Maruya … CX7: …（実装）` | Implement only ジョブ |

許容サフィックス（Actions 側フォールバック）: `（設計）` / `(設計)` / `【設計】`、および実装側同様。

**禁止**: サフィックス無しの「設計も実装もやる」1 タスク。Actions の `resolve` が失敗する。

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
    "title": "Maruya チャットUX CX7: 履歴のサーバー同期（実装）",
    "background": "…",
    "todo": "…",
    "done_criteria": "…",
    "body_markdown": "## 背景\n…\n## やること\n…\n## 完了条件\n…",
    "dispatch_id": "0b9df224-22e6-4e93-9833-13aeb2469539",
    "task_kind": "implement"
  }
}
```

### 5.3 `client_payload` フィールド定義

| キー | 必須 | 説明 |
|---|---|---|
| `notion_page_id` | ✅ | Notion page UUID（ハイフン有無どちらでも可。Actions はハイフン付き想定で問題なし） |
| `title` | ✅ | タスクタイトル |
| `background` | ✅ | 背景テキスト（空文字可だがキーは送る） |
| `todo` | ✅ | やること |
| `done_criteria` | ✅ | 完了条件 |
| `body_markdown` | ✅ | 本文 Markdown |
| `dispatch_id` | ✅ | UUID 文字列。ブランチ `ai/notion-<先頭8桁>` |
| `task_kind` | **推奨（実質必須）** | `"design"` または `"implement"` のみ |

`task_kind` を省略した場合、Actions はタイトルから推定する。推定不可なら **ジョブ失敗**（GAS 起因の「動いたつもり」を防ぐため、GAS 側で必ず付けること）。

### 5.4 `task_kind` 解決ロジック（GAS 実装指示）

優先順位:

1. タイトルに `（設計）` 等 → `"design"`
2. タイトルに `（実装）` 等 → `"implement"`
3. どちらも無い → **dispatch せず** Notion にコメント（または `AI失敗` + `AI最終エラー`）で「タイトルに（設計）か（実装）を付けて再依頼」と返す

将来 Notion に `AI種別` select を足す場合は、それを最優先にしてよい（そのとき本節を改訂）。

---

## 6. `Dispatch ID` と resume

Actions は `dispatch_id` の先頭 8 文字でブランチ `ai/notion-XXXXXXXX` を決める。  
**同一 ID の再 dispatch = 同一ブランチの続き（WIP resume）**。

| 状況 | GAS の振る舞い |
|---|---|
| 初回（`Dispatch ID` 空） | `Utilities.getUuid()` 等で新規発行 → Notion に保存 → その値で dispatch |
| `AI失敗` → 再たび `AIに依頼` | **既存 `Dispatch ID` を再利用**（新規発行しない） |
| 設計タスクと実装タスク | **別ページなので別 `Dispatch ID`**（設計ブランチを実装が勝手に継がない） |

実装タスクが設計 PR の成果物を使う場合は、Notion 本文や checklist でパスを指す。ブランチ共有は必須にしない。

---

## 7. GAS が Notion に書くタイミング

dispatch **直前**（成功前提で楽観更新してよい）:

1. `AIステータス` → `AI設計中`  
   （実装タスクでも「受付直後」は従来どおり `AI設計中` でよい。Actions 側が設計/実装ジョブに振り分ける）
2. `Dispatch ID` → 今回使う UUID（新規 or 再利用）
3. ページコメント例:

```text
🚀 AI依頼を受け付けました
リポジトリ: waka-ken/core-RAG
Dispatch ID: <uuid>
task_kind: design|implement
ステータス: AI設計中
次の工程: Actions が design XOR implement を実行 → Draft PR
```

**書かない / 上書きしない（Actions 担当）**:

- `PR URL`（成功時 Actions が設定）
- `AI最終エラー`（失敗時 Actions が設定。再依頼時は GAS がクリアしてよい）
- `AIステータス` の `PR作成済` / `AI失敗` への遷移（Actions）

再依頼時の推奨:

- `AI最終エラー` を空にする
- `AIステータス` を `AIに依頼` にしたあと、ポーリングで拾って上記 1–3 + dispatch

---

## 8. Actions 側の振る舞い（GAS が知っておくべき結果）

| `task_kind` | 実行ジョブ | 成功時 Notion | 失敗時 |
|---|---|---|---|
| `design` | Design only（docs + Draft PR） | `PR作成済` + `PR URL` | `AI失敗` + `AI最終エラー`（WIP PR 保全の場合あり） |
| `implement` | Implement only（コード + Draft PR） | 同上 | 同上 |

`resolve` 失敗（kind 不明）も `AI失敗` にはならず Actions ログ上で落ちるだけ、になり得る。  
→ GAS 側で kind を必ず確定させてから dispatch すること。

---

## 9. GAS 改修チェックリスト（指示書）

既存ポーリング関数に対する差分だけ列挙する。

- [x] `event_type` は従来どおり `notion-ai-task`
- [x] `client_payload` に **`task_kind`: `"design"` | `"implement"`** を追加
- [x] タイトルから `task_kind` を解決。解決不能なら **dispatch しない**（コメントで理由）
- [x] `Dispatch ID` が空のときだけ新規 UUID。再依頼は既存を再利用
- [x] 受付時コメントに `task_kind` を含める
- [x] 再依頼時に `AI最終エラー` をクリア
- [x] （任意）タイトルに `（設計）`/`（実装）` が無いページを週次で検知するヘルスチェック

### 疑似コード（参考）

```javascript
function resolveTaskKind_(title) {
  if (/（設計）|\(設計\)|【設計】/.test(title)) return 'design';
  if (/（実装）|\(実装\)|【実装】/.test(title)) return 'implement';
  return null;
}

function acceptAiRequest_(page) {
  const kind = resolveTaskKind_(page.title);
  if (!kind) {
    comment_(page.id, '⚠️ タイトルに（設計）か（実装）を付けてから AIに依頼してください。');
    return;
  }
  let dispatchId = page.props['Dispatch ID'];
  if (!dispatchId) {
    dispatchId = Utilities.getUuid();
    patchNotion_(page.id, { 'Dispatch ID': dispatchId, 'AIステータス': 'AI設計中', 'AI最終エラー': '' });
  } else {
    patchNotion_(page.id, { 'AIステータス': 'AI設計中', 'AI最終エラー': '' });
  }
  comment_(page.id, `🚀 AI依頼受付\nDispatch ID: ${dispatchId}\ntask_kind: ${kind}`);
  githubDispatch_(page.repo, {
    event_type: 'notion-ai-task',
    client_payload: {
      notion_page_id: page.id,
      title: page.title,
      background: page.background,
      todo: page.todo,
      done_criteria: page.doneCriteria,
      body_markdown: page.bodyMarkdown,
      dispatch_id: dispatchId,
      task_kind: kind,
    },
  });
}
```

---

## 10. 互換・移行

| 時期 | 振る舞い |
|---|---|
| Actions #43 マージ前 | 旧: 1 dispatch で設計 Todo → 実装まで連続 |
| Actions #43 マージ後 + GAS 未改修 | タイトルに `（設計）`/`（実装）` があれば動く。無ければ Actions 失敗 |
| GAS 改修後 | `task_kind` 明示。命名ミスは GAS で弾ける |

既存の進行中タスクは、タイトルを `（設計）`/`（実装）` に直し、必要ならタスクを分割する。

---

## 11. 検証手順（GAS 担当）

1. Notion に設計タスク（タイトル末尾 `（設計）`）を作り `AIに依頼`
2. GAS 実行 → Actions で **Design only** のみが走り Implement が skip
3. 同様に実装タスク（`（実装）`）で **Implement only** のみ
4. `AI失敗` の実装タスクを `AIに依頼` に戻し、**同じ Dispatch ID** で resume されること
5. サフィックス無しタイトルは GAS が dispatch せずコメントすること

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-08-04 | 初版。設計/実装排他・`task_kind`・Dispatch 再利用を GAS 契約として固定 |
| 2026-08-04 | GAS `github_dispatch.gs` に反映（task_kind / Dispatch 再利用 / ヘルスチェック） |
