# 実装ロードマップ

プロダクト名は **TSUGU**（確定・全て大文字）。由来と改名手順は「プロダクト名」の節を参照。

長期実装の進捗記録。**GitHub とこのファイルが source of truth** です。
新しいセッションを開始したら、まずこのファイルと `git log` を読んで、
最初の未完了 PHASE から再開してください。COMPLETE の PHASE は作り直さないこと。

## 運用ルール

1 PHASE = 実装 → テスト → 修正 → progress 更新 → commit → push。
複数 PHASE をまとめて push しない。

品質ゲート（毎 PHASE）: `npm run typecheck` / `npm run lint` / `npm test`
数 PHASE ごと・最終: `npm run build` / `npm run audit:rls`
migration を伴う PHASE: `npm run check:migrations`（`audit:rls` では適用状況は分からない）

## この環境の注意点

**シェルは PowerShell。** `curl` は `Invoke-WebRequest` のエイリアスなので、
Linux 形式の `curl -H "key: value"` は `Headers` のバインドに失敗する。
REST を直接叩くなら `curl.exe` か `Invoke-RestMethod -Headers @{ key = 'value' }`。

`.env.local` は PowerShell の環境変数には自動ロードされない。`$env:SUPABASE_URL` は
空のまま。付属スクリプト（`check:migrations` / `audit:rls`）は `.env.local` を
直接読むのでそのまま動く。**鍵の値をログに出さないこと。**

## プロダクト名：TSUGU（確定）

正式名称は **TSUGU** に決定した。表記は**すべて大文字で統一**する。

由来は「**継ぐ**」。このアプリの中核価値が、台所の記憶を保持して次へ引き継ぐことだから:

- 家にある食材・調味料の状態を覚えている
- 前回の状態を次回へ引き継ぐ
- 調理中の現在工程・完了工程を覚えている
- 「次は？」だけで調理を続けられる
- 使用した食材を次の在庫状態へ反映する

再検討は不要。別候補の提案も不要。**TSUGU で確定**。

### 名称変更の作業方針

**表示名から安全に変更する。内部識別子は必要性を判断してから。**
外部サービス名は影響を確認して別途。「名称変更だから」という理由だけで
機械的に変えないこと。

#### 第1段階：表示名のみ **COMPLETE**（`534311b`）

変更前: 表示名 `料理アシスタント` / `short_name` `料理` /
`appleWebApp.title` `料理`

| ファイル | 変更内容 |
|---|---|
| `src/app/layout.tsx` | `title` / `applicationName` / `appleWebApp.title` → `TSUGU` |
| `src/app/manifest.ts` | `name` / `short_name` → `TSUGU` |
| 各ページの `metadata.title` | `... \| 料理アシスタント` → `... \| TSUGU`（8ファイル） |
| `src/app/login/page.tsx` | `<h1>` のロゴテキスト → `TSUGU` |
| `README.md` | 見出し → `TSUGU`。内部識別子を変えない理由も明記 |

##### 変更しなかったもの（判断を残す）

| 対象 | 現在値 | 理由 |
|---|---|---|
| `description`（layout / manifest） | `冷蔵庫の中身を知っている料理の相棒` | **ブランド表記を含まない**。旧名の痕跡ではなく紹介文なので、名称変更を理由に書き換える必要がない |
| ログイン画面のサブコピー | `冷蔵庫の中身を覚えている、料理の相棒。` | 同上 |
| `src/lib/ai/prompt.ts` の `家庭料理専用の音声・テキスト料理アシスタント` | 変更なし | **役割の説明であってアプリ名ではない**。システムプロンプトの変更は AI の応答挙動を変えるため、表示名変更の範囲外 |
| `package.json` の `name` / ディレクトリ名 / GitHub / Vercel / Supabase / 認証クッキー / DB / PWA `start_url` | すべて `voice-cooking-assistant` 系のまま | 第2・第3段階および「触ってはいけないもの」を参照 |

⚠️ `manifest.name` / `appleWebApp.title` を変えても**インストール済み PWA には即反映されない**。
ホーム画面のラベルは再インストールまで旧名のまま残ることがある（同一性は壊れない）。
`start_url` は変えていない（変えると別アプリ扱いになる）。

#### 第2段階：内部識別子（必要性を判断してから／変更不要の可能性が高い）

| 対象 | 現在 | 判断 |
|---|---|---|
| `package.json` の `name` | `voice-cooking-assistant` | npm 公開しないので外部露出なし。**変える利点がない** |
| ローカルディレクトリ名 | 同上 | ローカルパス・Vercel 設定・作業スクリプトが壊れる。**変えない方がよい** |

#### 第3段階：外部サービス（表示名変更とは分離。影響確認が先）

| 対象 | 影響 |
|---|---|
| GitHub リポジトリ名 | 旧URLは自動リダイレクトされるが、Vercel 連携の再設定が要る場合あり |
| Vercel プロジェクト名 | **公開URLが変わる**。iPhone のホーム画面アイコン／ブックマークが切れる |
| Supabase プロジェクト表示名 | 表示のみ。**プロジェクト参照ID（URL）は変わらない**ので安全 |

#### 触ってはいけないもの

| 対象 | 理由 |
|---|---|
| Supabase 認証クッキー `sb-<project-ref>-auth-token` | **アプリ名ではなくプロジェクトIDから生成**される。改名の影響を受けない。手を出すと全ユーザーがログアウトする |
| DB のテーブル名・カラム名 | アプリ名を含まない。変更する理由がない |
| PWA の `start_url` / スコープ | 変えると別アプリ扱いになり、インストール済みの同一性が壊れる |

**既存ユーザーデータ・認証・PWA の同一性・Vercel 公開URL を壊す可能性のある変更は、
名称変更だからという理由だけで機械的に行わないこと。**

