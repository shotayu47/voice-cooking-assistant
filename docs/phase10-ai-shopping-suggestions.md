# PHASE 10 — AI 買い物候補提案

**Status: IN_PROGRESS**（実装済み・**実機 QA 一部のみ完了**）

- 買い物候補の**確定操作**と**「新しい会話」UI** は `0d16f7f` で実機 PASS（§18.1・§18.2）。
  関係コードは `a5ca23c` まで未変更なので引き継ぎ可（§17.1）
- 音声の**会話継続性**は `a5ca23c` で実機 PASS（§16）
- **残っているのは主に「停止時の復旧UI」と「疎通確認の分岐」**（§18.4）
- migration は当初「なし」だったが、その後 `0006_one_active_conversation.sql` を
  追加し**適用済み**（§12）

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
ただし**通話中は確定カードを操作できない**（手が濡れている前提の音声モードで、
画面のチェックボックスを触らせる想定にはしていない）。

> ⚠️ **§14 で更新。** 「操作できない」は**カードを出さない理由にはならなかった。**
> 実機QAでカードが 1 枚も出ず、原因は `/api/realtime/tool` が構造化候補を
> 返していなかったことだった。現在は音声でもテキストと同じカードが画面に出て、
> 通話を終えたあとに選んで確定できる。読み上げるだけで終わらせない。

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

---

## 14. 音声QA の結果 —— QA 9 FAIL / QA 10 PASS

**PHASE 10 は引き続き `IN_PROGRESS`。**

実機音声QAで 2 件の不具合が出た。QA 9（カード表示）と QA 10（勝手に追加されない）は
**別々に判定した** —— 前者は FAIL、後者は PASS で、原因も別である。

### 14.1 事実（実測）

音声で買い物候補を尋ねたとき:

- AI は候補を読み上げた（じゃがいも 2個 / にんじん 1本 / だし汁 300ml）
- 「追加は画面で候補を選んでください」と案内した
- **画面に候補カードは出なかった** → **QA 9 FAIL**

### 14.2 ツールは本当に呼ばれたのか —— 呼ばれていた

「読み上げた食材名」はツール実行の証拠にならないので、`ai_tool_calls` を読んだ。
`/api/realtime/tool` は `runOnce` を通るため、音声のツール呼び出しは
Realtime の `call_...` を key として**必ず台帳に残る**。

```
2026-08-10T13:00:37Z  VOICE  suggest_shopping_items  done  call_QX77ghwDvzWrJyA8
  result.suggestions = [じゃがいも 2個 / にんじん 1本 / だし汁 300ml]
  result.added = false
```

- **`suggest_shopping_items` は実際に呼ばれていた**（音声由来の実行が計 3 件）
- **構造化候補は生成され、台帳に保存されていた**
- 読み上げ内容と台帳の候補は**完全に一致** → モデルの作り話ではない

つまり候補は正しく作られており、**壊れていたのは搬送だけ**だった。

### 14.3 確定した欠落経路

| 段 | 状態 |
|---|---|
| 1. Realtime セッション設定 | OK（tools 14 件、`suggest_shopping_items` 露出済み） |
| 2. 音声入力 → function call | OK（`response.done` で検出） |
| 3. `suggest_shopping_items` 実行 | OK（台帳に `done`） |
| 4. `/api/realtime/tool` の応答 | ❌ **`suggestions` を返していない** |
| 5. function call output を Realtime へ返却 | OK（`result` のみ返す。これは正しい） |
| 6. クライアントが構造化データを受信 | ❌ 読む口が無い（型に `suggestions` が無い） |
| 7. `ChatView` への反映 | ❌ 経路が存在しない（`onToolEffect` だけ） |
| 8. `SuggestionCard` の描画 | ❌ 描くデータが届かない |

**根本原因は 4。** `ToolOutcome.suggestions` はサーバー側に存在するのに、
`route.ts` の `NextResponse.json({...})` が `result` / `effect` / `session_id` /
`duplicate` しか載せておらず、そこで捨てられていた。6・7 はそもそも配線が無い。

テキスト経路は `ToolOutcome.suggestions → TurnResult.shoppingSuggestions` を
通るので影響が無く、だからテキストのQAだけ通っていた。

### 14.4 QA 10 は PASS（カード未表示とは別問題）

修正前後で `shopping_items` を読み取り専用で実測:

```
実装前: 3 行（じゃがいも 3個 / にんじん 1本 / じゃがいも 3個）
実装後: 3 行（同一 id・同一内容）
```

- 台帳の `add_suggested_shopping_items` は **UI 由来（UUID key）の 3 件のみ**。
  音声由来（`call_...`）の追加実行は**ゼロ**
- `suggest_shopping_items` の結果は `added: false`

**音声提案は買い物リストを変更していない** → **QA 10 PASS**。
QA 9 の FAIL は「書き込んでしまった」ではなく「表示できなかった」である。

### 14.5 修正（カード経路）

カードは**構造化結果からのみ**生成する。読み上げ文の解析は行わない。

| 変更 | 内容 |
|---|---|
| `api/realtime/tool/route.ts` | 応答に `suggestions` を追加。`effect` と違い**replay でも返す**（データであって発火するアクションではない） |
| `use-realtime-voice.ts` | `suggestions` を受け取り、**1 件以上のときだけ** `onSuggestions({callId, suggestions})` |
| `voice-panel.tsx` | `onSuggestions` を素通し。ツール名ラベルに `suggest_shopping_items` / `adjust_recipe_amounts` を追加（12→14 件） |
| `chat-suggestions.ts` | `withVoiceSuggestions()` を追加。**テキストと同じ `assistantMessage` / `hasSuggestionCard`** を使う |
| `chat-view.tsx` | 同じ `messages` state に載せ、**同じ `SuggestionCard`** で描画 |

