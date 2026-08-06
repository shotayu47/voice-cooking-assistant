import { ButtonLink } from '@/components/ui/button';

export const metadata = { title: 'ログインできませんでした' };

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  const { message } = await searchParams;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-xl font-bold">ログインできませんでした</h1>
      <p className="mt-2 text-sm text-muted">
        {message ?? 'リンクの有効期限が切れている可能性があります。'}
      </p>
      <p className="mt-2 text-sm text-faint">
        リンクは送信したブラウザと同じブラウザで開く必要があります。
      </p>
      <ButtonLink href="/login" variant="primary" size="lg" block className="mt-6">
        もう一度ログインする
      </ButtonLink>
    </div>
  );
}
