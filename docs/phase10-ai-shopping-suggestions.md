# PHASE 10 — AI 買い物候補提案

**Status: IN_PROGRESS**（実装済み・実機 QA 未実施。migration なし）

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

`runOnce` に `failClosed` オプションを追加した。厳格モードの挙動:

| 段階 | 挙動 |
| --- | --- |
| claim が作れない | **`createShoppingItem` を 1 回も呼ばず** `IdempotencyUnavailableError`。**何も書いていないので同じキーで再試行してよい** |
| キーが無い | 同上 |
| claim は取れたが、既存結果を読めない | 同上 |
| **callback が例外を投げた** | **claim を解放しない。** `IdempotentWriteUnresolvedError` |
| **完了結果を保存できない** | **claim を解放しない。** `stored: false` を返す |

**既存 AI ツールの挙動は変えていない**（`failClosed` を渡さなければ従来どおり
claim を解放して再試行できる）。回帰テストで固定してある。

### 書き込み開始後に claim を解放してはいけない理由

当初は callback が失敗したら claim を削除していた。読み取りなら正しい
——「in flight のまま永久に詰まる」より再試行できる方がよい。

**書き込みでは逆である。** callback は途中まで行を書いてから失敗しうる。
claim を解放すると再試行が callback を再実行し、**すでに書いた行がもう一度入る。**
これは台帳が防ぐはずだったものそのものである。

したがって厳格モードでは、**callback に入った後は claim を絶対に手放さない。**
同じキーの再送は実行されず拒否され、UI は再試行を勧めずに
「結果を確定できません。買い物リストを確認してください。」と案内する。

### この設計が保証するもの

**exactly-once ではない。** 保証するのは **at-most-once** で、結果が確定できない
ときは推測せず停止する。「1 回は必ず実行された」とは言えない場面が存在する
（claim 直後にプロセスが落ちた場合など）。その場合ユーザーはリストを見て判断する。

### `requestId` のライフサイクル

クライアントで `crypto.randomUUID()` を生成し `useRef` に保持する。
**更新するのは完了した実行の後だけ**で、規則は
`shouldRotateRequestId(status)` が持つ（純粋関数・テスト済み）。

| 状況 | キー |
| --- | --- |
| 同じ送信の二重タップ中 | **同じ ID**（台帳が答える） |
| `in_flight` | **同じ ID を維持** |
| `done`（成功・部分成功とも） | **新しい ID へ更新**。次の操作に使う |
| 失敗項目の再試行 | 上で更新済みの**新しい ID**。成功済みは選択に含まれない |
| `rejected`（検証で拒否） | **同じ ID**。台帳に触れていないので消費されていない |
| `unavailable`（何も実行されず） | **同じ ID**。再試行して安全 |
| `unknown`（結果不明） | **同じ ID を維持。自動再送しない。** 買い物リスト確認を案内 |

キーを更新しないと、1 回目の完了後に別の候補を追加しようとしても
**1 回目の結果が再生されて何も追加されない。** 回帰テストで固定してある。

**`pending` は UX であって安全策ではない。**

### カードは 1 回の送信では閉じない

当初は「完了した送信」と「終わったカード」を同一視し、`done` でカード全体を
無効化していた。**これは誤りだった。** その状態では、1 回目の追加のあとに別の候補を
足そうとしても**チェックすら付けられない。** キーを更新しても UI から送信できない。

カードは複数回使われる。今夜必要な物を足して、そのあともう 1 品足す。
そこで状態を `src/lib/shopping/suggestion-card-state.ts` の純粋な遷移に切り出した。

| 状態 | 挙動 |
| --- | --- |
| `blocked` | `pending \|\| unknown` **のみ**。`done` は含めない |
| `done` した候補 | 「追加済み」と表示し**チェック不可**にする（二重送信を防ぐ） |
| 未選択の候補 | **引き続き選択可能** |
| 失敗した候補 | チェックが残るので、**新しいキーでそのまま再送**できる |
| 全候補が追加済み | そのときだけ追加ボタンを非表示 |
| `unknown` | **カード全体を閉じる**（行が存在するか判らないため） |

---

## 6. 一括追加の部分失敗（明文化）

`runAddSuggested` は **例外を投げない。** 投げると `runOnce` が claim を解放し、
再試行で**成功済みの項目が二重登録**される。