- 重複防止は **`callId` を key** にした置換（`voice-${callId}`）。
  relay 再送でも `response.done` 再受信でも**カードは 1 枚**
- 別の call は別カードとして残るので、**複数 tool call でも候補を失わない**
- 0 件・欠落・null では**カードを作らない**（`assistantMessage` が空配列を捨てる既存規則）
- カードのキャプションは**アプリ側の固定文**。assistant の発話は使わない
- 再読込後に復元しない方針は不変（クライアント state のみ）
- PHASE 9 の重複規則・`requestId`・at-most-once は**一切変更していない**

### 14.6 修正（発話終了判定）

**推測せず実効値を実測した。** 現行の session body で client secret を mint し、
返ってきた `session.audio.input.turn_detection` を読んだ:

```
現行（turn_detection 未指定）:
  {"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,
   "silence_duration_ms":200,...}
```

⚠️ **既定は 500ms ではなく 200ms だった**（`gpt-realtime` で実測）。
公開ドキュメントの 500 とは異なる。200ms の無音は、
「何を買うか考えながら話す」ときの間より確実に短く、症状と完全に一致する。

**音声UXは連続会話方式**（`VoicePanel` はタップで接続/切断のトグル、
「タップで終了」はセッション終了）。したがってワンショット化はしない。

採用: **`semantic_vad` / `eagerness: 'low'`**（実測で受理を確認済み）。

| | 値 |
|---|---|
| type | `semantic_vad` |
| eagerness | `low`（最も待つ） |
| create_response | `true`（連続会話なので必須） |
| interrupt_response | `true` |
| silence_duration_ms | **送らない**（semantic_vad は使わない） |

**トレードオフ:** 発話終了の判定が「無音の長さ」から「言い終わった感じか」に
変わるため、**応答開始が一拍遅くなる。** 連続会話では、途中で切られて
半分の依頼に答えられるコストの方が大きいと判断した。

### 14.7 テスト

計 **607 件**（586 → +21）。

- `src/lib/shopping/voice-suggestions.test.ts`（11 件）
  同一state / 0件・欠落・null / 発話文のみ / 二重受信 / 複数call
- `src/app/api/realtime/realtime-routes.test.ts`（10 件）
  応答に `suggestions` が載ること・plain JSON であること・replay 時の扱い・
  書き込みが起きないこと・`turn_detection` の期待値・tools 14 件

`realtime-routes.test.ts` は**このプロジェクト初の route テスト**。
今回の不具合は「応答に項目が 1 つ足りない」だけで、
route の応答形状にテストが無かったため誰にも見えなかった。

### 14.8 修正後に必要な再QA（未実施）

1. 文章の途中で 1〜2 秒の間を空けても**途中確定されない**
2. 音声で買い物候補を依頼 → 候補を**読み上げる**
3. 同じ候補が**画面カードにも出る**
4. カードは初期状態で**すべて未選択**
5. 提案表示だけでは**買い物リスト 3 行が変化しない**
6. 選択した候補**だけ**追加できる
7. 追加ボタン二重タップでも**二重登録されない**
8. 音声終了後、**録音中表示が残らない**
9. 応答開始が遅すぎて実用に耐えないほどではないこと（`eagerness` の再検討判断）

---

## 15. 音声Realtimeの会話継続性（`d6de106` 実機QAの残課題）

**PHASE 10 は引き続き `IN_PROGRESS`。**

`d6de106` で「カードが出ない」は解消した（§14）。残ったのは**ターンが完了しない**問題で、
VAD調整の問題として片付けられるものではなかった。

### 15.1 確定した根本原因 —— cancelled を completed として扱っていた

`response.done` ハンドラが **`response.status` を一切見ていなかった。**

```js
case 'response.done': {
  const calls = selectExecutableCalls(event.response?.output, handled);
  for (const call of calls) { await runTool(...); }   // status を見ていない
}
```

`interrupt_response: true` のため、ユーザーが話し始めると進行中Responseは
**cancelled** になる。cancelled なResponseも**生成済みの output（function_call を含む）を
保持している**ので、イベント名だけを見ると正常終了と区別がつかない。結果:

1. cancelled なResponseの function call を**実行してしまう**
2. サーバーが既に破棄した call_id に対して `function_call_output` を送る
3. **これは拒否される** → モデルは tool 出力を永久に待つ
4. ユーザーからは「受理されたのに応答しない」に見える

ledger（`ai_tool_calls`）にこの痕跡が残っている。2026-08-11 15:15 台で
`search_meal_candidates` が 3件（15:15:04 / 15:15:07 / 15:15:09）、
`create_recipe` が 3件（15:15:19 / 15:15:49 / 15:15:58）—— **同じ意図の再呼び出し**が
40秒間に繰り返されており、出力が届かずモデルがやり直していた形跡と整合する。

### 15.2 併存していた欠陥（いずれもコード上で確認）

| # | 欠陥 | 帰結 |
|---|---|---|
| 1 | `response.status` 未確認 | **上記。cancelled の function call を実行** |
| 2 | `send()` が channel 未openで**黙って捨てる** | `function_call_output` が消失し、無言で停止 |
| 3 | tool後の `response.create` に**活性Response判定が無い** | `create_response: true` の自動生成と衝突。並行Responseは拒否され、**応答ゼロ**になる |
| 4 | **タイムアウトが存在しない** | 応答が来なくてもUIは「音声で操作中」のまま |
| 5 | `error` イベントで**状態を戻さない** | notice を出すだけ。`activeTool` も残る |
| 6 | ターン状態が個別booleanに散在 | 「未解決」という状態自体が**表現できない** |

