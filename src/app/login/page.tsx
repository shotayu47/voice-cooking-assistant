import { LoginForm } from './login-form';

export const metadata = { title: 'ログイン | 料理アシスタント' };

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
        <h1 className="text-2xl font-bold">料理アシスタント</h1>
        <p className="mt-2 text-sm text-muted">
          冷蔵庫の中身を覚えている、料理の相棒。
        </p>
      </div>

      <LoginForm next={next ?? '/'} />
    </div>
  );
}
