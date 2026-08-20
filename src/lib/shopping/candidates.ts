/**
 * Turns `MissingIngredient[]` (from meal evaluation) into shopping candidates.
 *
 * Pure: no I/O, no `createShoppingItem` call. This only decides *what* the
 * candidates are, not whether or how they get written to the shopping list.
 */

import type { MissingIngredient } from '@/lib/meals/evaluate';
import { shoppingKey } from '@/lib/shopping/dedupe';

export type ShoppingCandidate = Pick<MissingIngredient, 'name' | 'reason' | 'isStaple'>;

/**
 * Builds shopping candidates from missing ingredients, folding duplicates
 * that `shoppingKey()` considers the same ingredient into one candidate.
 *
 * Blank names produce no candidate. Order is the first-seen order of the
 * input; a later duplicate does not move its candidate or overwrite its
 * `reason`/`isStaple` — the first occurrence wins.
 */
export function missingIngredientsToShoppingCandidates(
  missing: readonly MissingIngredient[],
): ShoppingCandidate[] {
  const candidates: ShoppingCandidate[] = [];
  const seen = new Set<string>();

  for (const ingredient of missing) {
    const name = ingredient.name.trim();
    if (!name) continue;

    const key = shoppingKey(name);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);

    candidates.push({ name, reason: ingredient.reason, isStaple: ingredient.isStaple });
  }

  return candidates;
}
