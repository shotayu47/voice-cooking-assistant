import Link from 'next/link';

import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/surfaces';
import { PageShell } from '@/components/page-shell';
import { listInventory } from '@/lib/inventory/service';
import { getServiceContext } from '@/lib/supabase/server';
import { CATEGORY_ORDER, categoryLabel } from '@/lib/labels';
import { mark, now } from '@/lib/perf';
import type { Category, InventoryItem } from '@/types/domain';

import { InventoryRow } from './inventory-row';

export const metadata = { title: '在庫 | TSUGU' };

export default async function InventoryPage() {
  const pageStart = now();
  const { ctx } = await getServiceContext();
  // Empty items stay visible here so the user can top them back up.
  const items = await listInventory(ctx, { includeEmpty: true });
  mark('page:inventory TOTAL', pageStart);

  const groups = groupByCategory(items);

  return (
    <PageShell
      title="在庫"
      action={
        <ButtonLink href="/inventory/new" variant="primary" size="sm">
          追加
        </ButtonLink>
      }
    >
      {/*
       * Below the header rather than beside 「追加」, so it never competes with
       * the primary inventory action, and outside the empty branch so it is
       * still reachable from an empty fridge — noticing something is missing is
       * exactly when the list is wanted. A link only: no shopping query runs on
       * this page.
       */}
      <Link
        href="/shopping"
        className="mb-6 flex min-h-12 items-center justify-between rounded-card border border-line bg-surface px-4 text-sm"
      >
        <span>買い物リスト</span>
        <span aria-hidden className="text-faint">
          →
        </span>
      </Link>

      {items.length === 0 ? (
        <EmptyState
          title="まだ食材が登録されていません"
          hint="名前だけで登録できます。「醤油」だけでも大丈夫です。"
          action={
            <ButtonLink href="/inventory/new" variant="primary" size="lg">
              最初の食材を追加
            </ButtonLink>
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map(([category, groupItems]) => (
            <section key={category}>
              <h2 className="mb-2 px-1 text-sm font-semibold text-muted">
                {categoryLabel(category)}
                <span className="ml-2 text-faint">{groupItems.length}</span>
              </h2>
              <ul className="overflow-hidden rounded-card border border-line">
                {groupItems.map((item) => (
                  <li key={item.id} className="border-b border-line last:border-b-0">
                    <InventoryRow item={item} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}

/** Group by category in the canonical order, with unknown categories last. */
function groupByCategory(items: InventoryItem[]): Array<[string, InventoryItem[]]> {
  const buckets = new Map<string, InventoryItem[]>();

  for (const item of items) {
    const key = (item.category as Category | null) ?? 'other';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const ordered: Array<[string, InventoryItem[]]> = [];
  for (const category of CATEGORY_ORDER) {
    const bucket = buckets.get(category);
    if (bucket) {
      ordered.push([category, bucket]);
      buckets.delete(category);
    }
  }
  for (const [category, bucket] of buckets) ordered.push([category, bucket]);

  return ordered;
}
