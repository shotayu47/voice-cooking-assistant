import { cn } from '@/lib/cn';

/**
 * Placeholder block for instant loading UI.
 *
 * Kept very low contrast on purpose: this appears for well under a second on a
 * normal connection, and a bright shimmer would read as a longer wait than the
 * real one.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-surface-2', className)} aria-hidden />;
}

/** Header bar matching PageShell, so the title area does not jump on load. */
export function SkeletonHeader({ title }: { title: string }) {
  return (
    <header
      className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-line bg-bg px-3"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <h1 className="flex-1 truncate px-1 text-base font-semibold">{title}</h1>
    </header>
  );
}
