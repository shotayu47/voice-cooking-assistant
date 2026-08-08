# PHASE 9 — 買い物リスト

**Status: 第1段階 実装済み（schema / service / テスト）。UI 未実装。migration 未適用。**

第1段階は「データと規則」だけを置く。UI は第2段階、実機 QA は UI 実装後。

---

## 1. スコープ

### 含めるもの

- 買い物項目の手動追加（名前は必須、数量・単位は任意）
- 購入済み／未購入の切り替え
- 項目の個別削除
- 購入済み項目の一括削除
- Supabase での永続化
- `user_id` と RLS によるユーザー分離

### 含めないもの

AI 候補提案 / レシート OCR / 購入履歴 / 在庫への自動登録 / バーコード /
音声操作 / 通知 / 下部ナビの変更 / UI 全般（第1段階では未実装）。

---

## 2. PHASE 10〜12 との境界

| 除外項目 | 属する PHASE | 今回やらないことの担保 |
| --- | --- | --- |
| AI 買い物候補提案 | 10 | `src/lib/ai/tools.ts` に**買い物ツールを追加していない**（13 ツールのまま） |
| レシート読み込み | 11 | 画像アップロード経路を作っていない |
| 購入履歴の保存・集計 | 12 | 購入済み項目は**削除する**。履歴テーブルを作っていない |
| 購入済み → 在庫へ自動登録 | 12 寄り | `inventory_items` への書き込みが 1 か所も無い |
| バーコード | 16 | — |

**将来の接続点は既にある。** `src/lib/meals/evaluate.ts` の
`MissingIngredient { name, reason, isStaple }` が「不足食材」を構造化して返しており、
PHASE 10 はこれを `createShoppingItem` に流し込む形になる。
`normalized_name` を在庫と同じ `normalizeIngredientName()` で作っているので、
その時に**2 つ目の「同じ食材」の定義を持ち込まずに済む**。これが今回の実装で
将来のために払っている唯一のコストである。

---

## 3. なぜ Supabase か

| 要件 | Supabase | localStorage |
| --- | --- | --- |
| 複数端末で同じリストを見る | ✅ | ❌ 端末ごとに別物 |
| 再ログイン後の復元 | ✅ `user_id` 紐付け | ❌ ブラウザを消せば消える |
| ユーザー分離 | ✅ RLS | ❌ 保証なし |
| PHASE 10〜12 との接続 | ✅ サーバー側から書ける | ❌ AI もレシートもサーバー処理 |

買い物リストは「家を出る前に書いて、店で開く」もので、**端末をまたぐことが
前提**のデータである。localStorage では上 4 行のいずれも満たせない。

> 注: PHASE 6 のタイマーは localStorage を使っている。「製品コードは
> localStorage を使わない」という規則は存在しないので、根拠にしていない。
> タイマーの残り時間は端末ローカルで完結する値であり、性質が違う。

---

## 4. データモデル

`public.shopping_items`（migration `0005_shopping_list.sql`）

| カラム | 型 | 意図 |
| --- | --- | --- |
| `id` | `uuid` PK | 既存全テーブルと同じ |
| `user_id` | `uuid not null references auth.users(id) on delete cascade` | 所有者。RLS の基準 |
| `name` | `text not null` | 唯一の必須入力 |
| `normalized_name` | `text not null` | `normalizeIngredientName()` の出力。在庫と同じ折りたたみ規則 |
| `quantity` | `numeric` null 可 | 「牛乳」だけ書くのが普通 |
| `unit` | `text` null 可 | **数量があるときだけ**許可 |
| `checked` | `boolean not null default false` | 購入済みフラグ |
| `checked_at` | `timestamptz` null 可 | 購入済みにした時刻。**購入履歴ではない**（PHASE 12 の領分） |
| `created_at` / `updated_at` | `timestamptz not null` | `set_updated_at` トリガを再利用 |

### CHECK 制約

| 制約 | 内容 |
| --- | --- |
| `shopping_items_name_not_blank` | `btrim(name) <> ''` |
| `shopping_items_normalized_name_not_blank` | 同上 |
| `shopping_items_quantity_positive` | `quantity is null or quantity > 0` — 0 個も負数も買い物の量ではない |
| `shopping_items_unit_needs_quantity` | `unit is null or quantity is not null` — 「g」だけでは何も伝わらない |
| `shopping_items_checked_at_matches_checked` | `checked` と `checked_at` が**双方向に**食い違わない |

### 並び順

**`sort_order` カラムは持たない。** 一覧順は `checked asc, created_at asc`
（未購入が上、古い順）。インデックス `(user_id, checked, created_at)` が
このクエリを端から端まで覆う。

手動並べ替えはスコープ外なので、採番と再採番のロジック・テストを抱えたまま
使わない可能性が高い。必要になったら `alter table` で足す方が安い。

---

## 5. RLS

`enable row level security` + 4 ポリシー。条件はすべて
`user_id = (select auth.uid())`。

| 操作 | 句 |
| --- | --- |
| select | `USING` |
| insert | `WITH CHECK` |
| update | **`USING` と `WITH CHECK` の両方** |
| delete | `USING` |

`update` に `WITH CHECK` が要るのは、`USING` が「どの行を更新してよいか」しか
決めないため。これが無いと、自分の行を**他人の `user_id` に書き換えて渡す**
ことができてしまう。

`delete` ポリシーを持つ点が `inventory_transactions`（追記専用・delete なし）
との違い。個別削除と一括削除の両方がスコープに入っているため必要。

