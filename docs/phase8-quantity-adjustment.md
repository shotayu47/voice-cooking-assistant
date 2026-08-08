# PHASE 8 — 分量の自動調整

**Status: COMPLETE**

ロードマップ本体を汚さないため、PHASE 8 の設計記録はこのファイルに分離している。
概要と状態は `docs/implementation-roadmap.md` の PHASE 一覧を参照。

## 着手前に見つかっていた穴

調査で、PHASE 8 が埋めるべき欠陥が2つ見つかった。

1. **`get_current_cooking_step` が分量を返していなかった。** ツール説明には
   「時間・火力・分量を聞かれたらこれを使うこと」と書いてあるのに、返り値の
   `ingredient_refs` は**食材名の配列だけ**だった。つまり調理中に「これどれくらい
   入れる?」と聞かれたモデルは、会話履歴の記憶で答えるしかなかった。PHASE 4 で
   在庫について潰したのと同じ failure mode が、分量に残っていた。
2. **分量を変える経路が存在しなかった。** `recipes.servings` は保存されるだけで、
   読んでいるコードが1つも無かった。「4人分にして」に対応する仕組みが無い。

## 設計判断

### 規則はコード、文章はモデル（PHASE 1・7 と同じ形）

倍率の掛け算を散文に任せると2つの失敗が起きる。**誰も検算していない数字**
（300g × 1.5 = 400g）と、もっと悪い**加熱時間まで一緒に倍にする**こと。
前者は `scale.ts` の純粋関数へ、後者は「時間と火力は倍率変更しない」という
返り値の規則へ移した。

### 新規ツールを1つ追加した理由

PHASE 3・4・7 では既存ツールを拡張して新規追加を避けた。今回は追加している。
「分量を変える」という役割を持つ既存ツールが**存在しない**ためで、`create_recipe` に
相乗りさせると**モデルが全材料の数値を書き直す**ことになる。それはこのツールが
モデルから取り上げようとしている当の計算そのものになる。

### mode を明示する

`target_servings = null` に「上限を教えて」という別の意味を持たせず、
`mode: 'scale' | 'max_from_inventory'` を必須引数にした。null の含意は
モデルが取り違えやすい。

### migration を追加しない

`cooking_sessions.recipe_snapshot` は「調理開始時点のセッション専用コピー」として
既に存在する（元レシピを編集されても調理が壊れないための設計）。ここに
**optional な scaling metadata** を置けば新しいカラムは要らない。
PHASE 6 が既に手動作業待ちで止まっている状況で、手動適用が要る migration を
増やさない判断。

## 非破壊スケーリング

**`ingredients.amount` を上書きしない。** 上書きすると基準値が失われ、
2人分 → 4人分 → 3人分と変えたときに「4人分の値 × 3/4」という compounding が起きる。

```jsonc
// cooking_sessions.recipe_snapshot
{
  "servings": 2,
  "ingredients": [{ "name": "鶏もも肉", "amount": 300, "unit": "g" }],  // ← 常に基準のまま
  "scaling": { "baseServings": 2, "targetServings": 4 }                 // ← ここだけ書き換わる
}
```

表示・ツール結果・プロンプトは、すべて `scaleRecipe()` が
`amount × targetServings / baseServings` として**その場で導出**する。

| 操作 | 保存される scaling | 鶏もも肉の導出値 |
|---|---|---|
| 開始（2人分） | なし | 300g |
| 4人分に変更 | `{base:2, target:4}` | 600g |
| 3人分に変更 | `{base:2, target:3}` | 450g（900g にはならない） |
| 2人分に戻す | `{base:2, target:2}` | **300g ちょうど** |

### 後方互換

`scaling` が無い snapshot は「未調整」として読む
（`baseServings = servings` / `targetServings = baseServings`）。
PHASE 8 以前に開始されたセッションはすべてこの形であり、1つも壊れない。
`servings` が 0 や負など壊れた値でも 1 にフォールバックする。

回帰テスト: `scale.test.ts`「reads a snapshot written before PHASE 8」、
`amount-prompt.test.ts`「reads a pre-PHASE 8 snapshot without scaling metadata」。

