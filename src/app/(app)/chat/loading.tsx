import { Skeleton } from '@/components/ui/skeleton';

/**
 * Chat loads the stored transcript, so show the header and composer straight
 * away — those are fixed and never depend on the query.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-md">
      <header
        className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-line bg-bg/95 px-4 backdrop-blur"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <h1 className="flex-1 text-base font-semibold">AIに相談</h1>
      </header>

      <div className="space-y-3 px-4 py-4">
        <div className="flex justify-end">
          <Skeleton className="h-11 w-2/3 rounded-2xl" />
        </div>
        <div className="flex justify-start">
          <Skeleton className="h-20 w-5/6 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