「もしもし？」で調理工程が出るのは 1〜4 の結果である。ターンが未解決のまま放置され、
次の発話が新規要求として扱われ、プロンプト内で唯一内容の濃い
**進行中の調理セッションへ誤ルーティング**されていた。
ledger にも 15:19:29 に `start_cooking_session` が実在し、
セッションが実際に動いていたことが裏付けられる。

### 15.3 修正

**ターン状態機械**（`src/lib/voice/turn-state.ts`・純粋・テスト済み）

`listening / committing / waiting_for_response / responding / running_tool /
continuing_after_tool / completed / recoverable_error / unresolved`

不変条件を関数として強制:

| 不変条件 | 実装 |
|---|---|
| 初回Responseは1ターン最大1回 | `responsesCreated` |
| `function_call_output` は call_id ごと最大1回 | `canSendToolOutput()` |
| tool後の継続 `response.create` は最大1回 | `canRequestContinuation()` |
| 活性Response中は `response.create` を送らない | 同上（`activeResponseId` を見る） |
| `completed` 以外を正常終了にしない | `reduceTurn` の `response_done` |
| 結果不明時に勝手に進めない | `unresolved` + 手動 retry のみ |
| カードは音声失敗でも消さない | `cardShown` を保持 |

**タイムアウト（実測に基づく）**

QA ledger の**同一ターン内の tool 往復は 1〜10秒**（最大10秒）。既存の tool fetch
タイムアウトは30秒。その間に置いた:

- `noResponseMs: 12_000` —— commit後にResponseが始まらない
- `noContinuationMs: 20_000` —— tool出力後に応答が終わらない

**無反応を黙って待たない**（`VoicePanel`）
「応答を受け取れませんでした。」等を日本語で表示し、
**「もう一度応答を試す」**と**「音声を終了してテキストで続ける」**を出す。
retry は**新しい user item を追加せず**、commit済みターンに対して
`response.create` のみを再送する。状態不明時は自動再試行しない。

**疎通確認のルーティング**（`src/lib/voice/liveness.ts`・純粋・テスト済み）
プロンプト依存にしない。未解決ターンがあれば**そのターンの状態**を返し、
無ければ中立応答（「聞こえています。どの話を続けますか？」）。
どちらも**調理工程の案内を明示的に禁止**する instructions を付けて `response.create` する。
⚠️ **「お願いします」は疎通確認に含めない**（通常の依頼に使われるため。テストで固定）。

**イベントトレース**（`src/lib/voice/event-log.ts`）
STEP 1 の計測を継続可能にするため、**イベント名・時刻・ID・tool名・status・所要時間だけ**を
記録する。許可フィールドは allowlist で、**それ以外は捨てる**（テストで固定）。
音声・transcript・tool引数/結果・認証情報・在庫/レシピは記録しない。

### 15.4 VAD は変更していない

**根拠が無いため変更しなかった。**

- mint し直して実効設定を再確認: `semantic_vad / eagerness: low /
  create_response: true / interrupt_response: true`（送った通りに解決される）
- **発話途中でcommitされた証拠は取得できていない。** 実機のイベント列が必要で、
  それを取るための計測が §15.3 のトレースである
- 15.1〜15.2 の欠陥は**VADと独立に**ターンを壊す。特に `interrupt_response` による
  cancelled の誤処理は、**VADが正しく動くほど頻繁に起きる**

したがって「間で切れる」という体感の一部は 15.1 の帰結である可能性が高く、
**ターン管理修正後に再評価する**。それでも途中commitが残る場合の候補（未実装）:

1. 接続を保ったまま使える「話し終わった」ボタン（連続会話を壊さない）
2. 自動判定／タップ送信の選択
3. `eagerness` を上げる、または `server_vad` + 延長した `silence_duration_ms`

**大きなUX変更は無断で入れない。** 再QAの結果を見てから判断する。

### 15.5 テスト

**665件**（608 → +57）。

| ファイル | 件数 | 内容 |
|---|---|---|
| `turn-state.test.ts` | 30 | 通常ターン / tool継続 / 二重イベント / failed・cancelled・incomplete / 各タイムアウト / カード保持 / 復帰 |
| `liveness.test.ts` | 21 | 未解決時の疎通確認 / 中立応答 / 明示的な調理要求 / 「お願いします」を誤判定しない |
| `event-log.test.ts` | 12 | 記録内容 / **禁止フィールドの遮断** / 上限 |

既存のテキスト経路・カード経路の回帰テストはすべて維持（`npm test` 全件PASS）。

### 15.6 再QA手順（未実施）

1. 文章の途中で1〜2秒の間を空けても**途中確定されない**
2. 音声で買い物候補を依頼 → **読み上げ + カード表示**の両方が起きる
3. カードは**初期状態で全件未選択**
4. 提案表示だけでは**買い物リスト3行が変化しない**
5. 選択した候補**だけ**追加でき、二重タップでも二重登録されない
6. **応答が来ない場合、無言のままにならず**日本語のメッセージとボタンが出る
7. 「もう一度応答を試す」で**発話を繰り返さずに**応答が再生成される
8. 未解決の状態で「もしもし？」→ **調理工程の案内をしない**
9. 通常時の「もしもし？」→ 中立応答
10. 「次の工程を教えて」→ **従来どおり調理案内が動く**
11. 音声終了後、**録音中表示が残らない**
12. 会話のキャッチボールが続く（複数往復）

