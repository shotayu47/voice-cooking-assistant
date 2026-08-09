'use server';

import { revalidatePath } from 'next/cache';

import {
  runAddSuggested,
  runClearChecked,
  runCreate,
  runDelete,
  runSetChecked,
  type AddSuggestedResult,
  type MutationOutcome,
  type PickedSuggestion,
  type ShoppingDeps,
  type ShoppingFormState,
} from '@/lib/shopping/actions-core';
import {
  clearCheckedShoppingItems,
  createShoppingItem,
  deleteShoppingItem,
  setShoppingItemChecked,
} from '@/lib/shopping/service';
import { IdempotencyUnavailableError, runOnce } from '@/lib/ai/idempotency';
import { getServiceContext } from '@/lib/supabase/server';
import type { ServiceContext } from '@/lib/inventory/service';

/**
 * Shopping-list Server Actions.
 *
 * Every one of them is a wrapper: authenticate, hand the service functions to
 * the core in `@/lib/shopping/actions-core`, return what it decided. No
 * Supabase query is written here — the `user_id` conditions that keep one
 * person's list out of another's live in the service layer, in one place.
 */
function makeDeps(ctx: ServiceContext): ShoppingDeps {
  return {
    create: (input) => createShoppingItem(ctx, input),
    setChecked: (itemId, checked) => setShoppingItemChecked(ctx, itemId, checked),
    remove: (itemId) => deleteShoppingItem(ctx, itemId),
    clearChecked: () => clearCheckedShoppingItems(ctx),
    revalidate: revalidatePath,
  };
}

async function deps(): Promise<ShoppingDeps> {
  const { ctx } = await getServiceContext();
  return makeDeps(ctx);
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

/**
 * Adds the suggestions the user ticked on a chat card.
 *
 * `requestId` is generated once per card and held until the run finishes, so a
 * double tap — or a resubmit after a dropped connection — arrives with the
 * same key and is answered from the ledger instead of adding a second time.
 * `failClosed` matters here: for a read, an unavailable ledger is not worth
 * failing over, but a write that proceeds unguarded is the double-add the
 * ledger exists to prevent.
 */
export async function addSuggestedShoppingItemsAction(
  requestId: string,
  picked: PickedSuggestion[],
): Promise<AddSuggestedResult> {
  const { ctx } = await getServiceContext();

  try {
    const { value } = await runOnce(
      ctx,
      requestId,
      'add_suggested_shopping_items',
      () => runAddSuggested(makeDeps(ctx), picked),
      { failClosed: true },
    );

    // A concurrent submit holds the claim: the ledger answers with its own
    // in-flight marker rather than a result, so it needs turning into one.
    if (!Array.isArray((value as AddSuggestedResult).added)) {
      return {
        added: [],
        failed: [],
        notices: [],
        error: '追加を処理中です。少し待ってから画面を確認してください。',
      };
    }

    return value;
  } catch (error) {
    if (error instanceof IdempotencyUnavailableError) {
      // Nothing was attempted, so it is safe to say so and let them retry.
      return {
        added: [],
        failed: [],
        notices: [],
        error: '追加できませんでした。もう一度お試しください。',
      };
    }
    throw error;
  }
}
