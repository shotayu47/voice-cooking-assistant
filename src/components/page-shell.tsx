import Link from 'next/link';

import { cn } from '@/lib/cn';

/**
 * Standard page frame: a compact sticky header and a max-width column.
 * Everything is mobile-first — the layout is designed at 390px and simply
 * centres on anything wider.
 */
export function PageShell({
  title,
  back,
  action,
  className,
  children,
}: {
  title: string;
  back?: { href: string; label?: string };
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md">
      <header
        className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-line bg-bg/95 px-3 backdrop-blur"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        {back ? (
          <Link
            href={back.href}
            aria-label={back.label ?? '戻る'}
            className="-ml-1 flex size-11 items-center justify-center rounded-lg text-muted active:bg-surface-2"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </Link>
        ) : null}
        <h1 className="flex-1 truncate text-base font-semibold">{title}</h1>
        {action}
      </header>

      <main className={cn('px-4 py-4', className)}>{children}</main>
    </div>
  );
}