---

## 16. 音声再QA（`a5ca23c`）

| 項目 | 内容 |
|---|---|
| 記録日 | 2026-08-15 |
| 対象 SHA | `a5ca23c431a64ea57b4b6d82a123bc4293681265` |
| 環境 | **Vercel Preview**（Production ではない） |
| 端末 | **iPhone 実機 / Safari** |
| 結果 | **2件 PASS**（§15.6 のうち 2 項目相当） |

### 16.1 再QA 1 — 間を含む発話

発話（途中に約2秒の間を2回）:

> 肉じゃがを作りたいです。（約2秒）必要な材料を確認して、（約2秒）買い物候補を出してください。お願いします。

**画面で観測した事実:**

| 観測項目 | 結果 |
|---|---|
| 発話途中で切れた | **いいえ** |
| 返答開始まで | 約3秒 |
| 最後まで読み上げた | はい |
| 候補カード | **表示** |
| 初期チェック | **全件 OFF** |
| エラー・再試行UI | 非表示 |
| 無関係な調理工程への移動 | なし |

**判定: PASS。** スクリーンショットとも一致（カード表示・初期チェック全件OFF）。

「約3秒」は §14.6 で記録したトレードオフ（`semantic_vad` により応答開始が一拍遅れる）の
実測値でもある。**実用に耐えないほどではない**と判断でき、
`eagerness` を上げる必要は現時点で無い。

### 16.2 再QA 2 — 読み上げ途中の割り込み

AI が買い物候補を読み上げている途中で割り込み:

> 待って。じゃがいもの内容だけ教えて。

**画面で観測した事実:**

| 観測項目 | 結果 |
|---|---|
| 最初の読み上げを中断できた | はい |
| 割り込み後に応答した | はい |
| 割り込み内容を理解した | はい |
| 応答内容 | 「じゃがいもは在庫にないので、2個が候補です」 |
| 候補カード | **消えずに維持** |
| エラー・再試行UI | 非表示 |
| 無関係な調理工程への移動 | なし |

**判定: PASS。** スクリーンショットとも一致（カード維持のまま「じゃがいもは2個」と回答）。

### 16.3 ⚠️ 観測事実と、内部実装の根拠を分ける

上の 2 件で確認できたのは**画面に現れた結果**であって、
**Realtime の内部イベント列ではない。** 実機のイベントトレースは取得していない。

| 主張 | 根拠の種類 |
|---|---|
| 間を含む発話が途中確定されない | **実機observation**（QA 1） |
| 読み上げ中の割り込みが成立する | **実機observation**（QA 2） |
| 割り込み後も買い物候補の文脈を保つ | **実機observation**（QA 2 の応答内容） |
| 表示済みカードを失わない | **実機observation**（QA 1・2） |
| 無言停止・誤った調理工程移動が起きなかった | **実機observation**（この2ターンにおいて） |
| `cancelled` な旧Responseの function call を実行しない | **コードと自動テスト**（`turn-state.test.ts`「4-6」）。実機で `response.status` を観測したわけではない |
| `function_call_output` / 継続 `response.create` が各1回 | **コードと自動テスト**（同「3」）。実機で送信回数を数えたわけではない |
| 未解決ターンの検出とタイムアウト | **コードと自動テスト**（同「7-8」）。**実機では未発火** |

観測結果は上記の実装と**矛盾しない**が、
「実機でイベント列を確認済み」とは書けない。


### 16.4 §16.1・16.2 の2件で確認できていないこと

- **エラー・再試行UIが「非表示だった」ことは、必要なときに正しく出ることの確認ではない。**
  §15.6-6・7 はターンが実際に停止しないと発火しないため、この2件では未検証
- 「もしもし？」は発話していない（→ **通常状態のみ §16.5 で実施済み**。
  応答待ち中のケース §15.6-8 は引き続き未確認）
- 会話の往復は割り込みを含む2ターンのみ。§15.6-12「キャッチボールが続く」は
  **部分的な材料**であって完了ではない

### 16.5 音声再QA 3 —— 通常状態の疎通確認（§15.6-9）

未解決ターンが無い状態で「もしもし？」と発話した。

**事前条件（この項目では本質的）**

**調理セッションが進行中だった**（「牛肉と玉ねぎのあっさり煮」）。
検出したい失敗は「疎通確認が調理工程の案内にすり替わる」ことなので、
セッションが動いていなければ失敗モード自体が起こり得ない。
**今回は失敗しうる状態で試して、起きなかった。**

**画面で観測した事実**

| 観測項目 | 結果 |
|---|---|
| 認識結果（🗣） | 「もしもし？」 |
| 応答 | **「はい、聞こえています。どの話を続けますか？」** |
| 調理工程への移動 | **なし** |
| 新しい話題の開始 | **なし** |
| エラー・再試行UI | なし |
| 候補カード | もともと無し |
| 返答開始まで | 約1〜2秒 |

**判定: PASS。**

応答は `NEUTRAL_ACK`（「聞こえています。どの話を続けますか？」）に
「はい、」が付いた形。文言は固定文字列ではなく**モデルへの指示**として渡しているので、
一字一句の一致は要件ではない。要件は「中立であること」「調理工程へ移らないこと」で、
どちらも満たしている。

返答開始が §16.1 の約3秒より短い（約1〜2秒）のは、この経路が
`response.cancel` → 指示付き `response.create` で**短い応答を生成させている**ことと
整合する。ただし**内部イベント列は観測していない**ので、整合するという以上のことは言えない。

