import { Skeleton, SkeletonHeader } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-md">
      <SkeletonHeader title="履歴" />
      <main className="space-y-2 px-4 py-4">
        {Array.from({ length: 4 }, (_, row) => (
          <div
            key={row}
            className="flex min-h-16 items-center gap-3 rounded-card border border-line px-4 py-3"
          >
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
        ))}
      </main>
    </div>
  );
}
