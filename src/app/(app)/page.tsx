import Link from 'next/link';

import { ButtonLink } from '@/components/ui/button';
import { Card, Chip, SectionTitle } from '@/components/ui/surfaces';
import { listExpiringSoon, listInventory } from '@/lib/inventory/service';
import { getOpenSession, listHistory } from '@/lib/cooking/service';
import { getServiceContext } from '@/lib/supabase/server';
import { isAvailable } from '@/lib/inventory/quantity';
import type { Recipe } from '@/types/domain';

export default async function HomePage() {
  const { ctx } = await getServiceContext();

  const [items, expiring, openSession, history] = await Promise.all([
    listInventory(ctx, { includeEmpty: true }),
    listExpiringSoon(ctx, 3),
    getOpenSession(ctx),
    listHistory(ctx, 5),
  ]);

  const usable = items.filter(isAvailable);
  const recent = history.filter((session) => session.status === 'completed').slice(0, 3);

  return (
    <div className="mx-auto w-full max-w-md px-4 pb-8">
      <header className="pt-6 pb-5" style={{ paddingTop: 'calc(24px + env(safe-area-inset-top))' }}>
        <p className="text-sm text-faint">こんにちは</p>
        <h1 className="mt-1 text-2xl font-bold">今日なに作る？</h1>
      </header>

      {openSession ? (
        <Link
          href={`/cooking/${openSession.id}`}
          className="mb-5 block rounded-card border border-accent/40 bg-accent/10 p-4"
        >
          <p className="text-xs text-accent">調理中</p>
          <p className="mt-1 font-semibold">
            {(openSession.recipe_snapshot as Recipe).title}
          </p>
          <p className="mt-1 text-sm text-muted">
            {openSession.current_step + 1} / {openSession.total_steps} 工程 — 続きから
          </p>
        </Link>
      ) : null}

      <div className="space-y-3">
        <ButtonLink href="/chat" variant="primary" size="xl" block>
          今日なに作る？
        </ButtonLink>
        <ButtonLink href="/chat" variant="secondary" size="lg" block>
          料理を始める
        </ButtonLink>
      </div>

      <section className="mt-8">
        <SectionTitle
          action={
            <Link href="/inventory" className="text-xs text-accent">
              すべて見る
            </Link>
          }
        >
          在庫
        </SectionTitle>
        <Card>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums">{usable.length}</span>
            <span className="text-sm text-muted">品目が使えます</span>
          </div>
          {items.length > usable.length ? (
            <p className="mt-1 text-xs text-faint">
              {items.length - usable.length} 品目が在庫切れ
            </p>
          ) : null}
          {usable.length === 0 ? (
            <ButtonLink href="/inventory/new" size="md" block className="mt-3">
              食材を登録する
            </ButtonLink>
          ) : null}
        </Card>
      </section>

      {expiring.length > 0 ? (
        <section className="mt-6">
          <SectionTitle>期限が近い食材</SectionTitle>
          <ul className="flex flex-wrap gap-2">
            {expiring.map((item) => (
              <li key={item.id}>
                <Chip tone="warn">
                  {item.name}
                  {item.expiry_date ? ` · ${item.expiry_date.slice(5)}` : ''}
                </Chip>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="mt-6">
          <SectionTitle
            action={
              <Link href="/history" className="text-xs text-accent">
                履歴
              </Link>
            }
          >
            最近作った料理
          </SectionTitle>
          <ul className="space-y-2">
            {recent.map((session) => (
              <li
                key={session.id}
                className="rounded-card border border-line bg-surface px-4 py-3"
              >
                <p className="truncate">{(session.recipe_snapshot as Recipe).title}</p>
                <p className="mt-0.5 text-xs text-faint">
                  {formatDate(session.completed_at ?? session.created_at)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : `${date.getMonth() + 1}月${date.getDate()}日`;
}