---

## 17. SHA をまたぐ QA の引き継ぎ判定

`0d16f7f` の実機QA結果を、現在の `a5ca23c` にそのまま持ち越してよいかを
**差分で判定した**（同じファイルが変更されていることを理由に未検証扱いにしない）。

### 17.1 `0d16f7f..a5ca23c` の差分

4 commit（`aa49813` / `d6de106` / `bb403b0` / `a5ca23c`）。
**買い物候補の確定・重複処理・「新しい会話」に関わるファイルは 1 バイトも変わっていない:**

```
IDENTICAL  src/app/(app)/chat/suggestion-card.tsx
IDENTICAL  src/app/(app)/chat/actions.ts
IDENTICAL  src/app/(app)/chat/page.tsx
IDENTICAL  src/lib/ai/conversation-actions-core.ts
IDENTICAL  src/lib/shopping/actions-core.ts
IDENTICAL  src/lib/shopping/suggestion-card-state.ts
IDENTICAL  src/app/(app)/shopping/actions.ts
IDENTICAL  src/lib/shopping/dedupe.ts
IDENTICAL  src/lib/shopping/service.ts
IDENTICAL  src/lib/ai/idempotency.ts
IDENTICAL  src/lib/ai/service.ts
```

共有ファイルの変更は 2 つだけで、**どちらも純粋な追加**である:

| ファイル | 変更 | 確定・重複・新しい会話への影響 |
|---|---|---|
| `chat-suggestions.ts` | `withVoiceSuggestions` と caption を**末尾に追加**。`assistantMessage` / `hasSuggestionCard` は**未変更** | **なし**（新関数は音声経路からのみ呼ばれる） |
| `chat-view.tsx` | `VoicePanel` に `onSuggestions` を渡す 9 行を追加 | **なし**（「新しい会話」ボタン・確認UI・`startNew`・カード描画条件はいずれも未変更） |

**結論: `0d16f7f` の確定操作QA・「新しい会話」QA は `a5ca23c` に引き継げる。**

### 17.2 新しく生まれた組み合わせ（`0d16f7f` では存在しなかった）

引き継ぎとは別に、**`aa49813` 以降にしか存在しない経路**が 1 つある:

- 「新しい会話」で `setMessages([])` した**あとに音声カードが届く**場合。
  どちらの実装も変わっていないが、**この組み合わせ自体が新規**で、
  `0d16f7f` のQAでは起こり得なかった。**未確認**

---

## 18. PHASE 10 実機QA 一覧（根拠つき）

「実機観測」「自動テスト」「DB検証」を分ける。
**推測で PASS にしない。**

### 18.1 買い物候補カード —— 確定操作（§11）

`0d16f7f` iPhone実機QA。§17.1 により `a5ca23c` へ引き継ぎ可。

| # | 項目 | 実機観測 | 対象SHA |
|---|---|---|---|
| 1 | カードが出て初期チェック全件OFF | **PASS** | `0d16f7f` / `a5ca23c`（§16 で音声経路も） |
| 2 | チェックしたものだけ追加される | **PASS**（じゃがいものみ選択→追加） | `0d16f7f` |
| 3 | 「すでにリストにあります」の候補も選んで追加できる | **PASS** | `0d16f7f` |
| 4 | 追加後に PHASE 9 と同じ重複通知が出る | **PASS** | `0d16f7f` |
| 6 | `/shopping` へ反映される | **PASS**（じゃがいも・にんじん各1件） | `0d16f7f` |
| 7 | 1回目完了後、同じカードの別候補を追加できる（`requestId` 更新） | **PASS**（じゃがいも「追加済み」で選択不可、にんじんは選択可→2回目成功） | `0d16f7f` |
| — | 自動統合せず**別項目**として追加（合計3行） | **PASS** | `0d16f7f` |

**未確認:**

| # | 項目 | 理由 |
|---|---|---|
| 5 | 追加ボタンの素早い二重タップで二重登録されない | 実機未実施。**自動テスト**（`confirm-idempotency.test.ts`）と台帳で担保 |
| 8 | 提案表示だけでは `shopping_items` が増えない | `a5ca23c` では未確認。**DB検証**として §14.4 に `d6de106` 時点の実測あり |
| 9 | 音声で「画面で選択してください」と案内する | §16 では案内文言を記録していない |
| 10 | 音声提案後も `shopping_items` が増えていない | 同 8 |
| 11 | 再読込後、カードは消えるが本文だけで意味が通る | 実機未実施 |
| — | 部分失敗・`unknown`・障害時の復旧UI | 実機未実施。**自動テスト**で担保 |

### 18.2 「新しい会話」UI（§13.7）

`0d16f7f` iPhone実機QA。§17.1 により引き継ぎ可。

| 項目 | 実機観測 | 対象SHA |
|---|---|---|
| ボタンが表示される | **PASS** | `0d16f7f` |
| タップで確認UIが出る | **PASS** | `0d16f7f` |
| 「キャンセル」で従来の会話表示に戻る | **PASS** | `0d16f7f` |
| 「始める」で従来メッセージが画面から消える | **PASS** | `0d16f7f` |
| 新しい空の会話画面になる | **PASS** | `0d16f7f` |
| 上部の調理セッション情報が維持される | **PASS** | `0d16f7f` |
| 新しい会話で買い物候補を依頼→カード表示 | **PASS** | `0d16f7f` |

**実機画面では確認していない（根拠が別）:**

