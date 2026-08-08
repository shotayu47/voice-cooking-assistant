import { Skeleton, SkeletonHeader } from '@/components/ui/skeleton';

/**
 * Instant feedback while the list query runs. The shape mirrors the real page —
 * the add form, then a run of rows — so nothing jumps when the data arrives.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-md">
      <SkeletonHeader title="買い物リスト" />
      <main className="px-4 py-4 pb-10">
        <div className="mb-6 space-y-3">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <div className="flex gap-3">
            <Skeleton className="h-12 w-28 rounded-xl" />
            <Skeleton className="h-12 flex-1 rounded-xl" />
          </div>
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>

        <Skeleton className="mb-2 ml-1 h-4 w-20" />
        <div className="overflow-hidden rounded-card border border-line">
          {Array.from({ length: 3 }, (_, row) => (
            <div
              key={row}
              className="flex min-h-14 items-center gap-3 border-b border-line px-3 last:border-b-0"
            >
              <Skeleton className="size-6 shrink-0 rounded" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-5 w-12 rounded-full" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