## 丸めない・推測しない

### 端数は保持する

卵1個（2人分）を3人分にすると **1.5個**。これを2個に丸めると、断りなく
レシピを半個分変えたことになる。`formatAmount` は `1と1/2個` と表示し、
プロンプトが「溶いて半量使う」のような現実的な方法を答えるよう指示している。

表示の整形もここに入れた: `大さじ2`（`2大さじ` ではなく）、`1と1/2`、`1/3`。
ただし**ユーザーが書いた 0.33 は 1/3 に直さない**。近いだけの数を「本当はこう
だろう」と書き換えるのは、静かに数字を変えることになる。

### pan_bound は名前で断定しない

「油」は揚げ油なら鍋依存、炒め油 大さじ1 なら比例できる。名前だけからどちらかを
推測するのは、まさに静かに間違った数字を作る経路なので、**確実に判定できる名前
だけ**の小さなリストにした（`揚げ油` `ゆで湯` など）。リストに無いものは linear。
追加はコードレビューの判断（PHASE 7 のトラブル対応表と同じ運用）。

初版の方針:

| 入力 | 扱い |
|---|---|
| numeric amount | 原則 linear |
| `amount: null`（適量・少々） | 数値を生成しない。素通し |
| 特殊な非比例 | 確実に判定できるものだけ |

### 単位換算は同一次元のみ

`g↔kg` `ml↔L` `大さじ↔ml`（大さじ=15ml は定義）は決定論的に換算する。
**`g↔ml` は換算しない** — 密度が要る。小麦粉200gと200mlは別物なので、
比較不能として `unit_mismatch` を返す。`個↔枚` のような数え単位も、
文字列として同一のときだけ 1:1 で比較する。

## 在庫上限は「断定しない」構造にした

「最大4人分作れます」と言い切るために、確認できなかった食材を黙って除外するのは
**誰も検証していない事実の上に立った自信のある回答**になる。返り値の形で防いだ。

| フィールド | 意味 |
|---|---|
| `capacity_status` | `exact`（全必須材料を実在庫と照合済み）/ `partial`（一部確認できず）/ `unknown`（何も照合できず。上限を答えない） |
| `max_servings` | `unknown` のときは null。推測値を入れない |
| `limiting_ingredient` | 最初に尽きる食材、または不足している食材（`absent` / `out_of_stock` / `expired` を区別） |
| `unverified_constraints` | 確認できなかった食材と理由（`no_amount` / `not_tracked` / `unit_mismatch` / `ambiguous`） |
| `capped_at_max` | 在庫上はもっと作れるが schema 上限20人分で頭打ち |

プロンプト側でも「`capacity_status` が exact でないときは断定しない」を指示している。
実測でも、醤油が「1本」で数量不明なケースは `partial` になり、
`unverified_constraints` に載る。

判定は必須材料のみ。任意材料（`required: false`）の在庫切れで夕飯は止まらない。
消費期限切れ（`use_by`）は在庫と数えない — PHASE 3 の `evaluate.ts` と同じ規則。

## already_added は used_ingredients が第一情報源

調理途中で人数を変えられたとき、**すでに鍋に入った分は戻せない**。
だから合計ではなく差分を答える必要がある。

優先順位:

1. **`used_ingredients`** — PHASE 5 が「在庫を減らした瞬間」に記録している実績。
   数量と単位が揃っていれば `必要量 − 使用量 = 残り` を計算する。
2. **`completed_steps`** — 補助情報。工程が完了していることは「何かを入れた」証拠
   ではあるが、**どれだけ入れたかは何も言っていない**。`status: unknown` を返す。
3. **判断できなければ断定しない** — 単位が合わない記録、`適量` の材料は
   `remainingAmount: null` で unknown。

```
必要 600g（4人分）/ 記録 200g  →  status: partially_added, remaining: 400g
必要 300g / 工程0が完了・記録なし →  status: unknown（量は聞き返す）
記録が「1枚」で必要が「g」        →  status: unknown（換算しない）
```