| 項目 | 根拠 |
|---|---|
| 過去メッセージが DB に保持される | **サービス層テスト**（`conversation.test.ts`）＋ **DB検証**（§12.5: messages 186 → 186） |
| active 会話が 1 件 | **live check**（`conversation-live.check.ts` 3/3）＋ **DB検証**（§12.5 / §12.2 の index 実測） |

**未確認:**

- **同時二重タップによる新規会話作成** —— 実機未実施。
  自動テストと `0006` の partial unique index で担保
- **「新しい会話」直後に音声カードが届く場合**（§17.2 の新規組み合わせ）

### 18.3 音声 —— 会話継続性（§15.6）

| # | 項目 | 実機観測 | 対象SHA |
|---|---|---|---|
| 1 | 間を空けても途中確定されない | **PASS** | `a5ca23c` |
| 2 | 読み上げ + カード表示の両方 | **PASS** | `a5ca23c` |
| 3 | カード初期全件未選択 | **PASS** | `a5ca23c` |
| — | 読み上げ中の割り込みが成立し、文脈を維持 | **PASS** | `a5ca23c` |
| — | 割り込み後もカードを失わない | **PASS** | `a5ca23c` |
| 9 | 通常時の「もしもし？」→ 中立応答 | **PASS**（§16.5。調理セッション進行中の状態で実施） | `a5ca23c` |

**❌ FAIL:**

| 項目 | 結果 | 対象SHA |
|---|---|---|
| 応答読み上げ中の「もしもし？」→ 中立応答 | **FAIL**（§19）。中立応答が返らず、停止UIも出ず、2回目で旧回答が再開 | `a5ca23c` |

**この FAIL により残りの実機QAは中断。** 原因調査へ戻る（§19.2）。

**未確認:**

| # | 項目 | 備考 |
|---|---|---|
| 4 | 提案表示だけではリストが変化しない | `a5ca23c` で未確認（18.1-8 と同一） |
| 5 | 二重タップで二重登録されない | 18.1-5 と同一 |
| 6 | 停止時に無言にならずメッセージとボタンが出る | **今回の修正の中心だが未発火**。手順を先に検討する（§18.5） |
| 7 | 「もう一度応答を試す」で発話を繰り返さず再生成 | 同上 |
| 8 | 未解決状態の「もしもし？」→ 調理工程を案内しない | 未発話。**6・7 と同じ「停止の再現」が要る** |
| 10 | 「次の工程を教えて」→ 従来どおり調理案内 | 未実施 |
| 11 | 音声終了後、録音中表示が残らない | 未実施 |
| 12 | 複数往復のキャッチボール | 2ターンのみ（部分的） |

### 18.4 受け入れ条件

未確認が残るため **PHASE 10 は `IN_PROGRESS` を維持**し、
`docs/implementation-roadmap.md` の PHASE 10 は COMPLETE にしない。

完了と見なすために残っているのは、実質的に次の3群:

1. **停止時の復旧UI**（18.3-6・7）—— 今回の修正の中心。
   意図的に停止を再現する必要がある（機内モード等で tool 実行を失敗させる）
2. **疎通確認の分岐**（18.3-8・9・10）—— 「もしもし？」を実際に発話する
3. **提案だけでは書き込まない再確認**（18.1-8・10）—— `a5ca23c` での DB 実測

`requestId` 更新の実配線（18.1-7）は **`0d16f7f` で PASS 済み**であり、
§17.1 のとおり関係コードは未変更なので、再確認は不要。

---

## 19. 音声QA② FAIL —— 応答待ち途中の「もしもし？」

**対象: `a5ca23c` / Vercel Preview / iPhone実機 Safari / 調理セッション進行中**

### 19.1 実機で観測した事実

再現手順:

1. 「今あるもので作れるものを教えて」と発話
2. AI が読み上げ始めた直後に「もしもし？」と割り込み
3. **60秒待機**
4. 応答がないため、再度「もしもし？」と発話

| 観測項目 | 結果 |
|---|---|
| 1回目の認識結果 | 「もしもし？」（**認識は成功**） |
| 元の読み上げ | **中断された** |
| 割り込み後の応答 | **なし** |
| 待機時間 | 約60秒 |
| エラー・再試行UI | **表示されなかった** |
| 調理工程への誤移動 | なし |
| 候補カード | もともと無し |
| 2回目の「もしもし？」後 | 「あ、ごめん、ちょっとトラブルがあったみたい。もう一度やり直すね。少し待ってて」→ その後**中立応答ではなく、割り込み前の回答を再開**（「今ある材料だけで作れるものを4つ見つけたよ…」） |

**判定: FAIL。**

観測から確定できる失敗:

1. liveness 発話は**音声認識され、旧読み上げも中断できた**
2. しかし**新しい中立Responseが返らなかった**
3. **12秒／20秒を過ぎても停止・再試行UIが発火しなかった**（60秒待機）
4. 2回目の liveness 発話で、**破棄すべき旧回答が再開された**

### 19.2 コードから確認できた構造的欠陥

⚠️ **実機のイベント列は取得していない。**

以下は**コードを読んで存在を確認した欠陥**である。
**「これが QA② の失敗を起こした」と確定したものではない。**
欠陥がそこにあることと、今回の失敗の原因であることは別で、
後者はイベント列を見るまで断定しない。

**根本原因は未確定。** 以下は「構造的欠陥」と「最有力の説明」として扱う。

#### 欠陥1 —— ターン状態が Response と紐づいていない（**最有力の説明**）

`reduceTurn` の `response_done` は **`event.responseId` を `state.activeResponseId` と
照合していない。**

