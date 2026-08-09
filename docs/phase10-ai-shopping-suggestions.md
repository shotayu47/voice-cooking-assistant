# PHASE 10 — AI 買い物候補提案

**Status: 実装済み。実機 QA 未実施。migration なし。**

AI が不足食材を提案し、**ユーザーが選んだものだけ**が買い物リストに入る。

---

## 1. 中核の設計判断：提案と確定を分ける

**AI は買い物リストに書き込めない。** ツールは読み取り専用で、`shopping_items` へ
INSERT する経路を持たない。

```
AI: suggest_shopping_items（読み取りのみ）
      ↓ 候補を返す
UI: チャット内のカード。初期チェックは全部 OFF
      ↓ ユーザーがチェックして「追加」を押す
Server Action: addSuggestedShoppingItemsAction（冪等ガード付き）
      ↓ 選ばれた分だけ
createShoppingItem（PHASE 9 のまま）
```

提案が勝手に materialize すると、アプリが利用者の代わりに買い物を決めることになる。
確定は必ず人の操作を経る。

---

## 2. サーバー権威：モデルから受け取るのは ID だけ

初期案ではモデルに候補オブジェクト（料理名と材料の配列）を渡させようとしていた。
**これは撤回した。** 材料名をモデルが自己申告できると、在庫に無い物を「不足」として
でっち上げる余地が残る。

現在の入力は 2 つだけ:

| 引数 | 内容 |
| --- | --- |
| `recipe_ids` | **`create_recipe` がサーバー発行した UUID**。最大 5 件 |
| `include_staples` | 調味料を含めるか（既定 false） |

食材名・不足理由・数量はすべて DB とサーバー関数が決める。

| 項目 | 確定方法 | モデルの関与 |
| --- | --- | --- |
| 食材名 | `recipes.ingredients[].name` | なし |
| 不足理由 | `resolveInventoryItem` → `absent` / `out_of_stock` / `expired` | なし |
| 数量・単位 | `recipes.ingredients[].amount` / `.unit` | なし |
| 調味料判定 | `isStapleSeasoning` | なし |
| 既存リスト判定 | `findDuplicates`（`shoppingKey` 経由） | なし |

`recipe_ids` は `normalizeRecipeIds` で **UUID 検証・重複除去・5 件上限**を通す。
`getRecipe` が `.eq('user_id', ctx.userId)` を明示し RLS も掛かるので、
**他人のレシピ ID を渡しても候補は返らない**（`recipes_not_found`）。

不足判定は既存の `evaluateCandidate` に委ねている。「同じ食材」の 2 つ目の定義を
作らないという PHASE 9 の投資がここで効いている。

### 購入理由に使わないもの

**`listExpiringSoon` は使わない。** 「期限が近い」は在庫がある状態であり、
買い足す理由にならない。対象は `absent` / `out_of_stock` / `expired` の 3 つだけ
（`expired` は `evaluateCandidate` が在庫行から導く）。

### 任意食材

`required: false` の材料は提案しない。PHASE 3 が「あれば良い程度」と決めたものを
買い物リストに載せると、頼まれていない用事が増える。

---

## 3. 数量・単位：レシピの値だけ、推測しない

| 状況 | 結果 |
| --- | --- |
| `amount` あり | そのまま採用。`unit` があれば併せて採用 |
| `amount` あり・`unit` なし | 数量のみ（「卵 2」は成立する） |
| `amount` なし | **両方 null**（単位だけでは何も伝わらず、DB の CHECK も拒否する） |
| `amount` が 0 以下 | 両方 null |
| **同じ食材が複数レシピに出た** | **両方 null** |

複数レシピの合算はしない。1個 + 2個 は頼まれていない計算であり、
「大さじ2」と「200g」はそもそも足せない（`sameUnit` が false）。
名前だけ残して、量はユーザーに書いてもらう。

`sourceRecipes[]` には**すべての**由来レシピを保持する（単数の `sourceRecipeId` ではない）。

---

## 4. 重複の扱い：PHASE 9 と完全に同じ

**既にリストにある候補も選択できる。**

| 項目 | 挙動 |
| --- | --- |
| 初期チェック | **全部 OFF**（既存・新規とも） |
| 既存項目の表示 | 「すでにリストにあります」と警告 |
| 選択 | **可能。** 選べば別項目として追加される |
| 自動統合 | **しない** |
| 追加拒否 | **しない** |