記録とレシピの名前が違っても、`inventoryItemId` の一致か、アプリ共通の
名前正規化（`normalizeIngredientName` + `foldName`、PHASE 2〜4 と同じ）で照合する。
「たまねぎ」の消費記録は「玉ねぎ」の材料に紐づく。

## 加熱時間・火力

**自動で倍率変更しない。そして「必ず長くなる」とも言わない。**

倍量にしたときに時間がどう動くかは、鍋の大きさ・食材の重なり・厚みで変わり、
アプリからは見えない。だから返すのは倍率ではなく規則:

> 加熱時間と火力は自動で倍率変更していません。量・鍋の大きさ・食材の厚みによって
> 変わるため、火の通りを確認しながら調整し、必要なら分けて調理してください。

2倍以上のときは鍋の容量についても添える（詰め込むと焼けずに蒸れる）。
`steps` は一切書き換えない。

## 実装

| ファイル | 内容 |
|---|---|
| `src/lib/recipes/units.ts`（新規） | 同一次元の単位換算、`formatAmount`（分数表示・大さじ前置） |
| `src/lib/recipes/scale.ts`（新規） | scaling metadata の解決、`scaleRecipe`、非スケール規則の文言 |
| `src/lib/recipes/capacity.ts`（新規） | `maxServingsFromInventory`、`ingredientProgress` |
| `src/types/domain.ts` | `Recipe.scaling?`（optional。後方互換） |
| `src/lib/cooking/service.ts` | `setSessionServings` — scaling だけを更新 |
| `src/lib/cooking/steps.ts` | `stepIngredientDetails` を追加。`ingredientsForStep` は整形を共通化 |
| `src/lib/ai/tools.ts` | `adjust_recipe_amounts` を追加。`get_current_cooking_step` が分量と人数を返すように |
| `src/lib/ai/prompt.ts` | 【分量】（常時）と【調理中に分量を変えられたら】（セッション時のみ） |

すべて純粋関数側に規則があり、I/O は service 層だけが持つ。

### UI

初版では**人数ステッパーを追加していない**。分量変更は音声・チャット経由のみ。
調理中に指で人数を変えられる導線は誤操作の入り口でもあり、まず AI 経由の
挙動を実測してから判断する。

表示整形の改善だけ入れた: 工程の材料表示が `scaleRecipe` 経由になったので、
調整済みセッションでは**画面とアシスタントの答えが同じ計算から出る**。

## テスト

| ファイル | 件数 | 内容 |
|---|---|---|
| `src/lib/recipes/units.test.ts` | 14 | 同一次元換算・**g↔ml を拒否**・数え単位・分数表示・0.33 を丸めない |
| `src/lib/recipes/scale.test.ts` | 19 | 基準を書き換えない・2→4→3→2 が元に戻る・端数保持・適量素通し・pan_bound・**時間が変わらない**・後方互換 |
| `src/lib/recipes/capacity.test.ts` | 21 | exact/partial/unknown・律速食材・absent/out_of_stock/expired・単位不能→unverified・used_ingredients 優先・差分計算・completed_steps は unknown |
| `src/lib/ai/amount-prompt.test.ts` | 12 | 規則の注入範囲・mode の enum・realtime への露出 |
| `src/lib/ai/amount-tool.test.ts` | 12 | 実ディスパッチ経由。永続化・**基準が残ること**・再調整で compounding しないこと・不正人数の拒否 |

合計 316件（PHASE 7 時点 238 → +78）。

live: `src/lib/ai/amount-live.check.ts` 4件（`npm run test:live`）。

## 実データ検証（済み）— 変更前後の比較

同じ発話を、PHASE 8 の規則とツール**あり／なし**の2通りで実際のモデルに投げた。