| 状況 | 挙動 |
| --- | --- |
| 全件成功 | `added: N`。`status: 'done'` で保存 |
| 途中失敗 | **成功分は残る。** `{ added, failed }` を保存して `done` |
| 同じ requestId で再送 | **保存済み結果を返す。1 行も追加しない** |
| 失敗分の再試行 | 完了時にキーが更新済み。ユーザーが失敗項目だけ選び直して押す → **新しい requestId**。成功済みは選択に含まれないので二重にならない |
| 送信中に再送 | `in_flight` →「追加を処理中です。少し待ってから買い物リストを確認してください。」 |
| 台帳を claim できない | **何も追加せず** `unavailable`。同じキーで再試行してよい |
| **結果を確定できない** | `unknown` →「結果を確定できません。買い物リストを確認してください。」**再試行ボタンを出さない** |
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

### 事実

`realtimeToolDefinitions()` は `TOOL_DEFINITIONS` をそのまま平坦化する関数で、
**この関数自体は変更していない。** 変更したのは `TOOL_DEFINITIONS` への 1 件追加で、
その結果として `suggest_shopping_items` は**音声にも自動的に露出している**。

実測（`realtime.test.ts`）:

- `realtimeToolDefinitions()` は **14 件**（PHASE 8 までの 13 + 今回の 1）
- 一覧はテキストモードの `TOOL_DEFINITIONS` と**完全に一致**（SPEC §21.1 の不変条件）
- `suggest_shopping_items` が含まれ、description に「買い物リストに何も追加しない」を含む

### 制約と対応

**書き込まない性質は両モードで同じ**なので安全性は変わらない。
ただし**音声では確定カードを操作できない。**

そのため音声モード専用のプロンプト規則（`VOICE_SHOPPING_RULES`）を足し、

- 候補は読み上げるだけにする
- **「追加は画面で候補を選んでください」と案内する**
- その場で追加したように言わない

を指示している。テキストモードにはこの規則を入れていない（テストで確認済み）。

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
| `src/lib/shopping/suggestion-card-state.ts` | カード状態の純粋な遷移（再利用可能であることの規則） |
| `src/app/(app)/chat/suggestion-card.tsx` | カード |
| `src/app/(app)/chat/chat-view.tsx` | カードの差し込み |

**触っていないもの**: `supabase/migrations/` / RLS / 認証 / タイマー /
`inventory_items` への書き込み / 下部ナビ / `vercel.json`。

---

## 10. 検証

| 項目 | 結果 |
| --- | --- |
| `npm run typecheck` / `lint` / `build` | 成功 |
| `npm test` | 全PASS（462 → 552、新規 90 件） |
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
- 完了した実行は `stored: true` で記録され、再送は再実行されない
- **callback が途中まで書いてから落ちた場合** → claim を保持したままなので、
  同じキーの再送は**実行されず**、書けた 1 行のまま増えない

### 冪等性の合成テスト（`confirm-idempotency.test.ts`）

Server Action と同じ合成（`runOnce(failClosed) × runAddSuggested`）で検証:

| 検証 | 結果 |
| --- | --- |
| 同じ送信を 2 回 → 追加は 1 回 | ✅ |
| 1 回目完了後、**新しいキー**で別候補 → 正常に追加 | ✅ |
| 部分失敗後、失敗項目を新しいキーで再送 → **成功済みは増えない** | ✅ |
| claim 失敗 → **1 行も書かない** | ✅ |
| キー無し → **1 行も書かない** | ✅ |
| 完了保存の失敗 → 行は残り `stored: false`、再送は拒否 | ✅ |
| callback 例外 → claim を保持、再送で**再実行しない** | ✅ |
| 読み取りでは従来どおり claim を解放して再試行できる | ✅ |

---

## 11. 実機 QA（未実施）

**自動ブラウザではカード操作を検証できなかった。原因は特定していない。**
（ハイドレーションが止まっている、という以前の説明は仮説であって確認されていない。）
以下は実機で確認する。

1. 候補カードが出る。**チェックは最初すべて外れている**
2. チェックしたものだけが追加される
3. 「すでにリストにあります」が出る候補も**選んで追加できる**
4. 追加後に重複通知が PHASE 9 と同じ文言で出る
5. **追加ボタンを素早く 2 回押しても二重登録されない**
6. `/shopping` へのリンクが機能する
7. **1 回目の追加完了後、同じカードの別候補を追加できる**
   （追加済みは「追加済み」と出てチェック不可、未選択は選べる。
   `requestId` 更新の実配線確認 —— **最重要**）
