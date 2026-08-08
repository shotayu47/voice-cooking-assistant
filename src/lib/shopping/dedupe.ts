/**
 * Duplicate detection for the shopping list — detection only.
 *
 * 「卵 6個」 and 「卵 1パック」 are two legitimate lines. Merging them would
 * silently discard what the user wrote, and the amounts often cannot be added
 * anyway (`sameUnit('個', 'パック')` is false). So nothing here merges, sums,
 * or rejects: it reports that a match exists and lets the caller say so.
 *
 * This mirrors the restraint the rest of the app already practices — PHASE 1
 * refuses to invent an expiry it cannot derive, PHASE 2 refuses to invent a
 * quantity it was not told.
 */

import { foldName, normalizeIngredientName } from '@/lib/inventory/normalize';
import type { ShoppingItem } from '@/types/domain';

/** The subset of a row this module needs, so callers can pass partial data. */
export type DuplicateCandidate = Pick<ShoppingItem, 'id' | 'name' | 'checked'>;

/**
 * Comparison key for a shopping line.
 *
 * `normalizeIngredientName` resolves aliases (たまご → 卵) and `foldName`
 * absorbs the rest: full-width/half-width, case, whitespace, and separators.
 * Running both is what makes 「タマゴ」 and 「ﾀﾏｺﾞ」 and 「 卵 」 one key.
 */
export function shoppingKey(name: string): string {
  return foldName(normalizeIngredientName(name));
}

/**
 * Existing unchecked lines that mean the same ingredient as `name`.
 *
 * Checked items are excluded on purpose: a line the user already bought is not
 * a reason to warn them about buying it again. Buying the same thing on a later
 * trip is normal, and the bulk clear is what removes those rows.
 *
 * Returns every match rather than the first — two duplicates is a different
 * message from one, and the caller decides how to phrase it.
 */
export function findDuplicates<T extends DuplicateCandidate>(
  name: string,
  existing: readonly T[],
): T[] {
  const key = shoppingKey(name);
  if (key === '') return [];

  return existing.filter((item) => !item.checked && shoppingKey(item.name) === key);
}