#### 調査済みの事実

改名でユーザーデータが失われる経路はない。`localStorage` を使うのは以下だけで、
どちらも真実は DB 側にあるか、失っても再開できるものだけを持つ。

| キー | 用途 | 失われた場合 |
|---|---|---|
| `tsugu:timers:v{n}:{userId}:{sessionId}` | PHASE 6 の複数タイマー（deadline のみ） | 実行中のタイマーが消える。調理セッション自体は DB が真実なので無傷 |
| `tsugu-diag:*`（2キー） | `/diagnostics/timer` の計測用。製品データではない | 影響なし。ページごと削除してよい |

タイマーのキーには**スキーマ版・ユーザーID・調理セッションID**が入る。改名で
プロジェクト名を変えてもこのキーは変わらない（`tsugu:` は固定文字列）。

---

## デプロイ構成

| 項目 | 状態 |
|---|---|
| GitHub | `shotayu47/voice-cooking-assistant` |
| 本番ブランチ | `main` |
| Vercel 連携 | ✅ **確認済み** — push ごとに GitHub Deployment が作られ success |
| iPhone で開く URL | `https://voice-cooking-assistant-focb.vercel.app`（200 で配信を実測） |

確認方法（推測禁止・実測のみ）: GitHub Deployments API。Vercel は push ごとに
GitHub Deployment を作るので、そこに実際の deployment URL と state が載る。

```bash
curl -s https://api.github.com/repos/shotayu47/voice-cooking-assistant/deployments
```

### ⚠️ Vercel プロジェクトが2つある

同じリポジトリから**2つの Vercel プロジェクトが二重にデプロイ**している。

| プロジェクト | 最新コミット | 公開URL |
|---|---|---|
| `voice-cooking-assistant` | 最新に追従 | 302（認証壁）・`voice-cooking-assistant.vercel.app` は404 |
| `voice-cooking-assistant-focb` | やや遅れることがある | **200 で公開中**（これが実際に開ける方） |

弊害: push ごとにビルドが2回走る／どちらが本番か曖昧／最新コードを持つ方が
公開されていない。**Vercel ダッシュボードで片方を削除**するか、最新に追従する
方にドメインエイリアスを付けるのが望ましい（ユーザー操作が必要）。

