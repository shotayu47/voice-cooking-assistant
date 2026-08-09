/**
 * The logic behind the shopping-list Server Actions, with its dependencies
 * passed in.
 *
 * The actions themselves stay thin wrappers that supply the real service
 * functions and `revalidatePath`. That keeps the parts worth testing — what
 * counts as invalid input, which message reaches the screen, and which path is
 * revalidated after a write — reachable from a plain unit test.
 */

import { shoppingKey } from './dedupe';
import type { CreateShoppingItemResult } from './service';
import { describeShoppingError, duplicateNotice, errorDetail } from './view';
import type { ShoppingItem } from '@/types/domain';

/** The only path a shopping mutation invalidates. Home and inventory link out
 *  to it statically and read no shopping rows, so neither needs revalidating. */
export const SHOPPING_PATH = '/shopping';

/** Raw strings straight off the form, before any interpretation. */
export type ShoppingFormFields = {
  name: string;
  quantity: string;
  unit: string;
};

export type ShoppingFormState = {
  error?: string;
  /** A duplicate notice. Not a failure — the row was still added. */
  warning?: string;
  /** Increments on each successful add, which is the form's cue to clear. */
  added?: number;
  /** Echoed back so an error does not wipe what the user typed. */
  values?: ShoppingFormFields;
};

export type MutationOutcome = { status: 'ok' } | { status: 'error'; message: string };

/** One line the user ticked on a suggestion card. */
export type PickedSuggestion = {
  name: string;
  quantity: number | null;
  unit: string | null;
};

export type AddSuggestedResult = {
  /** Names actually written. */
  added: string[];
  /** Names that could not be written, with a message safe to render. */
  failed: { name: string; message: string }[];
  /** Duplicate notices, in the wording PHASE 9 established. */
  notices: string[];
  /** Set when nothing was attempted. */
  error?: string;
};

export type ShoppingDeps = {
  create: (input: {
    name: string;
    quantity?: number | null;
    unit?: string | null;
  }) => Promise<CreateShoppingItemResult>;
  setChecked: (itemId: string, checked: boolean) => Promise<ShoppingItem | null>;
  remove: (itemId: string) => Promise<{ deleted: number }>;
  clearChecked: () => Promise<{ deleted: number }>;
  revalidate: (path: string) => void;
  /** Where the original error goes. Defaults to console.error. */
  log?: (message: string) => void;
};

function logWith(deps: ShoppingDeps, scope: string, error: unknown): void {
  (deps.log ?? ((message: string) => console.error(message)))(
    `[shopping] ${scope}: ${errorDetail(error)}`,
  );
}

/**
 * Parses the number field.
 *
 * An empty box means "no amount", which is the common case and not an error.
 * Anything else that is not a finite number is, because silently dropping a
 * typo would put a line on the list with an amount the user never sees again.
 */
function readQuantity(raw: string): { ok: true; value: number | null } | { ok: false } {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };

  const value = Number(text);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

/** Adds one line. Returns state for `useActionState`; never throws. */
export async function runCreate(
  deps: ShoppingDeps,
  previous: ShoppingFormState,
  fields: ShoppingFormFields,
): Promise<ShoppingFormState> {
  const name = fields.name.trim();
  const unit = fields.unit.trim();
  const added = previous.added ?? 0;
  // An error must leave the boxes as the user left them.
  const keep = { added, values: fields };

  if (name === '') {
    return { ...keep, error: '品名を入力してください' };
  }

  // Punctuation-only names survive `trim` but fold away to nothing, which the
  // database would reject on `normalized_name`.
  if (shoppingKey(name) === '') {
    return { ...keep, error: '品名を入力してください' };
  }

  const quantity = readQuantity(fields.quantity);
  if (!quantity.ok) {
    return { ...keep, error: '数量は数字で入力してください' };
  }

  if (unit !== '' && quantity.value === null) {
    return { ...keep, error: '単位を使うときは数量も入力してください' };
  }

  try {
    const { duplicates } = await deps.create({
      name,
      quantity: quantity.value,
      unit: unit === '' ? null : unit,
    });

    deps.revalidate(SHOPPING_PATH);

    return {
      added: added + 1,
      warning: duplicateNotice(name, duplicates.length),
    };
  } catch (error) {
    logWith(deps, 'create', error);
    return { ...keep, error: describeShoppingError(error) };
  }
}

