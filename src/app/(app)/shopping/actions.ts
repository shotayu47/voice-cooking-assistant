'use server';

import { revalidatePath } from 'next/cache';

import {
  runClearChecked,
  runCreate,
  runDelete,
  runSetChecked,
  type MutationOutcome,
  type ShoppingDeps,
  type ShoppingFormState,
} from '@/lib/shopping/actions-core';
import {
  clearCheckedShoppingItems,
  createShoppingItem,
  deleteShoppingItem,
  setShoppingItemChecked,
} from '@/lib/shopping/service';
import { getServiceContext } from '@/lib/supabase/server';

/**
 * Shopping-list Server Actions.
 *
 * Every one of them is a wrapper: authenticate, hand the service functions to
 * the core in `@/lib/shopping/actions-core`, return what it decided. No
 * Supabase query is written here — the `user_id` conditions that keep one
 * person's list out of another's live in the service layer, in one place.
 */
async function deps(): Promise<ShoppingDeps> {
  const { ctx } = await getServiceContext();

  return {
    create: (input) => createShoppingItem(ctx, input),
    setChecked: (itemId, checked) => setShoppingItemChecked(ctx, itemId, checked),
    remove: (itemId) => deleteShoppingItem(ctx, itemId),
    clearChecked: () => clearCheckedShoppingItems(ctx),
    revalidate: revalidatePath,
  };
}

export async function addShoppingItemAction(
  previous: ShoppingFormState,
  formData: FormData,
): Promise<ShoppingFormState> {
  return runCreate(await deps(), previous, {
    name: String(formData.get('name') ?? ''),
    quantity: String(formData.get('quantity') ?? ''),
    unit: String(formData.get('unit') ?? ''),
  });
}

export async function setShoppingItemCheckedAction(
  itemId: string,
  checked: boolean,
): Promise<MutationOutcome> {
  return runSetChecked(await deps(), itemId, checked);
}

export async function deleteShoppingItemAction(itemId: string): Promise<MutationOutcome> {
  return runDelete(await deps(), itemId);
}

export async function clearCheckedShoppingItemsAction(): Promise<MutationOutcome> {
  return runClearChecked(await deps());
}
