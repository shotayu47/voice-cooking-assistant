import { notFound } from 'next/navigation';

import { ButtonLink } from '@/components/ui/button';
import { PageShell } from '@/components/page-shell';
import { getSession } from '@/lib/cooking/service';
import { getServiceContext } from '@/lib/supabase/server';
import type { Recipe } from '@/types/domain';

import { CookingView } from './cooking-view';

export const metadata = { title: '調理中 | 料理アシスタント' };

export default async function CookingPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const { ctx } = await getServiceContext();
  const session = await getSession(ctx, sessionId);

  if (!session) notFound();

  const recipe = session.recipe_snapshot as Recipe;

  // A finished session is history, not a cooking screen.
  if (session.status === 'completed' || session.status === 'cancelled') {
    return (
      <PageShell title={recipe.title} back={{ href: '/history' }}>
        <p className="text-muted">
          この料理は{session.status === 'completed' ? '完了' : '中断'}しています。
        </p>
        <ButtonLink href="/chat" variant="primary" size="lg" block className="mt-6">
          次の料理を相談する
        </ButtonLink>
      </PageShell>
    );
  }

  return (
    <CookingView
      sessionId={session.id}
      recipe={recipe}
      initialStep={session.current_step}
      totalSteps={session.total_steps}
    />
  );
}
