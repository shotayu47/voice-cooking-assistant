import { ButtonLink } from '@/components/ui/button';

export const metadata = { title: 'ログインできませんでした' };

/**
 * Reached only from /auth/callback, which passes a reason code rather than a
 * message: the query string is attacker-controlled, so the wording lives here
 * and an unknown code falls back to the generic line.
 */
const REASONS = {
  link: 'リンクの有効期限が切れているか、すでに使用済みです。',
  malformed: 'リンクが正しくありません。メールのURL全体が開かれているか確認してください。',
} as const;

const FALLBACK = 'もう一度ログインをやり直してください。';

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const message = REASONS[reason as keyof typeof REASONS] ?? FALLBACK;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-xl font-bold">ログインできませんでした</h1>
      <p className="mt-2 text-sm text-muted">{message}</p>
      <p className="mt-2 text-sm text-faint">
        ログインページからメールアドレスを入力すると、6桁の確認コードをお送りします。
      </p>
      <ButtonLink href="/login" variant="primary" size="lg" block className="mt-6">
        もう一度ログインする
      </ButtonLink>
    </div>
  );
}
