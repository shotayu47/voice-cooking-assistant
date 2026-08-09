'use server';

import { revalidatePath } from 'next/cache';

import {
  runAddSuggested,
  runClearChecked,
  runCreate,
  runDelete,
  runSetChecked,
  MAX_PICKED_SUGGESTIONS,
  type AddSuggestedOutcome,
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
import {
  IdempotencyUnavailableError,
  IdempotentWriteUnresolvedError,
  runOnce,
} from '@/lib/ai/idempotency';
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
): Promise<AddSuggestedOutcome> {
  // Refused before the ledger is touched, so a rejected press does not burn
  // the request key — the user fixes the selection and presses again.
  if (!requestId || picked.length === 0) {
    return { status: 'rejected', message: '追加するものを選んでください' };
  }
  if (picked.length > MAX_PICKED_SUGGESTIONS) {
    return { status: 'rejected', message: '一度に追加できるのは30件までです' };
  }

  const { ctx } = await getServiceContext();

  try {
    const { value, stored } = await runOnce(
      ctx,
      requestId,
      'add_suggested_shopping_items',
      () => runAddSuggested(makeDeps(ctx), picked),
      { failClosed: true },
    );

    // A concurrent submit holds the claim: the ledger answers with its own
    // in-flight marker rather than a result.
    if (!Array.isArray((value as AddSuggestedResult).added)) {
      return {
        status: 'in_flight',
        message: '追加を処理中です。少し待ってから買い物リストを確認してください。',
      };
    }

    // The work happened but the ledger could not record it, so a retry would
    // be refused and we cannot say what landed. Send them to look.
    if (!stored) {
      return {
        status: 'unknown',
        message: '結果を確定できません。買い物リストを確認してください。',
      };
    }

    return { status: 'done', ...(value as AddSuggestedResult) };
  } catch (error) {
    if (error instanceof IdempotencyUnavailableError) {
      // Nothing ran, so the same key is still safe to reuse.
      return {
        status: 'unavailable',
        message: '追加できませんでした。もう一度お試しください。',
      };
    }
    if (error instanceof IdempotentWriteUnresolvedError) {
      // Rows may exist. Offering a retry here is how a double-add happens.
      return {
        status: 'unknown',
        message: '結果を確定できません。買い物リストを確認してください。',
      };
    }
    throw error;
  }
}