8. **提案を表示しただけでは `shopping_items` の行数が増えない**
9. **音声では候補を読み上げ、自動追加せず「画面で選択してください」と案内する**
10. **音声提案後も `shopping_items` が増えていない**
11. **再読込後、カードは消えるが本文だけで意味が通る**
    （「一時的な結果です。再読み込み後は最新の候補をもう一度確認してください」が残る）

部分失敗・完了記録失敗・`unknown` は自動テストで担保済み。
実機で障害を起こす必要はない。

---

## 12. migration `0006_one_active_conversation.sql` — 適用後の確認

**Status: ✅ 適用済み（2026-08-10）。** 実測値は §12.5。

`0006` は列を足さないので、PostgREST 越しには「行が整理されたか」しか見えない。
**行の整理だけが適用され index が無い状態**は、重複が 0 件という同じ見え方をする。
`npm run check:migrations` はこの状態を PASS にせず
`⚠️ MANUAL VERIFICATION REQUIRED` と出す。判定は以下の SQL で行う。

**すべて `select` のみ。行は 1 件も変更しない。**
Supabase SQL Editor で実行すること。

### 12.1 active な会話が user ごとに 1 件以下

```sql
select user_id, count(*) as active_count
from public.conversation_sessions
where status = 'active'
group by user_id
having count(*) > 1;
```

**期待値: 0 行。** 1 行でも返れば index は存在し得ない（= 未適用）。

### 12.2 index が「unique・対象列 user_id・predicate status='active'」であること

```sql
select
  c.relname                                  as index_name,
  i.indisunique                              as is_unique,
  (
    select array_agg(a.attname order by k.ord)
    from unnest(i.indkey) with ordinality as k(attnum, ord)
    join pg_attribute a
      on a.attrelid = i.indrelid
     and a.attnum   = k.attnum
  )                                          as indexed_columns,
  pg_get_expr(i.indpred, i.indrelid)         as predicate,
  pg_get_indexdef(i.indexrelid)              as definition
from pg_index i
join pg_class     c on c.oid = i.indexrelid
join pg_class     t on t.oid = i.indrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'conversation_sessions'
  and c.relname = 'conversation_sessions_one_active_per_user_idx';
```

**期待値: 1 行。かつ**

| 列 | 期待値 |
| --- | --- |
| `is_unique` | `true` |
| `indexed_columns` | `{user_id}` |
| `predicate` | `(status = 'active'::text)` |

0 行なら index が無い。`is_unique` が `false` なら重複を止められない。
`predicate` が `null` なら partial ではなく、closed な会話まで 1 件に縛ってしまう。

### 12.3 一発で PASS / FAIL を出す版

12.1 と 12.2 の両方を 1 行に畳んだもの。`all_ok` が `true` なら適用済み。

```sql
select
  not exists (
    select 1
    from public.conversation_sessions
    where status = 'active'
    group by user_id
    having count(*) > 1
  ) as no_duplicate_active,
  coalesce(bool_or(
    i.indisunique
    and (
      select array_agg(a.attname order by k.ord)
      from unnest(i.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a
        on a.attrelid = i.indrelid
       and a.attnum   = k.attnum
    ) = array['user_id']
    and pg_get_expr(i.indpred, i.indrelid) ~ '^\(?status = ''active''(::text)?\)?$'
  ), false) as index_ok,
  not exists (
    select 1
    from public.conversation_sessions
    where status = 'active'
    group by user_id
    having count(*) > 1
  )
  and coalesce(bool_or(
    i.indisunique
    and (
      select array_agg(a.attname order by k.ord)
      from unnest(i.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a
        on a.attrelid = i.indrelid
       and a.attnum   = k.attnum
    ) = array['user_id']
    and pg_get_expr(i.indpred, i.indrelid) ~ '^\(?status = ''active''(::text)?\)?$'
  ), false) as all_ok
from pg_index i
join pg_class     c on c.oid = i.indexrelid
join pg_class     t on t.oid = i.indrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'conversation_sessions'
  and c.relname = 'conversation_sessions_one_active_per_user_idx';
```

`index_ok` の predicate 比較を `=` ではなく `~` にしてあるのは、
`pg_get_expr` の括弧と `::text` の付き方が Postgres のバージョンで揺れるため。
中身（`status = 'active'`）が変わっていないことだけを見ている。

### 12.4 適用後に実行するもの

