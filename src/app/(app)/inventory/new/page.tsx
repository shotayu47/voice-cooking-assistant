import { PageShell } from '@/components/page-shell';

import { createItemAction } from '../actions';
import { ItemForm } from '../item-form';

export const metadata = { title: '食材を追加 | 料理アシスタント' };

export default function NewInventoryItemPage() {
  return (
    <PageShell title="食材を追加" back={{ href: '/inventory' }}>
      <ItemForm action={createItemAction} submitLabel="追加する" />
    </PageShell>
  );
}