ポリシーは `0001` と同じく `do $$ ... drop policy if exists ...` で冪等にした。

### サービス層でも `user_id` を書く

`listShoppingItems` / `setShoppingItemChecked` / `deleteShoppingItem` /
`clearCheckedShoppingItems` は**すべて `.eq('user_id', ctx.userId)` を明示**する。
RLS が本当の境界だが、**一括削除が RLS だけに依存している状態は、ポリシー設定を
1 つ間違えた瞬間に全ユーザーのリストを消す**。条件を二重に書くのは意図的である。

`scripts/audit-rls.mjs` の `USER_TABLES` に `shopping_items` を追加した。

---

## 6. 重複の扱い

**DB に unique 制約を付けない。同名でも別項目として登録する。**

「卵 6個」と「卵 1パック」は別の行として正当で、統合すると**ユーザーが書いた
情報が消える**。単位が違えば合算もできない（`sameUnit('個','パック')` は false）。

代わりに `src/lib/shopping/dedupe.ts` が**検出だけ**する。

- `shoppingKey()` — `normalizeIngredientName()` で別名を解決し、`foldName()` で
  全角半角・大文字小文字・空白・区切り記号・ひらがな/カタカナを吸収する
- `findDuplicates()` — 同じキーの**未購入**項目を返す
- **購入済みは重複候補から除外する。** 一度買ったものを次の買い物でまた買うのは
  正当で、警告する理由がない
- 一致が複数あれば全部返す。1 件と 2 件では言い方が変わるので、文言は呼び出し側に委ねる

`createShoppingItem` は `{ item, duplicates }` を返す。**`duplicates` は失敗ではなく
情報**で、行は必ず作られる。将来 UI はこれを使って
「『卵』はすでにあります。別項目として追加しました」と言える。

この抑制は既存の姿勢と一致している — PHASE 1 は導けない期限を推定せず、
PHASE 2 は聞いていない数量をでっち上げない。

---

## 7. 購入済み項目の扱い

**削除せず残し、`checked = true` にする。** 一覧では未購入の後ろに来る。

- 買い物中に「これ買ったっけ」を確認できることが価値
- 即時削除は誤タップが回復不能
- 一括削除がスコープにあるのは、**残ることが前提**だから

`checked_at` は「購入済みにした時刻」であって購入履歴ではない。一括削除で
行ごと消える。履歴として残すのは PHASE 12 の仕事。

---

## 8. UI 方針（第2段階で実装）

**入口はホーム画面と在庫画面。下部ナビは変更しない。**

`src/components/bottom-nav.tsx` は既に 5 項目を `flex-1` で等分している。
6 項目目を足すと iPhone SE 幅で 1 項目あたり約 62px になり、
アイコン（22px）とラベル（11px）のタップ領域が窮屈になる。

ホームは既に `SectionTitle` + 右上リンク（在庫 → `/inventory`、履歴 → `/history`）
というパターンを持っているので、同じ形で「買い物リスト」セクションを足せる。
在庫画面からも導線を置く（「切れてる」と気づく場所だから）。

到達性は 1 タップ遠くなる。「履歴」と入れ替える案はプロダクト判断として保留。

---

## 9. 実装した内容（第1段階）

| ファイル | 内容 |
| --- | --- |
| `supabase/migrations/0005_shopping_list.sql` | テーブル・CHECK 5 種・インデックス・トリガ・RLS 4 ポリシー |
| `src/types/domain.ts` | `ShoppingItem` 型を追加 |
| `src/lib/shopping/schemas.ts` | zod。名前必須・数量は正数・単位は数量とセット |
| `src/lib/shopping/dedupe.ts` | 純粋関数。`shoppingKey` / `findDuplicates` |
| `src/lib/shopping/service.ts` | `listShoppingItems` / `createShoppingItem` / `setShoppingItemChecked` / `deleteShoppingItem` / `clearCheckedShoppingItems` |
| `scripts/audit-rls.mjs` | `USER_TABLES` に `shopping_items` を追加 |

### テストで見つけた欠陥

`quantity` は `.optional().nullable()` なので、「数量なし」が **`undefined`
（フィールド省略）と `null`（フィールドを空に）の 2 通りで届く**。
最初の `refine` は `value.quantity !== null` しか見ておらず、
**省略された数量に単位だけを付けた入力が通っていた**（`{ name:'卵', unit:'個' }`
が行を作ってしまった）。両方の形を明示的に弾くよう修正し、
2 通りとも回帰テストに固定した。

DB の `shopping_items_unit_needs_quantity` は同じ入力を弾くので実害は
出なかったはずだが、エラーが Postgres の制約名で返る形になっていた。

---

## 10. 運用上の順序（重要）

1. **migration を適用する前に UI をデプロイしない。**
   テーブルが無い状態で一覧を読むと 42703 / 42P01 で画面が落ちる。
   第1段階に UI を含めていないのはこのため。
2. migration 適用は Supabase SQL Editor での**手作業**。
3. 適用後は `npm run check:migrations` で**実測**する。
   `npm run audit:rls` では適用状況は分からない（PHASE 5 で確認済みの教訓）。
4. `npm run audit:rls` は適用**後**に実行する。未適用のまま走らせると
   `shopping_items` が missing として落ちるが、それは正しい失敗である。
5. **実機 QA は UI 実装後**（第2段階）。第1段階には触れる画面が無い。
