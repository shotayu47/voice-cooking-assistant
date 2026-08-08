'use server';

import { redirect } from 'next/navigation';
import type { AuthError } from '@supabase/supabase-js';
import { z } from 'zod';

import { safeNext } from '@/lib/auth/redirect';
import { createClient } from '@/lib/supabase/server';

/**
 * Email OTP sign-in.
 *
 * Both halves run on the server so the six-digit code is only ever posted to
 * us, never handled by client-side Supabase calls. `signInWithOtp` deliberately
 * omits `emailRedirectTo`: including it makes Supabase render the magic-link
 * template, and we want the `{{ .Token }}` code instead.
 *
 * `auth.users.id` is untouched by any of this. Verifying an OTP for an address
 * that already has an account signs that same account back in, which is what
 * keeps every row of inventory attached to its owner across a re-login.
 */

// Note: a 'use server' module may only export async functions, so the shared
// numbers (OTP lifetime, resend cooldown) live in login-form.tsx instead.

export type SendState = {
  /** True once a code is on its way — the UI moves to step 2 on this. */
  sent?: boolean;
  /** The address the code went to, normalized, so step 2 can show and reuse it. */
  email?: string;
  error?: string;
};

export type VerifyState = {
  error?: string;
  /** Set when the code is unusable and the user needs a fresh one, not a retype. */
  expired?: boolean;
};

const EmailSchema = z.email().max(254);

/** Six digits, tolerating whatever spacing came along with a paste. */
function readCode(value: FormDataEntryValue | null): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 6);
}

function readEmail(value: FormDataEntryValue | null): string {
  return String(value ?? '').trim().toLowerCase();
}

type AuthFailure = { error: string; expired?: boolean };

/**
 * Turns a Supabase auth failure into something a cook standing in their kitchen
 * can act on.
 *
 * Supabase speaks English and writes for developers ("Token has expired or is
 * invalid"), and its messages leak implementation detail, so nothing from
 * `error.message` is ever rendered — it goes to the server log instead. Codes
 * are matched before messages because codes are stable across releases.
 */
function describeAuthError(error: AuthError, stage: 'send' | 'verify'): AuthFailure {
  const code = error.code ?? '';
  const message = error.message.toLowerCase();

  // Verified against the live API: a mistyped code and a genuinely stale one
  // both come back as 403 `otp_expired` / "Token has expired or is invalid".
  // Where Supabase declines to distinguish them, so do we — telling someone
  // their code expired when they fat-fingered a digit sends them off to burn
  // an email on a resend they did not need. `expired` stays unset in that case
  // so the UI keeps "retype the code" as the primary action.
  const conflated = message.includes('expired') && message.includes('invalid');

  if (code === 'otp_expired' || code === 'flow_state_expired') {
    return conflated
      ? {
          error:
            'コードが違うか、有効期限が切れています。もう一度入力するか、コードを再送してください。',
        }
      : { error: 'コードの有効期限が切れました。コードを再送してください。', expired: true };
  }

  if (code === 'invalid_credentials' || code === 'mfa_verification_failed') {
    return { error: 'コードが違います。メールに届いた6桁を確認してください。' };
  }

  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
    return {
      error: '送信回数が上限に達しました。1分ほど待ってから、もう一度お試しください。',
    };
  }

  if (code === 'email_address_invalid' || code === 'validation_failed') {
    return { error: 'メールアドレスの形式が正しくありません。' };
  }

  if (code === 'email_address_not_authorized') {
    return { error: 'このメールアドレスには送信できません。別のアドレスをお試しください。' };
  }

  if (code === 'user_banned') {
    return { error: 'このアカウントは現在ご利用いただけません。' };
  }

  if (code === 'signup_disabled' || code === 'otp_disabled' || code === 'email_provider_disabled') {
    return { error: '現在ログインを受け付けていません。時間をおいてお試しください。' };
  }

  if (code === 'captcha_failed') {
    return { error: '確認に失敗しました。ページを再読み込みしてお試しください。' };
  }

  // 429 without a more specific code — still a rate limit.
  if (error.status === 429) {
    return { error: '回数が多すぎます。しばらく待ってから、もう一度お試しください。' };
  }

  // SMTP refusing the hand-off, an upstream timeout, or the provider being
  // down all land here. Nothing the user did, and nothing retyping will fix.
  if (
    code === 'unexpected_failure' ||
    code === 'request_timeout' ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return {
      error:
        stage === 'send'
          ? 'メールを送信できませんでした。少し時間をおいて、もう一度お試しください。'
          : '確認できませんでした。少し時間をおいて、もう一度お試しください。',
    };
  }

  return {
    error:
      stage === 'send'
        ? 'コードを送信できませんでした。もう一度お試しください。'
        : 'ログインできませんでした。もう一度お試しください。',
  };
}

/** Step 1 — mail a six-digit code to the address the user typed. */
export async function sendOtpAction(prev: SendState, formData: FormData): Promise<SendState> {
  const email = readEmail(formData.get('email'));

  // A failed *resend* must not knock the user back to step 1 and lose the code
  // they were typing, so "already sent" survives an error.
  const keep = { sent: prev.sent };

  if (!EmailSchema.safeParse(email).success) {
    return { ...keep, error: 'メールアドレスを正しく入力してください。', email };
  }

  const supabase = await createClient();

  // No `emailRedirectTo`: that flag is what makes Supabase send a link instead
  // of a code. `shouldCreateUser` is the default, spelled out because sign-up
  // and sign-in are the same door here — a first-time address gets an account.
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });

  if (error) {
    console.error('[login] signInWithOtp failed:', error.code ?? error.status, error.message);
    // `expired` describes a code, not a send, so only the message carries over.
    return { ...keep, error: describeAuthError(error, 'send').error, email };
  }

  return { sent: true, email };
}

/** Step 2 — exchange the code for a session, then land on `next`. */
export async function verifyOtpAction(
  _prev: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  const email = readEmail(formData.get('email'));
  const token = readCode(formData.get('token'));

  // Re-derived here rather than trusted: this value round-tripped through a
  // hidden input, so it is client input again by the time it comes back.
  const rawNext = formData.get('next');
  const next = safeNext(typeof rawNext === 'string' ? rawNext : null);

  if (!EmailSchema.safeParse(email).success) {
    return { error: 'メールアドレスをもう一度入力してください。' };
  }

  if (token.length !== 6) {
    return { error: '6桁の数字を入力してください。' };
  }

  const supabase = await createClient();

  // `type: 'email'` is the OTP that `signInWithOtp` issued. Verifying it writes
  // the session cookies through the server client and returns the *existing*
  // user for a known address — the id never changes.
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });

  if (error) {
    console.error('[login] verifyOtp failed:', error.code ?? error.status, error.message);
    return describeAuthError(error, 'verify');
  }

  // Outside any try/catch — `redirect` signals by throwing.
  redirect(next);
}
