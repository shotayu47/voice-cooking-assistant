'use client';

import { useActionState, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

import { sendOtpAction, verifyOtpAction, type SendState, type VerifyState } from './actions';

/** Seconds a user waits before another code can be requested. */
const RESEND_COOLDOWN_SECONDS = 60;

/** How long Supabase keeps the code valid, shown so the wait is not a mystery. */
const OTP_TTL_MINUTES = 10;

const CODE_LENGTH = 6;

export function LoginForm({ next }: { next: string }) {
  const [sendState, sendAction, sending] = useActionState(sendOtpAction, {} as SendState);
  const [verifyState, verifyAction, verifying] = useActionState(verifyOtpAction, {} as VerifyState);

  const [code, setCode] = useState('');
  /**
   * `useActionState` has no reset, so "use a different address" is tracked here
   * rather than by clearing `sendState`.
   */
  const [editingEmail, setEditingEmail] = useState(false);
  /**
   * When this browser last asked for a code. Client-side on purpose: comparing
   * a server timestamp against `Date.now()` here would show a wrong countdown
   * whenever the two clocks disagree. Stamped at submit rather than at the
   * response, because that is when the request reaches Supabase's rate limiter.
   */
  const [requestedAt, setRequestedAt] = useState(0);
  const [tick, setTick] = useState(0);

  const onCodeStep = Boolean(sendState.sent) && !editingEmail;
  const email = sendState.email ?? '';

  const cooldown =
    requestedAt === 0
      ? 0
      : Math.max(
          0,
          Math.ceil((requestedAt + RESEND_COOLDOWN_SECONDS * 1000 - Math.max(tick, requestedAt)) / 1000),
        );

  useEffect(() => {
    if (requestedAt === 0) return;
    const id = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(id);
  }, [requestedAt]);

  // Wrapping the action keeps the state that a form submit cannot express:
  // leaving "different address" mode, clearing a stale code, and starting the
  // cooldown. All of it runs in an event handler, before the action dispatches.
  function handleSend(formData: FormData) {
    setEditingEmail(false);
    setCode('');
    setRequestedAt(Date.now());
    sendAction(formData);
  }

  if (onCodeStep) {
    return (
      <div className="space-y-5">
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="text-sm text-muted">確認コードを送りました</p>
          <p className="mt-1 font-medium break-all">{email}</p>
          <p className="mt-2 text-xs text-faint">
            届いたメールの6桁の数字を、{OTP_TTL_MINUTES}分以内に入力してください。
          </p>
        </div>

        <form action={verifyAction} className="space-y-4">
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="next" value={next} />

          <Field label="確認コード" hint="メールに記載された6桁の数字">
            <Input
              // Step 2 is a fresh mount, so this focuses the code box exactly
              // once — when the user arrives with a code to type.
              autoFocus
              name="token"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
              enterKeyHint="go"
              pattern="[0-9]*"
              required
              placeholder="123456"
              aria-describedby="login-status"
              className="text-center text-2xl tracking-[0.4em]"
              value={code}
              // Strips separators a paste may carry ("123 456") without
              // intercepting the paste itself.
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))
              }
            />
          </Field>

          {verifyState.error ? (
            <p role="alert" className="text-sm text-danger">
              {verifyState.error}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            disabled={verifying || code.length !== CODE_LENGTH}
          >
            {verifying ? '確認中…' : 'ログインする'}
          </Button>
        </form>

        <p id="login-status" aria-live="polite" className="sr-only">
          {verifying
            ? 'コードを確認しています'
            : sending
              ? 'コードを再送しています'
              : 'コードを送信しました'}
        </p>

        <form action={handleSend} className="space-y-3">
          <input type="hidden" name="email" value={email} />

          {sendState.error ? (
            <p role="alert" className="text-sm text-danger">
              {sendState.error}
            </p>
          ) : null}

          {/* Promoted when the code is past saving, so the fix is the obvious button. */}
          <Button
            type="submit"
            variant={verifyState.expired ? 'primary' : 'secondary'}
            block
            disabled={sending || cooldown > 0}
          >
            {sending
              ? '再送しています…'
              : cooldown > 0
                ? `コードを再送する（${cooldown}秒後）`
                : 'コードを再送する'}
          </Button>
        </form>

        <Button variant="ghost" block onClick={() => setEditingEmail(true)}>
          別のメールアドレスを使う
        </Button>
      </div>
    );
  }

  return (
    <form action={handleSend} className="space-y-4">
      <Field label="メールアドレス" hint="パスワードは不要です。6桁の確認コードを送ります。">
        <Input
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          enterKeyHint="send"
          required
          placeholder="you@example.com"
          defaultValue={email}
          aria-describedby="login-status"
        />
      </Field>

      {sendState.error ? (
        <p role="alert" className="text-sm text-danger">
          {sendState.error}
        </p>
      ) : null}

      <p id="login-status" aria-live="polite" className="sr-only">
        {sending ? 'コードを送信しています' : ''}
      </p>

      <Button type="submit" variant="primary" size="lg" block disabled={sending}>
        {sending ? '送信中…' : 'コードを送る'}
      </Button>
    </form>
  );
}
