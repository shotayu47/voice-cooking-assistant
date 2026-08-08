# 認証設計 — Email OTP

TSUGU のログインは **メールアドレス + 6桁の確認コード（Email OTP）** に統一する。
本ドキュメントは実装済みのコードが何をしているかの記録であり、方式の再検討ではない。

---

## 1. なぜ Magic Link をやめたか

Magic Link は「送信したブラウザと同じブラウザでリンクを開く」必要がある。
TSUGU の想定利用者はスマートフォンのメールアプリからリンクを開くため、
メールアプリ内蔵ブラウザ → Safari/Chrome の切り替えで PKCE の `code_verifier` を
持たないブラウザに着地し、ログインに失敗する事故が構造的に起きる。

6桁コードはブラウザをまたいでも成立する。
入力の手間は増えるが、`autocomplete="one-time-code"` により iOS / Android は
キーボード上部にコードを提示するため、実際のタップ数はほぼ変わらない。

---

## 2. フロー

```
[Step 1] メールアドレス入力
    └─ sendOtpAction  → supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
                        ※ emailRedirectTo は付けない
[Step 2] 6桁コード入力
    └─ verifyOtpAction → supabase.auth.verifyOtp({ email, token, type: 'email' })
                        → Cookie にセッションが書かれる
                        → safeNext(next) へ redirect
```

### emailRedirectTo を付けない理由

`signInWithOtp` に `emailRedirectTo` を渡すと、Supabase は
「リンク付きテンプレート」としてメールを描画する。コードを届けたいので付けない。
テンプレート側は `{{ .Token }}` を使う（§7 参照）。

### Server Action で実行する理由

コードはクライアント JS からではなくサーバーへ POST される。
検証結果の Cookie 書き込みも Server Action 内で完結するため、
ブラウザ側 Supabase クライアントがセッションを扱う経路を持たない。

実装は [`src/app/login/actions.ts`](../src/app/login/actions.ts)。

---

## 3. 所有者 ID の不変性（最重要）

`auth.users.id` は認証方式に依存しない恒久的な所有者 ID である。
Magic Link → Email OTP の切り替えは **同じ `auth.users` 行に対する別の入り口**を
増やすだけで、既存ユーザーの id は変わらない。したがって

- 在庫（`inventory_items.user_id`）
- プロフィール（`profiles.id`）
- RLS ポリシー（`auth.uid()` 基準）

はいずれも影響を受けない。**migration は不要**。

ライブ確認（[`scripts/dev-otp.mjs`](../scripts/dev-otp.mjs) を使用、メール送信なし）:

```
login 1 → user.id = 285fadf6-…
同じコードを再使用 → 403 Token has expired or is invalid（単回使用）
login 2 → user.id = 285fadf6-…   ← 同一
```

---

## 4. リダイレクト安全性

`next` パラメータは攻撃者が完全に制御できる。実装は
[`src/lib/auth/redirect.ts`](../src/lib/auth/redirect.ts) の `safeNext()`。

**「`/` で始まるか」で判定してはいけない。** WHATWG URL パーサは http(s) において
バックスラッシュをスラッシュとして扱うため、以下はすべて外部 origin に解決される:

| 入力 | 旧ガードの判定 | 実際の解決先 |
| --- | --- | --- |
| `//evil.example.com` | 拒否 | `https://evil.example.com` |
| `/\evil.example.com` | **通過** | `https://evil.example.com` |
| `/\/evil.example.com` | **通過** | `https://evil.example.com` |
| `\t//evil.example.com` | 拒否 | `https://evil.example.com` |

`safeNext()` は候補を実際に URL として解決し、**解決後の origin が期待 origin と
一致する場合のみ**通す。返り値は常に `pathname + search + hash`（相対パス）であり、
絶対 URL を返すことはない。テストは
[`src/lib/auth/redirect.test.ts`](../src/lib/auth/redirect.test.ts)（30 ケース）。

適用箇所:

- `src/app/auth/callback/route.ts` — 既存の open redirect 脆弱性を修正
- `src/app/login/page.tsx` — hidden input に入る前に無害化
- `src/app/login/actions.ts` — hidden input から戻ってきた値を再度無害化

---

## 5. /auth/callback を残す理由

Email OTP は callback を経由しない（Server Action で完結する）。それでも残す:

| クエリ | 用途 |
| --- | --- |
| `?code=` | 将来の OAuth（Google Sign-In）用の PKCE 経路 |
| `?token_hash=&type=` | 移行期間。切り替え前に送信済みの Magic Link メールを生かす |

