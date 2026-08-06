'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { createClient } from '@/lib/supabase/client';

type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;

    setStatus({ kind: 'sending' });

    const supabase = createClient();
    const redirectTo = new URL('/auth/callback', window.location.origin);
    redirectTo.searchParams.set('next', next);

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo.toString() },
    });

    setStatus(error ? { kind: 'error', message: error.message } : { kind: 'sent' });
  }

  if (status.kind === 'sent') {
    return (
      <div className="rounded-card border border-line bg-surface p-5">
        <p className="font-medium">メールを送りました</p>
        <p className="mt-2 text-sm text-muted">
          {email} 宛のリンクを、<strong className="text-fg">このブラウザで</strong>開いてください。
        </p>
        <Button
          className="mt-4"
          block
          onClick={() => setStatus({ kind: 'idle' })}
        >
          別のアドレスで送り直す
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="メールアドレス" hint="パスワードは不要です。ログイン用のリンクを送ります。">
        <Input
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>

      {status.kind === 'error' ? (
        <p className="text-sm text-danger">{status.message}</p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        block
        disabled={status.kind === 'sending'}
      >
        {status.kind === 'sending' ? '送信中…' : 'ログインリンクを送る'}
      </Button>
    </form>
  );
}