`alreadyOnList` は提案時点のスナップショットにすぎない。**確定時は
`createShoppingItem` が内部で `listShoppingItems` を呼ぶため、
その時点の DB 状態で重複判定がやり直される。** カードを見てから押すまでの間に
リストが変わっていても、通知は最新状態に基づく。

---

## 5. 冪等性：`ai_tool_calls` を再利用し、書き込みは fail-closed

**migration は作っていない。** 冪等台帳は既存の `ai_tool_calls` を使う。
migration 0002 のコメントが `call_id` を「Realtime の call id、**または任意の
クライアント供給キー**」と明記しており、UI 由来の `requestId` はその想定内である。

### `failClosed` を足した理由（必須の修正だった）

既存の `runOnce` は **claim に失敗したらガード無しで実行**していた。
読み取り系ツールなら可用性を優先する判断として理解できるが、
**買い物リストへの追加でそれをやると二重登録が復活する。**

`runOnce` に `failClosed` オプションを追加した。厳格モードでは:

- claim が作れない → **`createShoppingItem` を 1 回も呼ばず** `IdempotencyUnavailableError`
- claim を取れず、かつ既存結果も読めない → 同上
- キーが無い → 同上
- Server Action が捕まえて「追加できませんでした。もう一度お試しください。」を返す

**既存 AI ツールの挙動は変えていない**（`failClosed` を渡さなければ従来どおり）。
回帰テストで固定してある。

### `requestId`

クライアントで `crypto.randomUUID()` を **カード単位で 1 回だけ**生成し、
`useRef` に保持する。処理が終わるまで再生成しない。連打も、通信断後の再送も、
同じキーで届いて台帳が答える。**`pending` は UX であって安全策ではない。**

---

## 6. 一括追加の部分失敗（明文化）

`runAddSuggested` は **例外を投げない。** 投げると `runOnce` が claim を解放し、
再試行で**成功済みの項目が二重登録**される。

| 状況 | 挙動 |
| --- | --- |
| 全件成功 | `added: N`。`status: 'done'` で保存 |
| 途中失敗 | **成功分は残る。** `{ added, failed }` を保存して `done` |
| 同じ requestId で再送 | **保存済み結果を返す。1 行も追加しない** |
| 失敗分の再試行 | ユーザーが失敗項目だけ選び直す → **新しいカード = 新しい requestId**。成功済みは選択に含まれないので二重にならない |
| 送信中に再送 | in-flight 応答を正規化して「追加を処理中です」を表示 |
| 台帳が使えない | **何も追加せず**エラー |
| 1 件も書けなかった | `revalidate` しない |

UI は「3 件を買い物リストに追加しました（1 件は失敗しました）」と件数で示す。

Server Action 側で**選択件数（上限 30）・名前・数量・単位を再検証する**。
カードの値はブラウザを往復した時点でクライアント入力に戻っているため。

---

## 7. 提案カードの保存・復元：復元しない

### 調査で分かったこと

| 経路 | 現状 |
| --- | --- |
| tool 結果の DB 保存 | `conversation_messages` に `role='tool'` で残る |
| チャット再表示 | **`/chat/page.tsx` が `role !== 'tool'` で除外**。画面に出ない |
| ブラウザへの到達 | **`TurnResult` に載っていなかった。** DB 保存と、クライアントが構造化結果を受け取れることは別問題だった |

そこで `ToolOutcome.suggestions` → `TurnResult.shoppingSuggestions` という経路を
新設した。tool メッセージを再パースするのではなく、帯域外で運ぶ。
保存された `role: 'tool'` 行はモデルのための記録であって、ブラウザは読まない。

### 復元しない判断

`suggest_shopping_items` を **`STALE_ON_REPLAY` に追加**した。
既に `get_inventory` / `find_inventory_item` / `search_meal_candidates` が入っている
集合で、コメントにこうある —— 在庫読み取りの結果は「その時点の事実」であって
永続的な真実ではない。

**提案カードはまさに在庫読み取りの派生物である。** 1 時間前の「玉ねぎが無い」を
復元して見せると、その間に買った玉ねぎを二重に買わせる。PHASE 4 で直したのと
同じ種類のバグになる。

したがってカードは `ChatView` のメモリ内 state のみで、再読込後は消える。
**「復元できない」ではなく「復元してはいけない」。**

