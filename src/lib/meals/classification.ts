/**
 * Meal-candidate classification (PHASE 3).
 *
 * There is no recipe database to match against — the model invents dish
 * ideas itself from the inventory it is given. What this module provides is
 * the deterministic part: which basic seasonings the user actually has
 * (real inventory, not a guess), and the bucket a candidate falls into once
 * the model reports which of its ingredients are missing. Pure functions
 * only, so the bucket boundaries are testable without a model in the loop.
 */

import type { InventoryItem } from '@/types/domain';
import { foldName, normalizeIngredientName } from '@/lib/inventory/normalize';
import { isAvailable, type QuantitySnapshot } from '@/lib/inventory/quantity';

/**
 * Basic seasonings a Japanese home kitchen is assumed to restock rather than
 * shop for specially. Hand-curated and kept small on purpose — the same
 * caution as `INGREDIENT_ALIASES`: a wrong entry here misclassifies a real
 * shopping requirement as "already have it".
 */
export const STAPLE_SEASONINGS = [
  '塩',
  '胡椒',
  '醤油',
  '味噌',
  '砂糖',
  '酢',
  'みりん',
  '料理酒',
  '油',
  'ゴマ油',
] as const;

const STAPLE_KEYS = new Set(STAPLE_SEASONINGS.map((name) => foldName(name)));

/** Whether a (possibly free-text) ingredient name names a staple seasoning. */
export function isStapleSeasoning(name: string): boolean {
  const canonical = foldName(normalizeIngredientName(name));
  if (!canonical) return false;
  if (STAPLE_KEYS.has(canonical)) return true;
  for (const key of STAPLE_KEYS) {
    if (canonical.includes(key) || key.includes(canonical)) return true;
  }
  return false;
}

type StapleCheckItem = Pick<InventoryItem, 'name'> & QuantitySnapshot;

/**
 * Which staple seasonings the user does NOT currently have available. Used
 * to tell "調味料だけ追加すれば作れる" apart from a real missing ingredient —
 * computed from real inventory rows, not assumed.
 */
export function missingStaples(items: StapleCheckItem[]): string[] {
  const available = new Set(
    items.filter(isAvailable).map((item) => foldName(normalizeIngredientName(item.name))),
  );
  return STAPLE_SEASONINGS.filter((staple) => !available.has(foldName(staple)));
}

/** Items the user has more than enough of — candidates for a fridge-cleanup meal. */
export function surplusItems<T extends QuantitySnapshot>(items: T[]): T[] {
  return items.filter((item) => item.quantity_state === 'plenty' && isAvailable(item));
}

export const MEAL_CANDIDATE_BUCKETS = [
  'fully_stocked',
  'staples_only',
  'one_missing',
  'few_missing',
  'not_feasible',
] as const;
export type MealCandidateBucket = (typeof MEAL_CANDIDATE_BUCKETS)[number];

export const MEAL_CANDIDATE_BUCKET_LABELS: Record<MealCandidateBucket, string> = {
  fully_stocked: '今あるものだけで作れる',
  staples_only: '調味料だけ追加すれば作れる',
  one_missing: 'あと1品あれば作れる',
  few_missing: 'あと2〜3品買えば作れる',
  not_feasible: '不足が多く現実的ではない',
};

/**
 * Bucket a candidate by what it is missing. Staple seasonings are excluded
 * from the "real" missing count first — being out of 醤油 does not belong in
 * the same bucket as being out of the dish's main ingredient.
 */
export function classifyMealCandidate(missingRequired: string[]): MealCandidateBucket {
  if (missingRequired.length === 0) return 'fully_stocked';

  const nonStaple = missingRequired.filter((name) => !isStapleSeasoning(name));
  if (nonStaple.length === 0) return 'staples_only';
  if (nonStaple.length === 1) return 'one_missing';
  if (nonStaple.length <= 3) return 'few_missing';
  return 'not_feasible';
}

/** Whether any of a candidate's ingredients matches a currently near-expiry item. */
export function usesExpiringIngredient(
  ingredientNames: string[],
  expiringItemNames: string[],
): boolean {
  const expiringKeys = expiringItemNames
    .map((name) => foldName(normalizeIngredientName(name)))
    .filter(Boolean);
  if (expiringKeys.length === 0) return false;

  return ingredientNames.some((name) => {
    const key = foldName(normalizeIngredientName(name));
    if (!key) return false;
    return expiringKeys.some((ek) => ek === key || ek.includes(key) || key.includes(ek));
  });
}