エラー時は Supabase の生メッセージではなく **reason コード**を
`/auth/error?reason=…` に渡す。クエリ文字列は攻撃者が制御でき、
そのまま画面に描画されるため、文言はページ側が所有する。
生のエラーはサーバーログにのみ出る。

---

## 6. エラーメッセージの正規化

Supabase のエラーは英語かつ開発者向けなので、`error.message` を画面に出さない。
`code` を優先して照合する（`code` はリリース間で安定、message は変わりうる）。

実測で確認した重要な挙動:

```
誤ったコード   → 403 otp_expired "Token has expired or is invalid"
期限切れコード → 403 otp_expired "Token has expired or is invalid"
```

**Supabase は「入力ミス」と「期限切れ」を区別しない。**
そのため message に expired と invalid が両方含まれる場合は、こちらも断定せず
「コードが違うか、有効期限が切れています」と両方を提示する。
期限切れと決めつけると、単なる打ち間違いのユーザーに無駄な再送を促し、
メール送信のレート制限を消費させてしまう。

| 状況 | code | 表示 |
| --- | --- | --- |
| コード不一致 / 期限切れ | `otp_expired` | コードが違うか、有効期限が切れています |
| 期限切れ（明示） | `otp_expired` | コードの有効期限が切れました。コードを再送してください |
| 送信レート制限 | `over_email_send_rate_limit` / `over_request_rate_limit` / 429 | 送信回数が上限に達しました |
| SMTP 障害 / 上流障害 | `unexpected_failure` / `request_timeout` / 5xx | メールを送信できませんでした |
| アドレス不正 | `email_address_invalid` / `validation_failed` | メールアドレスの形式が正しくありません |

---

## 7. UI

[`src/app/login/login-form.tsx`](../src/app/login/login-form.tsx)

- OTP 入力は **分割 6 input ではなく単一 input**。分割入力は貼り付け・
  IME・スクリーンリーダーのいずれとも相性が悪い。
- 属性: `inputMode="numeric"` / `autoComplete="one-time-code"` /
  `maxLength={6}` / `enterKeyHint="go"`
- `onPaste` を横取りしない。`onChange` で数字以外を落とすだけなので、
  `123 456` のような貼り付けもそのまま通る。
- 再送は **60 秒クールダウン**。計測はクライアント時刻のみで行う
  （サーバー時刻と混ぜると時計ずれで表示が狂う）。送信時刻ではなく
  **submit 時刻**を起点にする（Supabase のレート制限に当たるのがその瞬間のため）。
- 再送に失敗しても Step 2 に留まる（入力中のコードを失わせない）。
- 状態通知は `aria-live="polite"`、エラーは `role="alert"`。

---

## 8. Cookie / セッション

今回 `httpOnly` の設定は変更しない。`@supabase/ssr` の既定のまま。
セッション検証は既存どおり `getClaims()`（JWKS によるローカル署名検証）で行い、
`src/proxy.ts` と `src/lib/supabase/server.ts` には手を入れていない。

---

## 9. 開発時の OTP 取得（メールを消費しない）

```bash
npm run dev:otp -- you@example.com              # 既存ユーザーのコードを表示
npm run dev:otp -- you@example.com --signup     # 新規ユーザーを作ってコードを表示
npm run dev:otp -- you@example.com --verify 123456   # コードを検証し user.id を表示
```

Admin API の `generate_link` は**メールを送信せず**、メールに載るはずだった
`email_otp` を返す。これにより UI の動作確認でメールのレート制限を消費しない。

安全策:

- `.env.local` のみ読む（`.env.production` は読まない）
- service role key は 1 回のサーバー間通信に使うだけで、出力も保存もしない
- `NODE_ENV=production` / Vercel 環境 / CI では起動を拒否（回避フラグなし）
- ブラウザから到達する経路を持たない（`scripts/` 配下の Node スクリプト）

---

## 10. Supabase Dashboard 側で必要な設定

コード側では設定できない項目。**デプロイ順序に注意**（§11）。

| 項目 | 場所 | 値 |
| --- | --- | --- |
| Email OTP Length | Authentication → Sign In / Providers → Email | **6** |
| Email OTP Expiration | 同上 | **600**（秒） |
| メールテンプレート | Authentication → Emails → Magic Link | `{{ .Token }}` を使う本文へ |
| メールテンプレート | Authentication → Emails → Confirm signup | 同上（新規ユーザー用） |

