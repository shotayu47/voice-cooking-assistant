import { Skeleton } from '@/components/ui/skeleton';

/** Home. Mirrors the header, the two CTAs and the inventory summary card. */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-md px-4 pb-8">
      <header className="pt-6 pb-5" style={{ paddingTop: 'calc(24px + env(safe-area-inset-top))' }}>
        <p className="text-sm text-faint">こんにちは</p>
        <h1 className="mt-1 text-2xl font-bold">今日なに作る？</h1>
      </header>

      <div className="space-y-3">
        <Skeleton className="h-[72px] w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>

      <section className="mt-8">
        <Skeleton className="mb-2 h-4 w-12" />
        <div className="rounded-card border border-line bg-surface p-4">
          <Skeleton className="h-7 w-32" />
        </div>
      </section>
    </div>
  );
}
