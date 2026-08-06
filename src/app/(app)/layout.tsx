import { BottomNav } from '@/components/bottom-nav';

/**
 * Shell for every signed-in page.
 *
 * Deliberately does no auth work. It used to `await getUser()` here, which
 * cost an Auth round trip on every navigation *and* held `{children}` behind
 * it — a layout's top-level await blocks the first streamed chunk for the
 * whole segment.
 *
 * Access is enforced where it belongs and without duplication:
 *   1. `proxy.ts` verifies the JWT and redirects anonymous requests.
 *   2. Each page's `getServiceContext()` re-verifies before reading data, so a
 *      page can never render with an unauthenticated context.
 *   3. RLS is the final boundary in the database.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      {children}
      <BottomNav />
    </>
  );
}