| 発話 | 変更前 | 変更後 |
|---|---|---|
| やっぱり4人分にしたい。材料の分量教えて。 | `get_current_cooking_step` を呼ぶ（当時は分量を返さないツール）。本文なし | `adjust_recipe_amounts(mode: scale, target_servings: 4)` |
| 今ある鶏肉で何人分作れる？ | `get_current_cooking_step`（在庫を見ないツール）。本文なし | `adjust_recipe_amounts(mode: max_from_inventory)` |
| 3人分にして。卵は何個いる？計算して教えて。 | `get_current_cooking_step`。本文なし | `adjust_recipe_amounts(mode: scale, target_servings: 3)` |
| 倍の量にしたら、8分焼くところは16分焼けばいい？ | 「単純に倍にすればいいわけではありません」＋厚み・鍋・火の通りの確認 | 同趣旨。「必ず2倍になるとは限りません」＋分けて焼く提案 |

**変更前の本質的な問題は、分量の質問が全部 `get_current_cooking_step` に落ちて
いたこと。** そのツールは当時**分量を返していなかった**ので、モデルは手元に数値が
無いまま答えることになる。4件中3件がこれだった。

4件目（時間の倍化）は**変更前から正しく答えていた**。既存プロンプトの安全側の
指示が効いていた形で、PHASE 8 で改善したわけではない。ただし変更前は暗黙の
振る舞いであり、変更後は「時間と火力は倍率変更しない」が規則として明文化され、
テストで固定されている。

## 既知の限界

- **`adjust_recipe_amounts` を呼ぶことはプロンプトの指示であり、サーバー側の強制
  ではない。** 実測では4件中3件で呼ばれたが、PHASE 5 の二重実行ガードのような
  構造的防御ではない。モデルが呼ばずに暗算した場合、サーバーは検知できない。
- **基準レシピの分量そのものはモデルの申告に依存する。** サーバーが権威を持つのは
  「与えられた基準からの導出」まで。PHASE 3 の「材料リスト自体はモデル依存」と
  同種の境界。
- **セッションの分量は snapshot の scaling にしか無い。** 元レシピ行
  （`recipes.ingredients`）は基準のまま残るが、セッション側で「以前は何人分だったか」
  の履歴は持たない。必要になったら監査ログの設計に合わせて足す。
- **`大さじ = 15ml` / `カップ = 200ml` は日本の標準計量。** 海外レシピを取り込む
  ようになったら（PHASE 11 のレシピ読み込み等）、前提を見直す必要がある。
- 在庫上限は必須材料のうち**数量が記録されている食材**しか制約にできない。
  `capacity_status` で開示しているが、多くの調味料が数量未記録の家庭では
  `partial` が既定になる。

## 検証環境の注意（PHASE 8 で判明）

`npm run test:live` は 4 ファイル並列で実行されると、OpenAI アカウントの
**TPM 上限（30,000）を1分以内に超えて 429 で落ちる**。挙動の問題ではないのに
挙動のテストが落ちる。

原因は**並列実行だけ**だった。直した箇所も1つだけ:

- `vitest.live.config.mts` に `fileParallelism: false`

`maxRetries` は全ファイル **2 のまま**（既定値を変更していない）。
一度 5 まで上げて通したが、`fileParallelism: false` だけで通ることを確認したため
戻した。`trouble-live.check.ts`（PHASE 7）は origin/main と完全に同一。

現在の live check のAPI使用量:

| ファイル | テスト数 | OpenAI 呼び出し | 備考 |
|---|---|---|---|
| `realtime-live.check.ts` | 1 | 1 | セッション発行 |
| `trouble-live.check.ts` | 3 | 3 | 1テスト1呼び出し。重複なし |
| `amount-live.check.ts` | 4 | 4 | 1テスト1呼び出し。重複なし |
| `backfill-expiry.check.ts` | 1 | 0 | Supabase のみ |

1呼び出しあたりシステムプロンプト＋ツール定義で約4,000トークン。直列なら
合計 約30,000トークンが 25〜40秒に分散するため、テスト間の待機は要らない。
並列だとこれが数秒に集中して上限を超える。

`npm run test:live` は 4ファイル9件が通る（連続2回実測。所要 39秒 / 24秒）。

## migration

**なし。** PHASE 8 はスキーマを変更していない。`npm run check:migrations` は不要。
