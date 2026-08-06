import { BottomNav } from '@/components/bottom-nav';

/**
 * App shell for every signed-in page.
 *
 * The shell is exactly one dynamic viewport tall and lays out as a column:
 * a scrolling content area, then the nav as the last flex item. The nav is a
 * real footer rather than `position: fixed`, so its position cannot depend on
 * how much content a page has, how far it is scrolled, or — on iOS Safari —
 * whether the browser toolbar is collapsed. `fixed` resolves against the
 * layout viewport, which is why the bar used to sit at a different height on
 * short pages than on scrollable ones.
 *
 * `dvh` (not `vh`) so the shell tracks the toolbar as it shows and hides.
 * `min-h-0` lets the content area shrink below its intrinsic height, which is
 * what allows it — rather than the document — to be the scroller.
 *
 * Deliberately does no auth work: a top-level await in a layout holds
 * `{children}` behind it. Access is enforced by `proxy.ts`, by each page's
 * `getServiceContext()`, and finally by RLS.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</main>
      <BottomNav />
    </div>
  );
}
