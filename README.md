# TSUGU

冷蔵庫の中身を覚えていて、1工程ずつ料理を案内するパーソナルアシスタント。
本リポジトリは **SPEC.md の Phase 1（テキスト MVP）と Phase 2（Realtime 音声）** の実装です。

プロダクト名は **TSUGU**（全て大文字）。由来は「継ぐ」— 台所の記憶を次へ引き継ぐこと。
リポジトリ名・パッケージ名・デプロイURL は `voice-cooking-assistant` のままです。
これらは既存の認証・デプロイの同一性に関わるため、表示名の変更とは分離しています
（`docs/implementation-roadmap.md` の「プロダクト名：TSUGU（確定）」を参照）。

## 設計の要点

在庫・調理進捗・会話は別々の状態として扱い、**永続状態は必ず Supabase に置く**。
LLM のチャット履歴は真実の情報源にしない（SPEC §1.3 / §13）。

```
src/
  app/
    (app)/            サインイン後の画面（下部ナビ付き）
    api/chat/         AI 1ターン分のエンドポイント（テキスト）
    api/realtime/     音声セッションの発行とツール実行（Phase 2）
    auth/callback/    マジックリンクの受け口
    login/
  components/         UI プリミティブとシェル
  lib/
    ai/               システムプロンプト・ツール定義・ツール実行ループ
    cooking/          工程の状態遷移（純粋関数）＋セッションサービス
    inventory/        数量計算・名寄せ（純粋関数）＋在庫サービス
    recipes/          レシピの検証と保存
    supabase/         SSR / ブラウザクライアント
    voice/            Realtime WebRTC クライアント（Phase 2）
  test/               Vitest 用のインメモリ Supabase スタブ
  types/              ドメイン型
supabase/migrations/  スキーマ・インデックス・RLS
```

DB アクセスは UI コンポーネントに書かず、`lib/*/service.ts` に閉じています。

## セットアップ

### 1. 環境変数

```bash
cp .env.example .env.local
```

| 変数 | 取得元 | 公開範囲 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API | クライアント可 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 同上 | クライアント可 |
| `SUPABASE_SERVICE_ROLE_KEY` | 同上 | **サーバー専用** |
| `OPENAI_API_KEY` | OpenAI dashboard | **サーバー専用** |
| `OPENAI_MODEL` | 任意（既定 `gpt-4.1`） | サーバー専用 |
| `OPENAI_REALTIME_MODEL` | 任意（既定 `gpt-realtime`） | サーバー専用 |

`OPENAI_API_KEY` と `SUPABASE_SERVICE_ROLE_KEY` は `NEXT_PUBLIC_` を付けていないため、
クライアントバンドルには入りません。AI 呼び出しは全て `src/app/api/chat/route.ts` 経由のサーバー実行です。

### 2. データベース

`supabase/migrations/0001_init.sql` を Supabase の SQL Editor に貼って実行するか、
Supabase CLI を使う場合は:

```bash
npx supabase link --project-ref <your-ref>
npx supabase db push
```

マイグレーションは **0001 → 0002 の順に両方** 適用してください。
0002 が未適用でもアプリは動きますが、サーバー側の重複実行防止が無効になります
（サーバーログに `migration 0002 not applied` が出ます）。

このマイグレーションで作られるもの:

- SPEC §6 の全テーブル（+ チャット履歴用 `conversation_messages`）
- 全ユーザー所有テーブルの RLS（`user_id = auth.uid()` / profiles は `id = auth.uid()`）
- `auth.users` への INSERT で `profiles` を自動生成するトリガー
- `current_step` を範囲内に閉じ込める CHECK 制約と、ユーザーごとに進行中セッションを1件に限る一意インデックス

### 3. 認証設定

Supabase → Authentication → URL Configuration で
`http://localhost:3000/auth/callback` を Redirect URLs に追加してください（本番URLも同様）。
メールテンプレートは既定のままで動きます（PKCE の `?code=` を受け取ります）。

### 4. 起動

```bash
npm install
npm run dev
```

## コマンド

```bash
npm run dev        # 開発サーバー
npm run build      # 本番ビルド
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest（純粋ロジック＋サービス層。ネットワーク不要）
npm run test:live  # 実 OpenAI API を叩く疎通チェック（.env.local が必要）
npm run audit:rls  # 実 DB に対して RLS を検証（別ユーザーで read/write/delete を試行）
npm run icons      # PWA アイコンを再生成
```