代わりに、**永続化されるのはアシスタントの本文**なので、そこだけ後から読んでも
意味が通るよう、プロンプトで次の趣旨を必ず含めさせている:

> この候補は現在の在庫を基にした一時的な結果です。
> 再読み込み後は、最新候補をもう一度確認してください。

---

## 8. 音声モードについて（既知の制約）

SPEC §21.1 は「テキストと音声で assistant の能力を分岐させない」と定めているため、
`suggest_shopping_items` は Realtime にも露出している。**書き込まない性質は
両モードで同じ**なので安全性は変わらない。

ただし**音声モードにカードは出せない。** 候補は読み上げられるが、その場で選んで
追加することはできず、`/shopping` から後で足すことになる。
UI 側の入口を `/chat` のみとした今回のスコープの帰結である。

---

## 9. 実装したもの

| ファイル | 内容 |
| --- | --- |
| `src/lib/shopping/suggest.ts` | 純粋関数。`normalizeRecipeIds` / `buildShoppingSuggestions` |
| `src/lib/ai/tools.ts` | 読み取り専用ツール 1 個（13 → 14） |
| `src/lib/ai/service.ts` | `TurnResult.shoppingSuggestions` / `STALE_ON_REPLAY` |
| `src/lib/ai/prompt.ts` | 【買い物候補】ルール |
| `src/lib/ai/idempotency.ts` | `failClosed` と `IdempotencyUnavailableError` |
| `src/lib/shopping/actions-core.ts` | `runAddSuggested`（例外を投げない） |
| `src/app/(app)/shopping/actions.ts` | `addSuggestedShoppingItemsAction` |
| `src/app/(app)/chat/suggestion-card.tsx` | カード |
| `src/app/(app)/chat/chat-view.tsx` | カードの差し込み |

**触っていないもの**: `supabase/migrations/` / RLS / 認証 / タイマー /
`inventory_items` への書き込み / 下部ナビ / `vercel.json`。

---

## 10. 検証

| 項目 | 結果 |
| --- | --- |
| `npm run typecheck` / `lint` / `build` | 成功 |
| `npm test` | 526 件 全PASS（462 → 526、新規 64 件） |
| `npm run check:migrations` | 5/5（**変化なし = migration を足していない**） |
| `npm run audit:rls` | 43/43（**変化なし = 新テーブルなし**） |

### 実データでの確認（済み）

実モデルに「肉じゃがを作りたい。レシピを作って、買い物リストの候補を出して。」:

```
toolsUsed: ["create_recipe", "suggest_shopping_items"]
候補: じゃがいも 2個(在庫にない) / 玉ねぎ 1個(在庫切れ) /
      にんじん 0.5本(在庫にない) / だし 200ml(在庫にない)
```

- **`shopping_items` は実行前後とも 0 行**（書き込みゼロを実測）
- 玉ねぎは在庫行が `empty` なので `out_of_stock`、じゃがいもは行が無いので `absent` と、
  サーバーが理由を区別できている
- 醤油・砂糖は在庫にあり、かつ調味料なので候補に出ていない
- 返答に「一時的な結果です。再読み込み後は最新の候補をもう一度確認してください」が
  含まれ、「追加しました」とは言っていない

### 実 Postgres での冪等性（`npm run test:live`）

`ai_tool_calls` を UI 由来キーで使えることを実測した:

- 同じ `requestId` で 2 回 → **追加は 1 回だけ**（2 行のまま、4 行にならない）
- **同時送信 2 本** → 片方だけが実行、もう片方は duplicate（1 セットのみ）
- キー無し + `failClosed` → **1 行も追加せず**エラー

---

## 11. 実機 QA（未実施）

自動ブラウザではカードの操作を確認できていない（ペインがハイドレートしないため。
PHASE 9 と同じ制約で、コードの欠陥ではない）。以下は実機で確認する。

1. 候補カードが出る。**チェックは最初すべて外れている**
2. チェックしたものだけが追加される
3. 「すでにリストにあります」が出る候補も**選んで追加できる**
4. 追加後に重複通知が PHASE 9 と同じ文言で出る
5. **追加ボタンを素早く 2 回押しても二重登録されない**
6. 一部失敗時に件数が正しく出る
7. 再読込するとカードが消える（**意図した挙動**）。本文には「一時的な結果」と残る
8. `/shopping` へのリンクが機能する
9. 音声モードでは候補が読み上げられ、カードは出ない（既知の制約）
