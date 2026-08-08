import Link from 'next/link';

import { ButtonLink } from '@/components/ui/button';
import { Chip, EmptyState } from '@/components/ui/surfaces';
import { PageShell } from '@/components/page-shell';
import { listHistory } from '@/lib/cooking/service';
import { getServiceContext } from '@/lib/supabase/server';
import type { CookingSessionStatus, Recipe } from '@/types/domain';

export const metadata = { title: '履歴 | TSUGU' };

const STATUS_LABEL: Record<CookingSessionStatus, string> = {
  active: '調理中',
  paused: '一時停止',
  completed: '完成',
  cancelled: '中断',
};

const STATUS_TONE: Record<CookingSessionStatus, 'accent' | 'ok' | 'neutral'> = {
  active: 'accent',
  paused: 'accent',
  completed: 'ok',
  cancelled: 'neutral',
};

export default async function HistoryPage() {
  const { ctx } = await getServiceContext();
  const sessions = await listHistory(ctx, 50);

  return (
    <PageShell title="履歴">
      {sessions.length === 0 ? (
        <EmptyState
          title="まだ料理の記録がありません"
          hint="AIに相談して、最初の一品を作ってみましょう。"
          action={
            <ButtonLink href="/chat" variant="primary" size="lg">
              AIに相談する
            </ButtonLink>
          }
        />
      ) : (
        <ul className="space-y-2">
          {sessions.map((session) => {
            const recipe = session.recipe_snapshot as Recipe;
            const open = session.status === 'active' || session.status === 'paused';

            return (
              <li key={session.id}>
                <Link
                  href={`/cooking/${session.id}`}
                  className="flex min-h-16 items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 active:bg-surface-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{recipe.title}</span>
                    <span className="mt-0.5 block text-xs text-faint">
                      {formatDate(session.completed_at ?? session.created_at)}
                      {open ? ` · ${session.current_step + 1}/${session.total_steps} 工程` : ''}
                      {recipe.estimatedMinutes ? ` · ${recipe.estimatedMinutes}分` : ''}
                    </span>
                  </span>
                  <Chip tone={STATUS_TONE[session.status]}>
                    {STATUS_LABEL[session.status]}
                  </Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