上 2 行は **2026-08-08 に適用済み**。適用前のプロジェクト設定は OTP 長 = 8 桁で、
UI が 6 桁固定のためログインできなかった（実測して判明）。メールテンプレートの
2 行はまだ変更していない — §11 の順序どおり、コードのデプロイ後に行う。

Custom SMTP / Resend / 独自ドメインは今回のコード実装とは分離して扱う。

### 内蔵 SMTP の送信上限（実測）

内蔵メールサービスの送信枠は **1 時間のローリングウィンドウ**で、実測では 2 通目が
`over_email_send_rate_limit` で弾かれた。32 分待っても回復せず、約 1 時間で回復。

本番運用の前に Custom SMTP / Resend が要る根拠はこれ。開発中は §9 の
`npm run dev:otp` でメールを 1 通も使わずに UI 検証ができるので、この枠に触れない。

---

## 11. 切り替え手順（順序厳守）

メールテンプレートを先に変えると、現行の Magic Link ログインが壊れる。

| | 手順 | 状態 |
| --- | --- | --- |
| 1 | Email OTP Length を 6 に変更 | ✅ 2026-08-08 |
| 2 | Email OTP Expiration を 600 に変更 | ✅ 2026-08-08 |
| 3 | コードをデプロイする（この branch） | 未 |
| 4 | Magic Link / Confirm signup テンプレートを `{{ .Token }}` 本文へ変更 | 未 |
| 5 | 実機で 1 回ログインして確認 | 未 |

1 と 2 を先に済ませても現行ログインは壊れない（Magic Link のリンクは OTP 長と
無関係に機能する）。**壊れるのは 4 だけ**なので、4 は 3 の後に行う。

`?token_hash=` 経路は残してあるので、4 の直前までに送信済みのメールは
有効期限内であれば引き続き使える。

---

## 12. 検証記録（2026-08-08）

Dashboard の OTP 長 = 6 / 有効期限 = 600 を適用したうえで、実際に動いている
dev サーバーとブラウザで通した結果。「〜のはず」ではなく観測値のみを載せる。

### UI 通し

| 項目 | 結果 | 観測したもの |
| --- | --- | --- |
| 正しい OTP でログイン | ✅ | 6 桁入力 → 303 → セッション確立 |
| 再送クールダウン | ✅ | 60 秒カウントダウン → 有効化 → 実際に再送 |
| ログアウト → 再ログイン | ✅ | Cookie 消失 → 保護ルート再ブロック → 再ログイン成立 |
| 同一 user.id 維持 | ✅ | JWT の `sub` = `285fadf6-…`（ログアウト前後で一致） |
| 既存データ維持 | ✅ | 在庫 9 品目・調理中セッション `8cf77b91…` 5/7 工程・履歴 8月3日 |
| `next=/inventory` 復帰 | ✅ | hidden input に `/inventory` → 検証後 `/inventory` に着地 |
| 誤 OTP の日本語エラー | ✅ | Step 2 に留まり日本語表示。英語原文はサーバーログのみ |
| rate limit の日本語エラー | ✅ | `over_email_send_rate_limit` → Step 2 を保ったまま日本語表示 |

OTP 入力欄は実 DOM 上で `inputMode=numeric` / `autocomplete=one-time-code` /
`maxLength=6` / `enterKeyHint=go`、Step 2 到達時に自動フォーカス。6 桁未満は
送信ボタンが `disabled`。

### open redirect（有効な token_hash を発行して実測）

| `next` | 着地先 |
| --- | --- |
| `/inventory` | `http://localhost:3000/inventory` |
| `/\evil.example.com` | `http://localhost:3000/` |
| `//evil.example.com` | `http://localhost:3000/` |

`/auth/error?message=<script>…` は描画されない（reason コード方式に変更済み）。

### その他

- `npm run audit:rls` — **32/32 PASS**（認証方式の変更が RLS に影響していない）
- `src/lib/auth/redirect.test.ts` — 30 ケース。旧ガードが `/\evil.example.com` を
  通していたことを回帰オラクルとして固定してある
- 新規ユーザー作成経路 — `--signup` で作成 → `type: 'email'` で検証成立
- コード単回使用 — 同じコードの 2 回目は 403

---

## 13. 今回のスコープ外

- Google Sign-In — 次の認証フェーズ（`?code=` 経路は今回維持済み）
- Apple Sign-In / Passkey — 保留
- Custom SMTP / 独自ドメイン — コード実装とは分離
- Cookie の `httpOnly` 変更 — 今回は変更しない