```ts
case 'response_done': {
  const cleared = { ...state, activeResponseId: null };   // どの Response かを見ない
  ...
  return { ...cleared, phase: 'completed', failure: null, waitingSince: null };
}
```

割り込み時は**1つのターンに複数の Response が絡む**（中断された旧Response、
`create_response: true` による自動生成、liveness 用の手動生成）。
どれの `response.done` であっても**現在のターンの状態を書き換えてしまう。**

#### 欠陥2 —— watchdog が恒久的に解除される経路

`response_done` が `completed` の場合、**`waitingSince: null`** かつ phase `completed` になる。
`overdue()` は先頭で `if (state.waitingSince === null) return null;` と返し、
phase `completed` も監視対象外。**以後この turn では watchdog が二度と発火しない。**

欠陥1と組み合わさると、**旧Responseの `response.done` が新しいターンの watchdog を
解除できる。** 「60秒待っても停止UIが出なかった」と整合する。

逆に旧Responseが `cancelled` で届いた場合は phase が `unresolved` になり、
今度は**停止UIが出るはず**だった。**どちらも起きていない**こと自体が、
「ターンと Response が対応していない」ことの傍証になっている。

#### 欠陥3 —— liveness の `response.create` が無ガード

```ts
send({ type: 'response.cancel' });
send({ type: 'response.create', response: { instructions: ... } });
```

- **`canRequestContinuation()` 等のガードを一切通っていない。**
  不変条件4「活性Response中に `response.create` を送らない」は
  `deliverToolOutput` にしか実装されておらず、**この経路は素通り**
- `response.cancel` は**非同期**で、完了は `response.done` の受信で分かる。
  それを待たずに `response.create` を送っており、
  旧Responseが活性のままなら**拒否される**（`conversation_already_has_active_response` 系）
- 拒否された場合 `error` → `advance({type:'api_error'})` → phase `recoverable_error`。
  `describeFailure()` は phase が `unresolved` のときしか文言を返さないので
  **UIには何も出ない**

#### 欠陥4 —— liveness Response が状態機械に登録されない

`handleLivenessCheck` は **`advance()` を一度も呼ばない。**
中立応答を要求したことが状態に残らないため、
**「中立応答が返ってこない」という失敗を検出する手段が無い。**

#### 欠陥5 —— `speech_started` が活性Responseを忘れる

`startTurn()` は `activeResponseId` を `null` にリセットする。
しかしサーバー側では旧Responseがまだ生成中でありうる。
**衝突を避けるために覚えておくべき情報を、衝突が起きる直前に捨てている。**

#### 欠陥6 —— `listening` が監視対象外

`overdue()` は phase `listening` を見ない。
`speech_started` の後 `committed` が来ないまま止まった場合、**無監視で放置される。**

#### 欠陥7 —— イベントトレースがUIから読めない

`useRealtimeVoice` は `eventTrace()` を返しているが、
**どのコンポーネントからも参照されていない**（`grep` で使用箇所ゼロ）。
まさにこの調査のために作った計測が、**実機から取り出せない。**

### 19.3 「旧回答が再開された」ことについて

2回目の「もしもし？」で旧回答が再開されたのは、
**会話履歴に未応答のユーザー要求（「今あるもので作れるものを教えて」）が残ったまま、
中立応答用の指示が適用されない Response が生成された**場合の挙動と整合する。

ただし**これは推論であり、確定していない。**
`response.create` が拒否されたのか、指示なしで生成されたのか、
2回目の liveness が `pass_through` になったのかは、**イベント列を見ないと区別できない。**

「トラブルがあったみたい」という発話は、モデルが会話内に
エラー item を見た可能性を示唆するが、**これも未確認。**

---

## 20. 実トレースで確認した Realtime の失敗経路

`31da5f1` / `c6bac06` の診断で取得したトレースから、**証拠のある経路**を記録する。
推論と観測を分ける。

### 20.1 確認済み —— continuation guard による `no_continuation`

**これは実トレースで確認できた。**

```
R1 completed → search_meal_candidates C1 (389ms 成功)
conversation.item.create 送信成功 → response.create 送信成功
R2 が 2回目の search_meal_candidates C2 を要求 → C2 も成功
function_call_output 送信成功
continuation_suppressed reason=guard        ← ここで止まる
（約21秒）
watchdog.fire status=no_continuation
UI「応答に失敗しました」
再試行 → C3 成功 → 同じ guard → 再び約21秒後に失敗
```

- `response.status=failed` は**発生していない**
- tool 実行も tool output 送信も**成功している**
- **エラーUIの直接原因は、guard が最終応答の生成を止めたこと**

### 20.2 読み取り調査で判明した guard の正体

| 問い | 答え |
|---|---|
| guard の条件 | `continuationsRequested === 0 && activeResponseId === null` |
| 回数上限か、tool名か、引数signatureか | **回数上限のみ**。1ターンにつき1回。tool名・引数の判定は**どこにも無い** |
| `retry_requested` が戻すもの | phase / `activeResponseId` / `failure` / `waitingSince` |
| `retry_requested` が戻さないもの | **`continuationsRequested`**。だから再試行が同じ guard に必ず当たる |
| guard 発動後に `running_tool` に残る位置 | `deliverToolOutput` 内の早期 `return`（phase を変えない） |
| なぜ 21秒後に失敗するか | `running_tool` は `noContinuationMs`(20s) の監視対象。**設計上そうなる** |

つまり **1ターンで2回ツールを呼ぶと、最終回答が構造的に生成されない。**

### 20.3 ⚠️ C1/C2/C3 の引数は 比較不能

**引数はどこにも保存されていない。**