必要な環境変数（Vercel 側にも同じものを設定。値はここに書かない）:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY   （または NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY）
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
OPENAI_MODEL                    （任意 / 既定 gpt-4.1）
OPENAI_REALTIME_MODEL           （任意 / 既定 gpt-realtime）
```

---

## PHASE 一覧

| # | 機能 | 状態 | Commit | Push | Migration | 適用 |
|---|---|---|---|---|---|---|
| 1 | 消費期限・賞味期限管理 | **COMPLETE** | `24f5980` | yes | `0003_expiry_tracking.sql` | ✅ 適用済み |
| 2 | 在庫残量の自然言語更新 | **COMPLETE** | `d9da9ce` | yes | なし | — |
| 3 | 「今あるもので何作れる？」強化 | **COMPLETE** | `8e8891a` | yes | なし | — |
| 4 | 食材・調味料の代替提案 | **COMPLETE** | `e67a0f4` | yes | なし | — |
| 5 | 調理セッション・工程状態管理 | **COMPLETE** | `a7623cb` | yes | `0004_cooking_progress.sql` | ✅ 適用済み |
| 6 | 複数タイマー | **COMPLETE** | `7b36eb8`..`6f71618` | yes | なし | — |
| 7 | 調理中のトラブル対応 | **COMPLETE** | `bfa1dbe` | yes | なし | — |
| 8 | 分量の自動調整 | **COMPLETE** | `4bdf619` | no | なし | — |
| 9 | 買い物リスト | **COMPLETE** | `014329b`..`ce4c627` | yes | `0005_shopping_list.sql` | ✅ 適用済み |
| 10 | AI 買い物候補提案 | IN_PROGRESS（10.1・10.2 完了、AI tool 配線は未着手） | — | — | なし | — |
| 11 | レシート読み込み | NOT_STARTED | — | — | — | — |
| 12 | 購入履歴 | NOT_STARTED | — | — | — | — |
| 13 | 献立計画 | NOT_STARTED | — | — | — | — |
| 14 | 料理履歴・お気に入り | NOT_STARTED | — | — | — | — |
| 15 | ユーザー好みの学習 | NOT_STARTED | — | — | — | — |
| 16 | バーコード読み取り | NOT_STARTED | — | — | — | — |

### 着手前の調査で分かったこと

PHASE 2 と 5 は**既存実装でほぼ達成済み**です。着手時は作り直さず、差分だけ埋めること。

- **PHASE 2**: `consume_inventory_item` / `find_inventory_item` / 音声 tool calling /
  冪等台帳 / 監査ログはすべて実装済み。不足は「卵あと2個」(残量の絶対指定) と
  「キャベツ半分使った」(分数指定) の解釈のみ。
- **PHASE 5**: `cooking_sessions` に `current_step` / `recipe_snapshot` / 再開 /
  二重実行防止まで実装済み。不足は完了工程の記録・使用食材の記録・工程スキップ。
- **PHASE 3**: COMPLETE。`search_meal_candidates` が5分類の判定材料と冷蔵庫整理モードを返す。
- **PHASE 4**: COMPLETE。find_inventory_item の複数名対応＋在庫スナップショットで対応。

---

## PHASE 1 — 消費期限・賞味期限管理

**Status: COMPLETE**

### 実装内容

在庫が「いつ切れるか」を、ユーザーが日付を入力しなくても分かる状態にした。

- `src/lib/inventory/freshness.ts`（新規・純粋関数）
  - 食材別・保存場所別の賞味期限テーブル（肉/魚/野菜/乳製品/調味料など約40品目）
  - カテゴリ単位のフォールバック
  - 開封後の短縮（牛乳7日 → 開封後3日 など）
  - 消費期限 (use_by) / 賞味期限 (best_before) の区別
  - 不明な食材は**推定せず null**（でっち上げない）
- migration `0003_expiry_tracking.sql`
  - `purchased_at` / `opened_at` / `expiry_kind` / `expiry_source`
  - `expiry_source`: `user`（パッケージ記載）/ `estimated`（アプリ推定）/ `unknown`
  - 既存行は `expiry_date` があれば `user` に移行
  - 部分インデックス `inventory_items_urgency_idx`
- `service.ts`: 作成・更新時に推定を自動適用。ユーザーが日付を入れたら `user` に昇格。
  保存場所や開封状態が変わったら推定を再計算。
- UI: ホームに「早めに使う食材」、在庫行に残日数、フォームに購入日・開封日・期限種別
- AI: `get_inventory` が `days_left` / `expiry_kind` / `expiry_is_estimated` を返す。
  プロンプトで「期限が近い順に使う」「推定は断定しない」を指示。

### 設計判断

推定値を**読み取り時に計算せず DB に書く**。理由: 「期限が近い順」がインデックス
レンジスキャンで済み、AI へ渡すデータも一貫する。代わりに `expiry_source` で
推定か実測かを必ず持ち回る。

**推定を実測として表示しない**ことを最優先。UI は `推定あと3日` と表示し、
編集フォームでは推定値を value ではなく placeholder に置く（未編集で確定値に
昇格させないため）。

### テスト

`src/lib/inventory/freshness.test.ts` — 19件（推定・別名解決・開封後短縮・
期限種別・不明食材で null・推定ラベル・日付演算）

### migration

✅ `0003_expiry_tracking.sql` は Supabase に**適用済み**（カラム4種・CHECK制約とも実測確認）。

既存行のバックフィルも実施済み（`src/lib/inventory/backfill-expiry.check.ts`）。
推定ロジックはアプリと同じものを使うので、賞味期限テーブルの真実は1箇所のまま。
再実行しても安全（日付が入っている行には触れない）。

```bash
npm run test:live   # backfill も含まれる
```

### 実データでの動作確認（済み）

- `add_inventory_item` で 鶏もも肉（冷蔵）を登録 →
  `expiry_date: 2026-08-09 / days_left: 2 / expiry_kind: use_by / estimated: true`
- ホーム画面が「早めに使う食材」に**推定あと2日**と注意書きを表示
- AI に「期限が近いものから使いたい」→ 期限順に並べ、消費期限/賞味期限を区別し、
  推定を「推定」と明示、期限情報の無い食材はそう答えた
- 醤油は開封済みのため 365日ではなく**開封後60日**で推定された
- 片栗粉は推定根拠が無いため**推定していない**（でっち上げない設計どおり）

---

## PHASE 2 — 在庫残量の自然言語更新

**Status: COMPLETE**

既存の `consume_inventory_item` / `find_inventory_item` / Realtime tool calling /
冪等台帳 / 監査ログをそのまま再利用し、**新しい AI 経路は作っていない**。
既存の `applyConsumption` に2つの言い方を足しただけ。

### 追加した解釈

| 言い方 | パラメータ | 動作 |
|---|---|---|
| 「あと2個」「残り300g」 | `remaining` | 減算ではなく**残量を設定**。上方修正も許可（冷蔵庫を見ているのはユーザー） |
| 「半分使った」「3分の1使った」 | `fraction` | 現在量の割合を消費。数量不明なら**数字をでっち上げず**あいまい状態を下げる |

優先順位: `consume_all` > `remaining` > `fraction` > `amount`。
単位不一致は全経路で `needs_clarification`（200ml を 個 から引かせない）。

### 実データ検証（済み）

- 「卵あと2個」→ 3個 → **2個**（`set_quantity`、delta -1）
- 「キャベツ半分使った」→ 1玉 → **0.5玉**（`decrease`、delta -0.5）
- 回帰: 「醤油使った」（量不明）は従来どおり拒否し在庫を変更しない
- 監査ログに `set_quantity` / `decrease` が `ai_text` で記録される

### 実テストで見つけて直したバグ

OpenAI の **429（TPM 制限）** でターンが 500 になる際、**ツールは既に実行済み**
＝在庫は減っているのに、ユーザーには一般的なエラーしか出ていなかった。
そのまま再送すると**二重に減算**される。

修正: 補完呼び出しが失敗しても、既にツールが走っていれば例外を投げず、
「在庫の変更は反映されました。同じ操作を繰り返すと二重になります」と
事実を返すようにした。あわせて `maxRetries` を 2 に引き上げ（ツールループは
短時間に複数回呼ぶため TPM に当たりやすい）。

### テスト

`quantity.test.ts` に14件追加（残量指定・割合指定・優先順位・境界・単位不一致）。
合計 136件。

---

## PHASE 3 — 「今あるもので何作れる？」強化

**Status: COMPLETE**

### 設計判断（方式の選択）

指示の優先順位（1: 既存経路の post-processing → 2: 共通 classifier → 3: 追加ツール）
に従い、**追加ツールは作らず**、既存の `search_meal_candidates` を2段階呼び出しに
拡張した。

- 1回目: `candidates: null` → 在庫・期限・余剰・不足調味料を返す（従来どおり）
- 2回目: モデルが考えた候補を `candidates` に入れて呼ぶ → **サーバーが実在庫と
  照合して分類を確定**して返す

なぜモデル呼び出し0回追加の純粋な post-processing にしなかったか:
`TurnResult` は自由文のみを返し、候補は構造化されていない。文章から候補を抽出するには
追加の構造化出力呼び出しが必要になり、抽出結果が実際に表示された文面とズレる危険がある。
既存ツールの入力を拡張する方が、往復を増やさず・ズレも生まない。

判定ロジックは `src/lib/meals/evaluate.ts`（純粋関数・I/Oなし）に切り出した。

### サーバーが確定するもの

モデルの自己申告は使わず、すべて実在庫から再計算する。

| 項目 | 実装 |
|---|---|
| 分類（作れる／調味料だけ／あと1品／2〜3品／非現実的） | `classifyMealCandidate` |
| 不足食材一覧 | `resolveInventoryItem` で実在庫に解決 |
| 不足の理由 | `absent` / `out_of_stock` / `expired` |
| 消費期限切れの除外 | サーバー規則。`use_by` 超過は在庫と数えない。`best_before` は数える |
| 期限が近い食材の消化 | `usesExpiringIngredient` |
| 冷蔵庫整理の並び順 | 期限消化を最優先に並べ替え |

`classifyMealCandidate` と `usesExpiringIngredient` は **production 経路から呼ばれる
ようになった**。`classification.test.ts` は死にコードのテストではなくなっている。

### 実データ検証（済み）

チャットで `search_meal_candidates -> search_meal_candidates` の2段階が走ることを確認。
ツールへ直接候補を投入した結果:

```
卵焼き       | fully_stocked | 今あるものだけで作れる
鶏の照り焼き  | staples_only  | 不足: 砂糖(在庫にない/調味料)  期限消化: 鶏もも肉
いなり寿司   | few_missing   | 不足: 米 油揚げ 酢(調味料)
肉じゃが     | not_feasible  | 不足: 牛肉 じゃが芋 玉ねぎ 人参
```

**油揚げが調味料扱いされていない**こと（34650a8 の修正）を live 経路で確認した。

### 既知の境界

サーバーが権威を持つのは**与えられた材料リストに対する判定**まで。材料リスト自体は
モデルの申告に依存する。実測では照り焼きを `["鶏もも肉","醤油"]` と申告し、砂糖・みりんを
挙げなかった。レシピ知識は指示どおり創造的領域として扱っているため設計上の許容範囲だが、
PHASE 2 の `spoken_name` と同種の限界であることは認識しておくこと。

UI カード表示は追加していない（今回の指示範囲外）。チャットの文章がサーバー判定を反映する。

### テスト

`src/lib/meals/evaluate.test.ts` 20件（分類5種・不足理由3種・消費期限除外・別名解決・
期限消化・並び順）+ `classification.test.ts` に接尾辞一致の回帰9件。合計 177件。

---

## PHASE 4 — 食材・調味料の代替提案

**Status: COMPLETE**

### 設計判断（方式の選択）

指示の優先順位に従い、**専用ツールは追加していない**。既存の `find_inventory_item` を
複数名対応にし、代替候補の在庫確認に転用した。

着手前に現状を実測したところ、「みりんない」に対して**ツールを一度も呼ばず**、
「砂糖やはちみつがあれば代用できます」と在庫を確認せずユーザーに投げ返していた。

### 実装

- `find_inventory_item` が `names: string[]` を受け取るようになった。代替候補を
  1回でまとめて在庫確認できる。単一名で呼ばれた場合の戻り値は従来形のまま。
- プロンプトに【代替食材】を追加。**在庫にあるものだけ**を提案すること、
  代替材料／使用量／味への影響／手順の変更 の4点を答えることを指示。
- システムプロンプトに**現在の在庫一覧**を載せるようにした（`renderInventory`）。
  テキストは毎ターン再構築されるので常に最新。音声は接続時固定なので
  「スナップショット」と明示し、変更前のツール再確認を指示している。
- 会話履歴を再生する際、**在庫を読むツールの過去結果を無効化**する
  （`redactStaleReads`）。`get_inventory` / `find_inventory_item` /
  `search_meal_candidates` が対象。`create_recipe` の recipe_id や
  `consume_inventory_item` の結果など「起きた事の記録」は消さない。

### 実測で見つけた本質的なバグ

砂糖を在庫に追加した**後**でも、モデルは「砂糖は在庫にありません」と答え続けた。
原因は会話履歴に残る2ターン前の `not_found` というツール結果。在庫読み取りの結果は
「その時点の事実」なのに、永続的な真実として再生されていた。

対策として上記の在庫スナップショットと履歴の無効化を入れた。

### 実データ検証（済み）

新しい会話で「みりんが切れてる。照り焼きどうすればいい？」:

```
tools: find_inventory_item
→ みりんの在庫はありませんが、料理酒と砂糖は在庫にあります。
  照り焼きの場合、みりんの代わりに「料理酒 大さじ1＋砂糖 小さじ1」を合わせて使うことで、
  みりん大さじ1分の甘みと照りをある程度再現できます。
  味はややさっぱりめになり、照りもやや控えめですが、仕上がりに大きな問題はありません。
  手順や加熱時間はそのままで大丈夫です。