/** Ticks or unticks one line. */
export async function runSetChecked(
  deps: ShoppingDeps,
  itemId: string,
  checked: boolean,
): Promise<MutationOutcome> {
  try {
    await deps.setChecked(itemId, checked);
    deps.revalidate(SHOPPING_PATH);
    return { status: 'ok' };
  } catch (error) {
    logWith(deps, 'setChecked', error);
    return { status: 'error', message: describeShoppingError(error) };
  }
}

/** Removes one line. A row already gone is not an error (double taps happen). */
export async function runDelete(deps: ShoppingDeps, itemId: string): Promise<MutationOutcome> {
  try {
    await deps.remove(itemId);
    deps.revalidate(SHOPPING_PATH);
    return { status: 'ok' };
  } catch (error) {
    logWith(deps, 'delete', error);
    return { status: 'error', message: describeShoppingError(error) };
  }
}

/** How many lines one confirmation may add. */
export const MAX_PICKED_SUGGESTIONS = 30;

/**
 * Adds the suggestions the user ticked.
 *
 * **Never throws.** The caller wraps this in the idempotency ledger, which
 * releases its claim on an exception so a genuine retry can run — and a retry
 * after a mid-way failure would re-create the lines that already succeeded.
 * So a failure part-way through is recorded as data and the run completes.
 *
 * Every value is re-validated here rather than trusted from the card: the
 * payload round-tripped through the browser, so by the time it comes back it
 * is client input again. Duplicate detection happens inside
 * `createShoppingItem`, against the list as it is now — not as it was when the
 * card was drawn.
 */
export async function runAddSuggested(
  deps: ShoppingDeps,
  picked: readonly PickedSuggestion[],
): Promise<AddSuggestedResult> {
  const empty: AddSuggestedResult = { added: [], failed: [], notices: [] };

  if (picked.length === 0) {
    return { ...empty, error: '追加するものを選んでください' };
  }
  if (picked.length > MAX_PICKED_SUGGESTIONS) {
    return { ...empty, error: '一度に追加できるのは30件までです' };
  }

  const added: string[] = [];
  const failed: { name: string; message: string }[] = [];
  const notices: string[] = [];

  for (const entry of picked) {
    const name = entry.name.trim();
    if (name === '' || shoppingKey(name) === '') {
      failed.push({ name: entry.name, message: '品名が正しくありません' });
      continue;
    }

    // A unit with no quantity is refused by the database; drop it here so the
    // line is created without one rather than failing.
    const quantity =
      typeof entry.quantity === 'number' && Number.isFinite(entry.quantity) && entry.quantity > 0
        ? entry.quantity
        : null;
    const unit = quantity === null ? null : (entry.unit?.trim() || null);

    try {
      const { duplicates } = await deps.create({ name, quantity, unit });
      added.push(name);

      const notice = duplicateNotice(name, duplicates.length);
      if (notice) notices.push(notice);
    } catch (error) {
      logWith(deps, 'addSuggested', error);
      failed.push({ name, message: describeShoppingError(error) });
    }
  }

  // Even a partial run changed the list, so the page has to be re-read.
  if (added.length > 0) deps.revalidate(SHOPPING_PATH);

  return { added, failed, notices };
}

/** Clears the bought lines. Unchecked lines are the service's to protect. */
export async function runClearChecked(deps: ShoppingDeps): Promise<MutationOutcome> {
  try {
    await deps.clearChecked();
    deps.revalidate(SHOPPING_PATH);
    return { status: 'ok' };
  } catch (error) {
    logWith(deps, 'clearChecked', error);
    return { status: 'error', message: describeShoppingError(error) };
  }
}
