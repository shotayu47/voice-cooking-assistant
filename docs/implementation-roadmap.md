# 実装ロードマップ

長期実装の進捗記録。**GitHub とこのファイルが source of truth** です。
新しいセッションを開始したら、まずこのファイルと `git log` を読んで、
最初の未完了 PHASE から再開してください。COMPLETE の PHASE は作り直さないこと。

## 運用ルール

1 PHASE = 実装 → テスト → 修正 → progress 更新 → commit → push。
複数 PHASE をまとめて push しない。

品質ゲート（毎 PHASE）: `npm run typecheck` / `npm run lint` / `npm test`
数 PHASE ごと・最終: `npm run build` / `npm run audit:rls`

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
| 2 | 在庫残量の自然言語更新 | **COMPLETE** | `TBD2` | yes | なし | — |
| 3 | 「今あるもので何作れる？」強化 | NOT_STARTED | — | — | — | — |
| 4 | 食材・調味料の代替提案 | NOT_STARTED | — | — | — | — |
| 5 | 調理セッション・工程状態管理 | NOT_STARTED | — | — | — | — |
| 6 | 複数タイマー | NOT_STARTED | — | — | — | — |
| 7 | 調理中のトラブル対応 | NOT_STARTED | — | — | — | — |
| 8 | 分量の自動調整 | NOT_STARTED | — | — | — | — |
| 9 | 買い物リスト | NOT_STARTED | — | — | — | — |
| 10 | AI 買い物候補提案 | NOT_STARTED | — | — | — | — |
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
- **PHASE 3**: `search_meal_candidates` は在庫を返すだけ。分類と冷蔵庫整理モードが未実装。
- **PHASE 4**: プロンプトに記述はあるが**専用ツールが無い**。

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

## 次に実装する PHASE

**PHASE 3 — 「今あるもので何作れる？」強化**

再開手順:
1. `src/lib/ai/tools.ts` の `search_meal_candidates` を読む（現在は在庫を返すだけ）
2. 料理候補を次の分類で返せるようにする:
   - 今あるものだけで作れる
   - 調味料だけ追加すれば作れる
   - あと1品あれば作れる
   - あと2〜3品買えば作れる
   - 期限が近い食材を優先して消費できる
3. 「冷蔵庫整理」モードを追加（`days_left` が小さい食材と余り物を優先）
4. AI へ渡す在庫は**必要な情報だけ**に絞る（`publicItem` は既に整理済み）
5. 構造化出力（Zod で validate）してから UI に渡す
6. 新規テーブルは不要な想定。DB 変更なしで実装できるか先に検討すること