```

要求された4点（代替材料・使用量・味への影響・手順の変更）がすべて揃い、
**在庫にある物だけ**から提案されている。一般的な代用品辞典ではなく、
いま作っている照り焼きに対する換算になっている。

代替品が本当に無い場合（砂糖も無い状態）も検証済み。「代用できる甘味料もありません」
と正しく答え、醤油だけで作った場合の味の変化と手順を説明した。

### 既知の限界

**長く続いた会話では、アシスタント自身の過去の発言が残り続ける。** ツール結果は
無効化できるが、「砂糖は在庫にありません」というアシスタントの文章そのものは履歴に残る。
実測では、汚染された会話で在庫を追加しても誤答が続き、会話を新しくすると正しく answered した。

通常利用では在庫変更もアシスタント経由で行うため自己矛盾しにくいが、
UI で「新しい会話を始める」導線があると確実。今回の指示範囲外なので未実装。

`HISTORY_LIMIT` は 60 のまま変更していない。

### テスト

`src/lib/ai/stale-reads.test.ts` 8件（在庫読み取りの無効化・記録の保持・
混在ターン・プロトコル構造の維持）。合計 185件。
---

## PHASE 5 — 調理セッション・工程状態管理

**Status: COMPLETE**

### 調査結果：大部分は既に実装済みだった

作り直さず、不足分だけ足した。既存の `cooking_sessions` はそのまま。

| 要件 | 状態 |
|---|---|
| 現在のレシピ | 既存 `recipe_snapshot`（開始時にスナップショット） |
| 現在の工程 | 既存 `current_step` |
| 残り工程 | 既存（導出） |
| アプリを閉じても復帰 | 既存（DB が真実、ホームに「調理中」カード） |
| タイマー | 複数タイマーは PHASE 6 で COMPLETE（localStorage に deadline を永続化） |
| **完了した工程** | **今回追加** |
| **使用済み食材** | **今回追加** |
| **工程スキップ** | **今回追加** |

### なぜ `current_step` だけでは足りないか

スキップができるようになると「現在の工程より前 = 完了」が成り立たなくなる。
飛ばした工程は「やった工程」ではない。そのため完了とスキップを別々の集合として持つ。

### migration 0004

`cooking_sessions` に追加（新規テーブルは作っていない。セッション行が復帰の単位なので
同じ行に置く方が既存設計と一貫し、JOIN も増えない）:

- `completed_steps integer[]` — 明示的に完了した工程
- `skipped_steps integer[]` — 意図的に飛ばした工程
- `used_ingredients jsonb` — この調理で実際に使った食材

CHECK 制約で両配列が `0 <= i < total_steps` に収まることを保証。
既存行は「スキップが無かった時代」なので、`current_step` より前を完了として backfill する。

### 実装

- `steps.ts` に純粋関数 `withStepMarked` / `withStepUnmarked` / `stepProgress` を追加。
  `withStepMarked` は**和集合**なので、二重タップや再送で同じ工程が二重記録されない。
- `moveStep` に `intent: 'done' | 'skip'` を追加。記録は**既存の条件付き UPDATE に相乗り**
  させたので、PHASE 2 で入れた二重実行ガード（`expectedStep` 条件・AI デバウンス）が
  そのまま記録にも効く。
- 最終工程は位置が動かないため従来は早期 return していたが、記録すべきものがある場合は
  UPDATE を実行するようにした（最終工程が完了として残らないバグを回避）。
- 完了として記録するとスキップ集合から外れる（同じ工程を「飛ばした」かつ「やった」に
  しない）。「戻る」はどちらの記録も変更しない。
- `consume_inventory_item` が成功し調理セッションが開いていれば、`used_ingredients` に
  追記する。**新しいツールは追加していない** — 在庫を減らす既存操作の副産物として記録する。
  これが「調理完了 → 使用食材を在庫から減算 → 料理履歴」を繋ぐデータになる。
- `advance_cooking_step` に `intent` を追加。専用の skip ツールは作っていない。

### UI

- 進捗バーを**工程ごとのセグメント**に変更。スキップがあると「何番目にいるか」と
  「どこまで進んだか」が一致しないため、1本のバーでは表現できない。
  現在＝アクセント／完了＝薄いアクセント／スキップ＝グレー／未着手＝背景色。
- 「この工程は飛ばす」を追加。**意図的に小さく副次的に**した。飛ばすのは正当な操作だが
  「できた」と間違えて押されてはいけないため。
- スキップ数がある場合のみ「N工程スキップ」を表示。

### テスト

- `steps.test.ts` に12件（和集合・重複排除・範囲外除去・完了がスキップに優先・空レシピ）
- `duplicate-guard.test.ts` に7件（完了記録・スキップ記録・**重複リレーで二重記録しない**・
  最終工程の記録・スキップ解除・戻るでは記録しない・進捗の反映）

合計 204件。

### migration

✅ `0004_cooking_progress.sql` 適用済み。

初回は CHECK 制約にサブクエリを書いてしまい `0A000: cannot use subquery in check
constraint` で失敗した。トランザクション全体がロールバックしたのでカラムは1つも
追加されなかった。CHECK 式自体にはサブクエリを書けないが、**サブクエリを含む
IMMUTABLE 関数を呼ぶことはできる**ため、範囲チェックを `int_array_within_bounds`
に移して解決した（`8d8c35f`）。

### 実データ検証（済み）

```
開始       step 2/7 | 完了:[0]     | スキップ:[]  | 残り:6
できた      step 3/7 | 完了:[0,1]   | スキップ:[]  | 残り:5
飛ばす      step 4/7 | 完了:[0,1]   | スキップ:[2] | 残り:4
できた      step 5/7 | 完了:[0,1,3] | スキップ:[2] | 残り:3
即・重複     step 5/7 | 完了:[0,1,3] | スキップ:[2] | 残り:3  ← デバウンスで無視
戻る       step 4/7 | 完了:[0,1,3] | スキップ:[2] | 残り:3  ← 記録は変わらない
```

使用食材も工程番号つきで記録された:

```json
{"name":"鶏もも肉","amount":200,"unit":"g","stepIndex":3,"inventoryItemId":"..."}
```

UI も実測: 7セグメントが 現在1／完了2／スキップ1／未着手3 で描画され、
「1工程スキップ」と `aria-label="7工程中3工程完了"` が出力されている。

### 検証手順の訂正

`npm run audit:rls` は RLS しか見ておらず、**migration の適用状況を確認できない**。
検証方法として案内したのは誤りだった。専用スクリプトを追加した:

```bash
npm run check:migrations
```

`.env.local` を直接読むのでシェルを問わず動く。鍵の値は出力しない。

⚠️ この環境は **PowerShell**。`curl` は `Invoke-WebRequest` のエイリアスなので
Linux 形式の `curl -H "..."` は動かない。REST を直接叩くなら `curl.exe` か
`Invoke-RestMethod -Headers @{...}` を使うこと。

---

## 自動実行タスク

Claude デスクトップアプリの Scheduled Tasks に2件登録済み。どちらも 0/5/10/15/20時。

| タスク | 用途 | 書き込み |
|---|---|---|
| `check-cooking-assistant-deployment` | 監視のみ（git / build / Vercel / migration / roadmap） | しない |
| `continue-cooking-assistant-development` | 次の未完了 PHASE を1つ実装 → 品質ゲート → commit → push | する |

### ⚠️ 重要な制約：クラウドだけでは動かない

Scheduled Tasks は **Claude アプリが起動している間にのみ実行**されます。
実行時刻にアプリが閉じていた場合は、**次回アプリ起動時**に実行されます。

つまり「PC を閉じたままクラウド側だけで実装が進む」ことは**ありません**。
PC をスリープさせず Claude アプリを開いたままにしておけば、使用制限の解除後に
自動で次の PHASE へ進みます。

`continue-cooking-assistant-development` の絶対条件（タスク prompt に明記済み）:

- `.env*` や鍵を commit しない（staged diff を毎回シークレットスキャン）
- typecheck / lint / test / build のいずれかが落ちたら **main へ push しない**
  （代わりに `wip/phase-N-*` ブランチへ退避し、roadmap を IN_PROGRESS にする）
- 未完了 PHASE を COMPLETE 扱いしない
- migration 未適用なら実装を止めて報告する
- 1回の実行で **最大1 PHASE**
- dev サーバーは必ずバックグラウンド起動 + PID 保持 + 明示的に kill

## 未解決事項

- Vercel プロジェクトが2つあり二重ビルドしている。最新を持つ方が非公開、
  公開されている方が遅れることがある。ダッシュボードで整理が必要（ユーザー操作）
- ブラウザペインは `visibilityState: hidden` で `requestAnimationFrame` が
  発火しないため、Suspense の再表示と prefetch が検証できない。実機確認が必要。
- 曖昧な食材指定（「鶏肉」で鶏もも肉と鶏むね肉がある）の最終防御は AI の
  自己申告に依存。監査ログで検出・修正可能。

---

## 並行作業の防止ルール

PHASE 3 で対話セッションと自動タスクが同じ PHASE を並行実装し、片方が無駄になった。
着手前にこのファイルで PHASE を **IN_PROGRESS 🔒** に変更し、commit/push してから実装すること。

自動タスクの判断ルール:
- 状態が **IN_PROGRESS 🔒** の PHASE には着手しない
- その次の未着手 PHASE にも着手しない（依存関係が崩れるため）
- 代わりに監視・回帰確認のみ行い、何もせず終了してよい
- 🔒 が24時間以上更新されていない場合のみ引き継いでよい

現在 🔒 の PHASE: **なし**。PHASE 6 の実測が完了し、ロックは解除済み。

PHASE 6 が実測待ちの間に PHASE 7 と PHASE 8 を先に完了させた。どちらもタイマーに
依存しない（PHASE 7 はプロンプトとトラブル対応表のみ、PHASE 8 は分量計算のみで
migration も無い）ため、実測結果による作り直しは発生しなかった。PHASE 8 の設計記録は
`docs/phase8-quantity-adjustment.md` に分離してある。

PHASE 6 の実測と実装は完了済み。次に着手できるのは **PHASE 10**。

## 次セッションで最初にやること

TSUGU への名称変更（第1段階：表示名のみ）は **COMPLETE**。
第2段階（内部識別子）と第3段階（外部サービス）は、必要性が生じるまで着手しない。

**PHASE 10 — AI 買い物候補提案** へ進む。

---

## PHASE 7 — 調理中のトラブル対応

**Status: COMPLETE**

### 設計判断（方式の選択）

指示の優先順位に従い、**専用ツールは追加していない**。migration も無し。
PHASE 1 の賞味期限テーブルと同じ形で、**トラブル対応表をコードに持たせて**
プロンプトに流し込む。文章はモデルが書き、**規則はサーバーが持つ**。

なぜ表をコードに置くか: リカバリ助言は「もっともらしい嘘」が実害になる数少ない領域。
生焼けの鶏肉を「見た目で大丈夫」と言う／燃えた油に水をかけさせる、はレビューと
テストが効く場所に置くべきで、モデルの一般知識に委ねる場所ではない。

### 実装

- `src/lib/cooking/trouble.ts`（新規・純粋関数）
  - 9項目の対応表: 焦げ / 生焼け / 味が濃い / 水っぽい / 固い / くっつく /
    順番間違い / 吹きこぼれ / 油の発煙
  - 各項目に **今すぐの動作 / 確認 / してはいけない / 元に戻せるか** を持たせる
  - `safety` は食品安全・火災に関わる2件（生焼け・油）だけに付ける。味とトレードしない
  - `renderTroublePlaybook()` でプロンプト用に描画
- `src/lib/ai/prompt.ts`
  - 【調理中のトラブル対応】ルールを追加
  - **調理セッションがある時だけ**対応表を注入する。在庫や献立のターンでは
    使い道がないのに毎回トークンを払うことになるため

### ルールの中心

**最初の1文は必ず「今すぐやる動作」。** ユーザーは鍋の前に立っている。
原因の説明・前置き・確認の往復を先に置かない。

**トラブル中は工程を進めない**（`advance_cooking_step` を呼ばない）。
トラブルの報告は進捗ではない。進めると、やり直すべき工程が失われる。

**元に戻せないものを戻せると言わない。** 失ったものを認めたうえで次善策を出す。

### 実データ検証（済み）— 変更前後の比較

同じ発話を、対応表**あり／なし**の2通りのプロンプトで実際のモデルに投げて比較した。

| 発話 | 変更前 | 変更後 |
|---|---|---|
| これ焦げそう | `get_current_cooking_step` を呼び「少しお待ちください」 | ツール0回・「火を止めて、すぐに中身を別の器やフライパンに移してください」 |
| しょっぱくなりすぎた | `get_current_cooking_step` →「少々お待ちください」 | 「火を止めて、それ以上調味料を足さないでください」＋在庫を見た薄め方 |
| 表面はいい色、中は赤い | 内容は正しいが説明から始まる | 「食べずに、弱めの中火で蓋をして加熱を続けてください」＝動作が先 |

**変更前の本質的な問題は「待たせたこと」だった。** 焦げそうだと訴えている相手に
ツールを1往復させて「少々お待ちください」と返している。3件中2件がこれだった。
対応表を入れた後はいずれもツール0回で、1文目が動作になっている。

3件目では在庫（鶏もも肉・醤油・酒）を見たうえで「今の在庫では追加の具材がありません」
と答えており、PHASE 4 の「在庫にあるものだけ」が効いていることも確認できた。

### テスト

- `src/lib/cooking/trouble.test.ts` 10件（id重複・必須項目・加熱系は火を止める・
  不明idはnull・安全項目の内容・描画に全項目が乗る・戻せない旨の明示）
- `src/lib/ai/trouble-prompt.test.ts` 6件（セッション無しでは注入されない・
  ある時は注入される・全項目が届く・工程を進めない指示・動作優先の指示・音声モードでも有効）
- `src/lib/ai/trouble-live.check.ts`（`npm run test:live`）3件 — 実モデルで
  「工程を進めない」「見た目で安全と追認しない」「薄める方向に答える」を実測

合計 238件。

### 既知の限界

対応表に無いトラブルは「まず火を止めるか弱める」という一般則しか持たない。
表の網羅性はコードレビューの対象であり、増やすときは `trouble.ts` に足せば
プロンプトとテストの両方に自動で反映される。

`advance_cooking_step` を呼ばないことはプロンプトの指示であり、サーバー側の
強制ではない。実測では守られたが、PHASE 5 の二重実行ガードのような構造的な
防御ではないことは認識しておくこと。

---

## PHASE 6 の事前計測（診断ページ）

**計測は 2026-08-08 に完了した（Test A〜F）。結果と判定は
`docs/phase6-timer-measurement.md` の「実測結果」にある。ロックは解除済み。**

計測用の診断ページ。**製品機能ではなく、削除してよい一時的なページ。**
PHASE 6 は完了したので、残しておく理由は Test F の再実施（PWA 通知の確認）だけ。

| 項目 | 内容 |
|---|---|
| URL | `/diagnostics/timer` |
| 配置 | `(app)` グループの外。下部ナビにもどこにもリンクしていない |
| 認証 | 既存の proxy でそのままゲートされる（`PUBLIC_PATHS` に入れていない＝**認証設定は無変更**） |
| SSR | `next/dynamic` の `ssr: false`。全部ブラウザ計測なので prerender しない |
| 保存領域 | `sessionStorage` / `localStorage` の `tsugu-diag:*` のみ。Supabase・DB・既存データには一切触れない |

測るもの: interval の実発火間隔と最大ギャップ、背面移行中の発火状況、復帰時の
「実経過 vs tick 由来の経過」、`Date.now()` と `performance.now()` のずれ、
visibilitychange / pagehide / pageshow / focus / blur / freeze / resume、
Notification API と permission、Service Worker の有無と登録状況、standalone 判定、
instance ID と起動回数による**プロセス破棄の検出**。

設計上の要点: 残り時間は必ず `deadline − Date.now()` から求める。
**interval の発火回数からは計算しない**（絞られた分だけ経過を取りこぼすため）。
tick 由来の経過は「比較用」として別に表示している。

通知の許可はページを開いただけでは要求しない（ユーザー操作のボタンからのみ）。
このページでは **Service Worker を登録しない**（存在の確認のみ）。

計測結果を根拠に、永続化方式（localStorage / deadline のみ）・通知方式（実装しない）・
複数タイマーの状態管理を決定した。詳細は「PHASE 6 — 複数タイマー」を参照。

---

## PHASE 6 — 複数タイマー（COMPLETE / `7b36eb8` + `6f71618`）

実測（`docs/phase6-timer-measurement.md`）で決めた設計をそのまま実装した。

| 決定 | 根拠となった実測 |
|---|---|
| `deadline − Date.now()` だけを時間の基準にする | 全テストで残り時間が正しかった |
| `performance.now()` を残り時間に使わない | Test C: 画面ロック中に停止、ずれ 113,815ms |
| tick 回数で経過を計算しない | Test B/C/D: 背面の発火は想定 176/193/1901 回に対し 2 回 |
| 復帰時に即再計算する | 同上。`visibilitychange` / `pageshow` / `focus` で `now` を取り直す |
| 通知を実装せず、権限も要求しない | Test E: Safari タブに Notification API が無い / Test F 未確認 |
| localStorage に永続化する | Test D では破棄されなかったが1回の観測。deadline から復元できる形にした |

実装の要点:

- 純粋ロジックは `src/lib/cooking/timers.ts`（I/O なし・36 テスト）。
- 保存キーは `tsugu:timers:v{version}:{userId}:{sessionId}`。スキーマ版・ユーザー・
  調理セッションで分離しているので、別ユーザー／別調理のタイマーは混ざらない。
- `useSyncExternalStore` で localStorage を真実にしている。プロセス再生成後の
  最初のレンダーで復元済みになり、復元用の effect を待つ必要がない。
- 復元時は1フィールドずつ組み直す。壊れたデータ・別スキーマ・1日以上前・
  期限を1時間以上過ぎたものは破棄され、画面には出ない。
- 完了したタイマーは localStorage から除去される（画面上は消すまで残る）。
- 工程画面のタイマー開始ボタンは残し、共通ストアへの入口にした。Provider は
  `page.tsx` にあり工程移動で再マウントされない。

### 積み残し（別タスク）

**PWA（standalone）での通知可否が未確認。** Test F はホーム画面アイコンから起動
したが、認証ゲートがログインページへリダイレクトして診断ページに到達できなかった。
iOS では Notification API は standalone の PWA でのみ露出するため、「iOS で通知は
不可能」と結論するのは誤り。**認証（`feature/auth-otp` の Email OTP）が解決したあとに
Test F を再実施して判断すること。** 通知は今の設計に対する純粋な追加層なので、
後から載せてもタイマー本体の作り直しは発生しない。

---

## PHASE 9 — 買い物リスト

**Status: COMPLETE**（2026-08-09）

設計と検証の記録は `docs/phase9-shopping-list.md` に分離してある。ここには結果だけ置く。

| 項目 | 結果 |
|---|---|
| 第1段階 | migration / schema / 純粋ロジック / service / テスト（`014329b`・`8376d0c`） |
| 第2段階 | `/shopping` 画面・Server Action・ホームと在庫からの導線（`cbcd38f`・`ce4c627`） |
| migration | `0005_shopping_list.sql` — **`npm run check:migrations` 5/5 適用済み** |
| RLS | **`npm run audit:rls` 43/43 PASS**。`shopping_items` は自前の被害者ユーザーと行を作って攻撃するため、空テーブルでも skip されない |
| テスト | 462件（PHASE 8 時点の 381 から +81） |
| **実機 QA** | **iPhone 実機 / Vercel Preview で 14/14 PASS**（2026-08-09・対象 `ce4c627`） |

設計上の要点（詳細は分離ドキュメント）:

- 保存先は Supabase。複数端末・再ログイン後の復元・RLS・PHASE 10〜12 との接続が理由
- **同名項目を統合しない。** 「卵 6個」と「卵 1パック」は別の行として正当で、
  統合はユーザーが書いた情報を捨てる。検出して知らせるだけにした
- 購入済みは削除せず残す。一括削除は別の意図的な操作
- **下部ナビは 5 項目のまま。** 導線はホームと在庫から。6 項目目は iPhone SE 幅で
  タップ領域が窮屈になる
- `normalized_name` は在庫と同じ `normalizeIngredientName()` で作る。PHASE 10 が
  「同じ食材」の 2 つ目の定義を持ち込まずに済む

⚠️ 確認したのは **Preview であって Production ではない**。main へ merge した後に
改めて確認が必要。

---

## 次に実装する PHASE

**PHASE 10 — AI 買い物候補提案**（PHASE 6・7・8・9 はいずれも COMPLETE。PHASE 10 自体は IN_PROGRESS — 10.3a で `search_meal_candidates` が読み取り専用の買い物候補を返すようになったが、選択・書き込みを呼ぶ経路と prompt/UI 配線が残っているため COMPLETE にしていない）

着手前に読むもの: `docs/phase9-shopping-list.md` の §2「PHASE 10〜12 との境界」。
PHASE 9 は `src/lib/ai/tools.ts` を**一切変更していない**（13 ツールのまま）。
接続点は `src/lib/meals/evaluate.ts` の `MissingIngredient { name, reason, isStaple }` で、
これを `createShoppingItem` へ流し込む形になる。

### PHASE 10 の小段階

| 小段階 | 内容 | 状態 |
| --- | --- | --- |
| 10.1 | `src/lib/shopping/candidates.ts` — `MissingIngredient[]` から重複を畳んだ候補リストを作る純粋関数。I/O なし、書き込みなし | ✅ 完了（#50 / PR #51） |
| 10.2 | `src/lib/shopping/add-candidates-core.ts` + `add-candidates.ts` — **明示的に選択された候補だけ**を `createShoppingItem` 経由で書き込む境界。`MissingIngredient[]` から自動で書く経路はない | ✅ 完了（#52） |
| 10.3a | `search_meal_candidates` の2回目（`candidates` あり）の各 `evaluated_candidates` に、その候補の `verdict.missing` を 10.1 の `missingIngredientsToShoppingCandidates()` に通した `shopping_candidates` を追加。読み取り専用（書き込みなし）。tool 数は13のまま | ✅ 完了（#54） |
| 10.4a | `src/lib/ai/prompt.ts` に `SHOPPING_CANDIDATE_RULES` を追加し、text/voice 共通の resolved instructions で「shopping_candidates は提案のみ・存在するだけでは add を呼ばない・明示選択／全件確定のときだけ書き込む・サーバー提供値の部分集合をそのまま使う・0件なら呼ばない・結果は事実どおり説明する」を明示。tool 定義・service 実行は無変更 | ✅ 完了（#66） |
| 10.4b 以降 | 買い物候補選択の UI、chat/voice 配線（未着手） | NOT_STARTED |

10.2 は「選択」の中身（誰が・どうやって選ぶか）には関与しない。選択された
`ShoppingCandidate[]` を受け取って書くだけで、候補生成（10.1）や選択 UI/AI
配線（10.3 以降）とは独立している。`shopping_items` への独自 insert は無く、
既存 `createShoppingItem` の validation・normalize・duplicate 検出をそのまま経由する。

10.3a は `search_meal_candidates` の結果を拡張しただけで、`createShoppingItem` /
`addSelectedShoppingCandidates` はまだどこからも呼ばれていない。source of truth は
サーバーが実在庫と照合した `verdict.missing`（`src/lib/meals/evaluate.ts`）のみで、
モデルから別の `MissingIngredient[]` を受け取る引数は追加していない。

