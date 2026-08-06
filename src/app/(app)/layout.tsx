import { redirect } from 'next/navigation';

import { BottomNav } from '@/components/bottom-nav';
import { createClient } from '@/lib/supabase/server';

/**
 * Auth gate for every signed-in page. The proxy already redirects anonymous
 * requests; this is the second check so a page can never render without a
 * user, and RLS is the third.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return (
    <>
      {children}
      <BottomNav />
    </>
  );
}
