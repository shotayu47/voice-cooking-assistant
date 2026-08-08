import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { PageShell } from '@/components/page-shell';
import { getInventoryItem } from '@/lib/inventory/service';
import { getServiceContext } from '@/lib/supabase/server';

import { deleteItemAction, updateItemAction } from '../actions';
import { ItemForm } from '../item-form';

export const metadata = { title: '食材を編集 | TSUGU' };

export default async function EditInventoryItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await getServiceContext();
  const item = await getInventoryItem(ctx, id);

  if (!item) notFound();

  return (
    <PageShell title="食材を編集" back={{ href: '/inventory' }}>
      <ItemForm action={updateItemAction} item={item} submitLabel="保存する" />

      <form action={deleteItemAction} className="mt-8">
        <input type="hidden" name="id" value={item.id} />
        <Button type="submit" variant="danger" size="md" block>
          この食材を削除
        </Button>
      </form>
    </PageShell>
  );
}
