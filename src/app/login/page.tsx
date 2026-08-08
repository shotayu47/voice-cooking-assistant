import { safeNext } from '@/lib/auth/redirect';

import { LoginForm } from './login-form';

export const metadata = { title: 'ログイン | TSUGU' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 pb-24">
      <div className="mb-10">
        <div className="mb-6 size-14 rounded-full border-[6px] border-accent" aria-hidden />
        <h1 className="text-2xl font-bold tracking-wide">TSUGU</h1>
        <p className="mt-2 text-sm text-muted">
          冷蔵庫の中身を覚えている、料理の相棒。
        </p>
      </div>

      {/*
        Sanitized here as well as in the verify action. The proxy sets this
        parameter, but anyone can hand out a /login?next=… link, and this value
        is about to be rendered into a hidden input.
      */}
      <LoginForm next={safeNext(next)} />
    </div>
  );
}
