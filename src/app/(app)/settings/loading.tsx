import { Skeleton, SkeletonHeader } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-md">
      <SkeletonHeader title="設定" />
      <main className="px-4 py-4">
        <Skeleton className="mb-6 h-4 w-48" />
        <div className="space-y-5">
          {Array.from({ length: 3 }, (_, field) => (
            <div key={field} className="space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-12 w-full rounded-xl" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