## Phase 2 — Realtime 音声

チャット画面と調理画面の「音声で操作」から、ハンズフリーで会話できます。

```
iPhone / PWA
  → POST /api/realtime/session   ← サーバーが ek_... の短命トークンを発行
  → WebRTC（SDP を api.openai.com/v1/realtime/calls へ）
  → データチャネル "oai-events" で function call を受信
  → POST /api/realtime/tool      ← 実行はサーバー側（認証・RLS・監査つき）
  → Supabase
```

**恒久 API キーはブラウザに出ません。** クライアントが受け取るのは短命トークンだけで、
instructions とツール定義はトークン発行時にサーバー側で固定されるため、
クライアントからアシスタントの行動規約を書き換えることはできません。

音声とテキストは**同じバックエンドツール**を使います（`realtimeToolDefinitions()` は
テキスト側の定義から生成され、テストで一致を強制）。したがって工程や在庫の真実は
常に1つで、SPEC §21.1 の「Text and voice must not maintain separate truths」を満たします。

音声由来の在庫変更は `inventory_transactions.source = 'ai_voice'` として記録されます。

### 重複実行の防止

同じ発話でツールが2回走ると、在庫が倍減ったり工程が2つ進んだりします。2層で防いでいます。

| 層 | 対象 | 依存 |
|---|---|---|
| クライアント | 同じ `call_id` の再実行、1ターン1工程移動まで | なし（常時有効） |
| サーバー | `ai_tool_calls` による冪等実行、AI発の工程移動を1.5秒デバウンス | migration 0002 |

テキスト側は1ターン内で同一の変更系ツールを1回しか実行しません。
UI のタップは `expectedStep` 付きの条件付き UPDATE なので、二重タップは0行マッチで無視されます。

### 対応コマンド（SPEC §21.3）

`今日なに作れる？` / `それ作る` / `次` / `できた` / `戻って` / `もう一回` /
`何グラム？` / `火力いくつ？` / `あと何分？` / `これ焦げそう` /
`玉ねぎ使い切った` / `卵あと2個` / `終了`

## ナビゲーション性能

認証は**ネットワーク往復なし**で解決します。プロジェクトは JWT を ES256（非対称鍵）で署名し
JWKS を公開しているため、`getClaims()` が公開鍵で署名をローカル検証できます。
`getUser()` は1回ごとに Auth サーバーへの往復が発生するため、ホットパスでは使いません。

```
proxy.ts          getClaims()  … 署名検証してリダイレクト判定（~2ms）
(app)/layout.tsx  認証なし      … proxy とページで担保。layout の await は children を止める
page              getServiceContext() → getAuthContext()（React cache でリクエスト内メモ化）
```

`getSession()` は**認可の判断には使いません**（署名を検証せずクッキーをデコードするだけ）。

セッション更新は維持されています。`getClaims()` は内部で `getSession()` を通り、
期限切れなら `_callRefreshToken` が走って新しいクッキーが `setAll` 経由で書き戻されます。

動的ルートの prefetch は `loading.tsx` の境界までしか行われないため、
5つのナビ先すべてに `loading.tsx` を置いています。これによりタップ直後にスケルトンが出ます
（prefetch レスポンスは 7〜12ms、DBクエリを含みません）。

### 計測

開発時のみ、オプトインで内訳を出せます（本番では何も出力せず、ユーザーIDや行の内容も出しません）。

```bash
PERF_LOG=1 npm run dev
```

## テスト方針

火力・数量・工程のようなルールは全て純粋関数に切り出し、Vitest で直接検証しています。
サービス層のテストは `src/test/fake-supabase.ts`（インメモリのクエリビルダ）を使い、
実 DB なしで「在庫を減らすと必ず監査ログが1行増える」といった不変条件を確認します。

RLS 自体は本物の Postgres でしか検証できないため、テストでは
「サービスが必ず `user_id` で絞っている」ことを確認する形にしています。

## 未実装（Phase 3 以降）

レシート/バーコード/写真入力、買い物リスト、期限アラート、栄養計算。