```
npm run check:migrations   # 0006 が ⚠️ から ✅ に変わるのは pg_index を読めるときだけ
npm run test:live          # src/lib/ai/conversation-live.check.ts が実DBで index を実測する
```

`test:live` は**使い捨てユーザーだけ**を作って検証し、後片付けは
`auth.users` の削除（`on delete cascade`）で行う。既存の会話・メッセージには触れない。
**`0006` 適用前に実行しないこと**（index が無ければ落ちるだけだが、
落ちた理由が「未適用」だと分かるようにメッセージを入れてある）。

### 12.5 実測（2026-08-10 適用）

適用の前後を実測した結果。**行もメッセージも 1 件も失われていない。**

| 項目 | 適用前 | 適用後 |
|---|---|---|
| `conversation_sessions` 合計 | 7 | **7** |
| `conversation_messages` 合計 | 186 | **186** |
| `status = 'active'` | 3 | **2** |
| `status = 'closed'` | 4 | **5** |
| active を持つ user 数 | 2 | 2 |
| max active per user | 2 | **1** |
| duplicate users | 1 | **0** |

⚠️ **「1 ユーザーに 3 件」ではない。** active 3 件は **2 ユーザーにまたがって**おり、
重複していたのは片方のユーザーの 1 件分だけ。したがって step 1 が `closed` にしたのは
**1 行**（`closed` 4 → 5）。もう一方のユーザーの active 1 件は最初から対象外。

§12.2 の結果:

| 列 | 実測値 |
| --- | --- |
| `index_name` | `conversation_sessions_one_active_per_user_idx` |
| `is_unique` | `true` |
| `indexed_columns` | `{user_id}` |
| `predicate` | `(status = 'active'::text)` |

### 12.6 適用後に実行した確認

| 実行 | 結果 |
|---|---|
| `npm run check:migrations` | `0001`〜`0005` ✅ / `0006` ⚠️ MANUAL VERIFICATION REQUIRED（**仕様どおり**。重複 0 件は確認、index は PostgREST から読めない） |
| `conversation-live.check.ts` | **3/3 PASS**（実 Postgres） |
| `npm run audit:rls` | **43/43 PASS** |
| 一時ユーザーの後片付け | **独立に確認**。実行後 `conversation_sessions` 7 / `messages` 186 に戻り、`conversation-live-check@example.com` は 0 件 |

live check が実証したこと:

1. 同時に `getOrCreateConversation` を 2 本 → **同じ ID** を返し、active は 1 件
2. 手で 2 本目の active を insert → **23505 で拒否**され、
   エラーに `conversation_sessions_one_active_per_user_idx` が出る
3. 同じ user の `closed` 行は**通る** —— index が partial であること自体の確認。
   これが落ちると `startNewConversation`（1 件閉じて 1 件開く）が本番で壊れる

**2 が本命。** 1 だけでは index がなくても通り得る（2 本目が偶然 1 本目の
commit 済みの行を読めば ID は一致する）。DB 自身が拒否することを見ているのは 2 だけ。

> 初回実行時、sign-in が Vitest の既定 5s を超えて timeout し、
> 使い捨てユーザーが 1 件残った（会話行は 0 件）。sign-in を `beforeAll` に移して
> 30s を与え、`afterAll` は id が取れていなくても email で引いて削除するようにした。
> **アカウントを作る check は、失敗経路でも消せなければならない。**

---

## 13. 第2段階 —— Server Action +「新しい会話」UI

`0006` が適用され、DB が「1 user につき active な会話は 1 件」を保証するように
なったので、その上に「会話を切り替える」操作を載せた。

### 13.1 なぜ必要か

`startNewConversation` は §12 以前から実装・テスト済みだったが、**呼び出す経路が
どこにも無かった**（`grep` で service とテスト以外に参照ゼロ）。
長い会話のあとモデルが自分の過去の発言を繰り返す問題（PHASE 4 と同じ種類）に対して、
機能はあるのに使えない状態だった。

### 13.2 構成

| ファイル | 役割 |
| --- | --- |
| `src/lib/ai/conversation-actions-core.ts` | 判断の中身（純粋・テスト可能） |
| `src/lib/ai/conversation-actions-core.test.ts` | 上記の固定（6 件） |
| `src/app/(app)/chat/actions.ts` | `'use server'` の薄いラッパ |
| `src/app/(app)/chat/chat-view.tsx` | ヘッダーのボタンと確認 UI |

