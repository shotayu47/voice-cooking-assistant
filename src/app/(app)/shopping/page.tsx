import { PageShell } from '@/components/page-shell';
import { listShoppingItems } from '@/lib/shopping/service';
import { getServiceContext } from '@/lib/supabase/server';
import { mark, now } from '@/lib/perf';

import { AddShoppingItemForm } from './add-form';
import { ShoppingList } from './shopping-list';

export const metadata = { title: '買い物リスト | TSUGU' };

export default async function ShoppingPage() {
  const pageStart = now();
  const { ctx } = await getServiceContext();
  // Already ordered `checked asc, created_at asc`; the client only splits it.
  const items = await listShoppingItems(ctx);
  mark('page:shopping TOTAL', pageStart);

  return (
    <PageShell title="買い物リスト" className="pb-10">
      <div className="mb-6">
        <AddShoppingItemForm />
      </div>

      <ShoppingList items={items} />
    </PageShell>
  );
}
