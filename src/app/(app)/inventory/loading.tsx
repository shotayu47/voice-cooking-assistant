import { Skeleton, SkeletonHeader } from '@/components/ui/skeleton';

/**
 * Instant feedback while the inventory query runs. The shape mirrors the real
 * page — grouped rows under category headings — so the content does not jump
 * when it arrives.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-md">
      <SkeletonHeader title="在庫" />
      <main className="space-y-6 px-4 py-4">
        {[3, 2].map((rows, group) => (
          <section key={group}>
            <Skeleton className="mb-2 ml-1 h-4 w-16" />
            <div className="overflow-hidden rounded-card border border-line">
              {Array.from({ length: rows }, (_, row) => (
                <div key={row} className="flex min-h-[60px] items-center gap-3 border-b border-line px-4 last:border-b-0">
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-5 w-12 rounded-full" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