PHASE 9 の買い物 Server Action と同じ形（認証 → core に service を渡す →
core の判断を返す）。Supabase のクエリは action に書かない。

### 13.3 冪等台帳を使っていない理由

買い物の追加とは違い、**`ai_tool_calls` の台帳を使っていない。**

`startNewConversation` は元から二度押しに耐える。2 回目は「メッセージが 0 件の会話」を
見つけてそれをそのまま返し、新しい行を作らない。さらに同時押しに対しては
**`0006` の partial unique index が DB 側で decide する** ——
負けた側は 23505 を受けて勝った側の会話を採用する（`getOrCreateConversation`）。

つまり台帳は「DB が既に拒否する race」を二重に守ることになるだけなので足していない。
**書き込みが失敗しても再試行してよい**のもこのため（買い物の `unknown` に相当する
状態が存在しない）。

### 13.4 UI の判断

| 項目 | 挙動 | 理由 |
| --- | --- | --- |
| ボタンの表示 | **メッセージが 0 件なら出さない** | 切り替える先が無く、service 側も no-op |
| 送信中 | **無効化** | 応答が返る前に会話を閉じると、その返答の行き先が変わる |
| 1 タップ目 | **確認を出す**（実行しない） | 削除はされないが、閉じた会話を見る画面は無い。利用者から見れば消える |
| 確認の文言 | 「画面から消えますが、**削除はされません**」 | 事実をそのまま言う |
| 成功後 | `setMessages([])` + `router.refresh()` | `initialMessages` は `useState` の初期値なので、再描画だけでは画面が変わらない |
| 失敗時 | エラー文言を出し、**カードは開いたまま** | 古い会話はまだ開いている。そのまま押し直せる |
| `revalidate` | **成功時のみ** | 失敗時に再描画すると、まだ開いている会話を「切り替わった」ように見せてしまう |

### 13.5 検証

| 実行 | 結果 |
|---|---|
| `npm run typecheck` / `lint` / `build` | 成功 |
| `npm test` | **586 PASS**（580 → +6） |
| `git diff --check` | clean |

### 13.6 ⚠️ ブラウザでの自動検証はできていない

§11 に「自動ブラウザではカード操作を検証できなかった。原因は特定していない」と
書いたが、今回その**症状だけ**は具体的に取れた（原因の断定には至っていない）。

`/chat` を dev サーバーで開いて DOM を調べた結果:

- React は**ハイドレートしている**（`__reactFiber$` を持つ要素が 119 中 51、
  `body` / `html` も含む）。console にエラーは 1 件も出ない
- しかし**ハイドレート済みのツリーに ChatView の中身が無い**。
  生きている `div.flex.h-dvh` にはヘッダーの `h1` と下部ナビだけで、
  **`form` も `button` も入っていない**
- ChatView の完全なマークアップ（`新しい会話` / `音声で操作` / `送信` の 3 ボタンを含む）は、
  **`body` 直下の別の `div` に孤立している**。この `div` は
  `__reactFiber$` を 1 つも持たない
- したがって `新しい会話` ボタンに React の `onClick` は付いておらず、
  `click()` しても確認 UI は出ない。**押せないのであって、壊れているのではない**

`h1` が 2 つある（生きている方と孤立した方）ことも確認済み。

**この症状は今回の変更が作ったものではない**（PHASE 10 の時点で既に記録がある）。
また PHASE 9 は同じ構成で**実機 14/14 PASS** しているので、実ブラウザでは
ハイドレートしていると考えられる。プレビュー環境側の問題である可能性が高いが、
**確認していないので断定しない。**

### 13.7 実機 QA で確認すること（未実施）

§11 の項目に加えて:

12. 会話が空のときは**「新しい会話」ボタンが出ない**
13. メッセージがあるとボタンが出て、押すと**確認が出る**（この時点では何も起きない）
14. 「キャンセル」で確認が閉じ、**会話はそのまま**
15. 「始める」で**画面が空になり**、`/chat` を再読込しても空のまま
16. **調理中の場合、新しい会話でも「調理画面へ」が出続ける**
    （`cookingSessionId` を引き継いでいるか）
17. 送信中は**ボタンが押せない**
18. 「始める」を素早く 2 回押しても**空の会話が 2 つできない**
19. 開始後、**過去のメッセージが DB から消えていない**
    （`conversation_messages` の件数が減っていないこと。§12.1 の SQL で確認できる）