- `ai_tool_calls` に arguments 列が**無い**（`result` のみ）
- `/api/realtime/tool` は arguments を受け取るが**保存しない**
- 音声経路は `conversation_messages` に**一切書かない**

したがって、取得済みトレースの C1/C2/C3 が同一引数だったかは
**推測も再構築もしない。比較不能とする。**

今後の実行についてのみ、`arg-signature.ts` が
**値を保存せず** canonical 化 → digest → 比較のみを行い、
トレースには `args=SAME / DIFFERENT / FIRST / UNREADABLE` だけを残す。

### 20.4 修正 —— guard 発動後は必ず終端する

guard が止めるべきは**次のツール**であって**回答そのものではない**。
結果は既に手元にあるので、guard は「1回だけの強制最終回答」へ落ちる。

| 項目 | 内容 |
|---|---|
| `tool_choice` | **`'none'`** |
| instructions | 取得済み結果だけで回答を完成させる旨 |
| metadata | `{ purpose: 'forced_final' }` |
| 回数 | **commit 済みユーザーターンにつき最大1回** |

⚠️ **これらは推測で足していない。** インストール済み SDK の型
（`node_modules/openai/resources/realtime/realtime.d.ts`）で確認した:

- `RealtimeResponseCreateParams` に `tool_choice` / `metadata` / `instructions` が存在
- `ToolChoiceOptions = 'none' | 'auto' | 'required'`
- `ResponseCreateEvent` / `ResponseCancelEvent` に `event_id`、`ResponseCancelEvent` に `response_id`
- `RealtimeError` に `type` / `code` / `param` / `event_id`
- `status_details.reason` は `'turn_detected' | 'client_cancelled' | 'max_output_tokens' | 'content_filter'`

**新しい状態:**

```
running_tool --guard--> awaiting_forced_final --> forced_final_responding --> completed
                     \--(既に使用済み)--> unresolved（即時。20秒待たない）
                                          \--(ツールを再要求)--> unresolved
```

- 強制最終回答が**さらにツールを要求したら再帰せず停止**（`forced_final_looped`）
- どちらの終端でも `canRetry` は **false**。同じ道を辿らせない
- **「もう一度応答を試す」は、tool output 送信済みなら強制最終回答経路へ**
  （`retryShouldForceFinal`）。通常の tool 選択をやり直さない
- ターン予算の初期化は **`committed` のみ**。
  commit しない割り込み発話では予算を回復させない

### 20.5 修正 —— liveness の cancel/create 順序

トレース 13998ms で `response.cancel` と `response.create` が**同時刻に送信**、
対象 R3 の `response.done(cancelled)` は 14227ms（**229ms 後**）。
つまり**旧Responseが生成中のまま2本目を要求**していた。

> ⚠️ **このトレース自体は成功ケース。** 60秒無応答そのものは捕捉できていない。
> 競合が存在することは確認できたが、**過去の無応答の原因と断定はしない。**

修正後の順序:

```
1. response.cancel（response_id を指定）→ phase: cancelling_response
2. その ID に一致する response.done(cancelled) を待つ
3. → phase: awaiting_liveness_create
4. 中立応答の response.create を 1回だけ送信 → awaiting_liveness_response
5. response.created → response.done(completed) → completed
```

**Response を ID で相関させた。** active でも cancelling でもない `response.done` は
**現在のターンを変更しない**。トレース R2 で観測された
「activeResponseId が無い状態の done が listening→unresolved を起こす」も、
`completed` が `waitingSince` を null にして **watchdog を恒久解除する**経路も、
これで閉じる。`speech_started` は旧 responseId を捨てず
`interruptedResponseId` に保持する。

監視対象は明示的に限定した ——
`cancelling_response` / `awaiting_liveness_create` / `awaiting_liveness_response` /
`awaiting_forced_final` / `forced_final_responding` / `running_tool` など。
**通常の `listening` は無期限に許容**（連続会話では正常）。

### 20.6 `cancelWaiting=R4` について

旧トレースの `cancelWaiting=R4` は、当時の実装が
**`response.cancel` に対象 ID を指定しておらず**、診断側が固定文字列
`'unspecified'` を alias 名前空間（`R`）へ通していたため、
**実在しない Response と同じ採番系列に並んで見えていた**もの。

`R4` という Response は存在しない。**alias の付け方の問題**であって
状態管理の問題ではない。現在は `response.cancel` が実 ID を指定するため、
`cancelWaiting` は実在する Response の alias になる。

### 20.7 未解明のまま残すもの

**`response.done status=failed`（割り込み無しで 43ms 後に failed）は別経路。**
今回の guard 修正で原因を確定したことに**しない**。
`c6bac06` の診断（`status_details.type` / `reason` / `error.type` / `code` /
`param`、`error.event_id` 相関）で、**次に再発したときに判定する。**

### 20.8 テスト

**738件**（722 → 実装前 697 から +41）。

| ファイル | 内容 |
|---|---|
| `forced-final.test.ts` | 通常continuation / guard発動→強制最終1回 / `running_tool` に残らない / ループしない / 再試行が同じ停止を繰り返さない / 予算は commit で初期化 / 引数signature SAME・DIFFERENT |
| `liveness-ordering.test.ts` | cancel→matching done→create の順序 / 無関係な done が現在ターンを変えない / watchdog が解除されない / liveness 不着で復旧UI / 通常 listening は無監視 |
| `arg-signature` / `error-classify` / `event-log` | redaction（引数・結果・transcript・message が出力に現れない） |

既存の候補カード・`requestId`・at-most-once のテストはすべて維持。
