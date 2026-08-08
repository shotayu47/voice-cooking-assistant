/**
 * How far the fridge actually goes (PHASE 8).
 *
 * Two questions, both answered against real inventory rather than by the model:
 *   - 「今ある分で何人分作れる？」 → `maxServingsFromInventory`
 *   - 「もう入れた分はどれだけ？」 → `ingredientProgress`
 *
 * The rule both share: an amount that cannot be verified is reported as
 * unverified, never dropped. Silently excluding 醤油 because its quantity is
 * unknown and then announcing 「最大4人分です」 is a confident answer built on
 * a fact nobody checked.
 *
 * Pure: takes inventory rows and returns verdicts. No I/O.
 */

import { freshnessOf } from '@/lib/inventory/freshness';
import { foldName, normalizeIngredientName, resolveInventoryItem } from '@/lib/inventory/normalize';
import { isAvailable } from '@/lib/inventory/quantity';
import type { InventoryItem, Recipe, UsedIngredient } from '@/types/domain';
import { MAX_SERVINGS, resolveScaling, scaleRecipe } from './scale';
import { convertAmount, formatAmount } from './units';

/** How much of the answer rests on something we could actually measure. */
export type CapacityStatus =
  /** Every required amount was checked against a tracked quantity. */
  | 'exact'
  /** Some were checked; at least one could not be. Do not state a flat maximum. */
  | 'partial'
  /** Nothing could be checked. There is no maximum to report. */
  | 'unknown';

export type UnverifiedReason =
  /** The recipe says 適量 / 少々 — there is no amount to compare. */
  | 'no_amount'
  /** In stock, but the quantity is not tracked (「醤油 1本」 with no volume). */
  | 'not_tracked'
  /** Stock and recipe are measured in units that cannot be converted (g vs 個). */
  | 'unit_mismatch'
  /** Several inventory items match the name; picking one would be a guess. */
  | 'ambiguous';

export const UNVERIFIED_REASON_LABELS: Record<UnverifiedReason, string> = {
  no_amount: '分量が「適量」なので計算できない',
  not_tracked: '在庫の数量が記録されていない',
  unit_mismatch: '単位が比較できない',
  ambiguous: '該当する在庫が複数あって特定できない',
};

export type BlockingReason = 'absent' | 'out_of_stock' | 'expired';

export const BLOCKING_REASON_LABELS: Record<BlockingReason, string> = {
  absent: '在庫にない',
  out_of_stock: '在庫切れ',
  expired: '消費期限切れ',
};

export type VerifiedConstraint = {
  name: string;
  itemName: string;
  /** Stock on hand, converted into the recipe's unit. */
  available: number;
  unit: string | null;
  /** How much one serving needs. */
  perServing: number;
  /** Servings this one ingredient allows. */
  servings: number;
};

export type UnverifiedConstraint = {
  name: string;
  reason: UnverifiedReason;
  reasonLabel: string;
};

export type ServingsCapacity = {
  status: CapacityStatus;
  /** Null when nothing could be verified. Never a guess. */
  maxServings: number | null;
  /** The ingredient that runs out first, or the one that is missing outright. */
  limiting:
    | { name: string; kind: 'blocking'; reason: BlockingReason; reasonLabel: string }
    | { name: string; kind: 'quantity'; constraint: VerifiedConstraint }
    | null;
  verified: VerifiedConstraint[];
  unverified: UnverifiedConstraint[];
  /** True when stock would allow more than the recipe schema's ceiling. */
  cappedAtMax: boolean;
};

/**
 * An item past its 消費期限 is not stock. 賞味期限 is a quality date, so
 * something slightly past it still counts — the same rule PHASE 3 uses.
 */
function isUsable(item: InventoryItem, today?: string): boolean {
  if (!isAvailable(item)) return false;
  const freshness = freshnessOf(item, today);
  if (!freshness) return true;
  return !(freshness.kind === 'use_by' && freshness.level === 'expired');
}

/**
 * The largest number of servings the current inventory supports.
 *
 * Only ingredients marked required constrain the answer; an optional garnish
 * running out does not stop dinner.
 */
export function maxServingsFromInventory(
  recipe: Recipe,
  inventory: InventoryItem[],
  options: { today?: string } = {},
): ServingsCapacity {
  const { baseServings } = resolveScaling(recipe);

  const verified: VerifiedConstraint[] = [];
  const unverified: UnverifiedConstraint[] = [];
  let blocking: ServingsCapacity['limiting'] = null;

  const addUnverified = (name: string, reason: UnverifiedReason) => {
    unverified.push({ name, reason, reasonLabel: UNVERIFIED_REASON_LABELS[reason] });
  };

  const block = (name: string, reason: BlockingReason) => {
    if (blocking) return;
    blocking = { name, kind: 'blocking', reason, reasonLabel: BLOCKING_REASON_LABELS[reason] };
  };

  for (const ingredient of recipe.ingredients ?? []) {
    if (ingredient.required === false) continue;

    const name = ingredient.name?.trim();
    if (!name) continue;

    const resolution = resolveInventoryItem(name, inventory);

    if (resolution.status === 'not_found') {
      block(name, 'absent');
      continue;
    }
    if (resolution.status === 'ambiguous') {
      // Averaging over the candidates, or picking the largest, would be a
      // guess about which one the recipe means.
      addUnverified(name, 'ambiguous');
      continue;
    }

    const item = resolution.item;

    if (!isUsable(item, options.today)) {
      const freshness = freshnessOf(item, options.today);
      const expired = freshness?.kind === 'use_by' && freshness.level === 'expired';
      block(name, expired ? 'expired' : 'out_of_stock');
      continue;
    }

    // The recipe says 適量 — in stock, but nothing to measure against.
    const needed =
      typeof ingredient.amount === 'number' && Number.isFinite(ingredient.amount)
        ? ingredient.amount
        : null;
    if (needed === null || needed <= 0) {
      addUnverified(name, 'no_amount');
      continue;
    }

    if (item.quantity === null || item.quantity === undefined) {
      addUnverified(name, 'not_tracked');
      continue;
    }

    const available = convertAmount(item.quantity, item.unit, ingredient.unit ?? null);
    if (available === null) {
      addUnverified(name, 'unit_mismatch');
      continue;
    }

    const perServing = needed / baseServings;
    if (!Number.isFinite(perServing) || perServing <= 0) {
      addUnverified(name, 'no_amount');
      continue;
    }

    verified.push({
      name,
      itemName: item.name,
      available: Math.round(available * 1000) / 1000,
      unit: ingredient.unit ?? null,
      perServing: Math.round(perServing * 1000) / 1000,
      servings: Math.floor(available / perServing),
    });
  }

  if (blocking) {
    return {
      status: unverified.length > 0 ? 'partial' : 'exact',
      maxServings: 0,
      limiting: blocking,
      verified,
      unverified,
      cappedAtMax: false,
    };
  }

  if (verified.length === 0) {
    return {
      status: 'unknown',
      maxServings: null,
      limiting: null,
      verified,
      unverified,
      cappedAtMax: false,
    };
  }

  const tightest = verified.reduce((lowest, entry) =>
    entry.servings < lowest.servings ? entry : lowest,
  );
  const cappedAtMax = tightest.servings > MAX_SERVINGS;

  return {
    status: unverified.length > 0 ? 'partial' : 'exact',
    maxServings: Math.min(tightest.servings, MAX_SERVINGS),
    limiting: { name: tightest.name, kind: 'quantity', constraint: tightest },
    verified,
    unverified,
    cappedAtMax,
  };
}

export type IngredientProgressStatus =
  /** Nothing recorded and no completed step referencing it. */
  | 'not_started'
  /** Some went in; a measurable amount is still owed. */
  | 'partially_added'
  /** The recorded amount already covers the new target. */
  | 'satisfied'
  /** Something happened, but how much is not knowable. Do not state a figure. */
  | 'unknown';

export type IngredientProgress = {
  name: string;
  status: IngredientProgressStatus;
  /** Where the conclusion came from — recorded consumption beats inference. */
  source: 'used_ingredients' | 'completed_steps' | 'none';
  /** What the current target needs in total. */
  requiredAmount: number | null;
  /** What was actually consumed, in the recipe's unit. */
  usedAmount: number | null;
  /** Still to add. Null whenever it cannot be computed. */
  remainingAmount: number | null;
  unit: string | null;
  /** 「あと200g」 — ready to read aloud. Empty when unknown. */
  remainingDisplay: string;
  note?: string;
};

function sameIngredient(
  recipeName: string,
  recipeItemId: string | null | undefined,
  used: UsedIngredient,
): boolean {
  if (recipeItemId && used.inventoryItemId && recipeItemId === used.inventoryItemId) {
    return true;
  }
  if (!used.name) return false;

  const left = foldName(normalizeIngredientName(recipeName));
  const right = foldName(normalizeIngredientName(used.name));
  return left !== '' && left === right;
}

/**
 * What has already gone into the pan, per ingredient.
 *
 * Ordering matters and is deliberate:
 *   1. `used_ingredients` — an actual record of what was consumed, written by
 *      PHASE 5 as inventory was decremented.
 *   2. `completed_steps` — only ever evidence that *something* was added. A
 *      finished step says nothing about how much.
 *   3. Neither — say so. An unverifiable amount is reported as unknown rather
 *      than assumed to be the recipe's figure.
 *
 * This is what makes 「必要400g / 記録200g → あと200g」 a computed difference
 * rather than a guess.
 */
export function ingredientProgress(
  recipe: Recipe,
  input: {
    usedIngredients?: UsedIngredient[] | null;
    completedSteps?: number[] | null;
  },
): IngredientProgress[] {
  const scaled = scaleRecipe(recipe);
  const used = input.usedIngredients ?? [];
  const completed = new Set(input.completedSteps ?? []);
  const steps = recipe.steps ?? [];

  return scaled.ingredients.map((ingredient) => {
    const recipeIngredient = (recipe.ingredients ?? []).find(
      (entry) => entry.name === ingredient.name,
    );
    const base: Omit<IngredientProgress, 'status' | 'source'> = {
      name: ingredient.name,
      requiredAmount: ingredient.amount,
      usedAmount: null,
      remainingAmount: null,
      unit: ingredient.unit,
      remainingDisplay: '',
    };

    // 1. Recorded consumption.
    const records = used.filter((entry) =>
      sameIngredient(ingredient.name, recipeIngredient?.inventoryItemId, entry),
    );

    if (records.length > 0) {
      let total = 0;
      let measurable = true;

      for (const record of records) {
        if (typeof record.amount !== 'number' || !Number.isFinite(record.amount)) {
          measurable = false;
          break;
        }
        const converted = convertAmount(record.amount, record.unit, ingredient.unit);
        if (converted === null) {
          measurable = false;
          break;
        }
        total += converted;
      }

      if (!measurable || ingredient.amount === null) {
        return {
          ...base,
          status: 'unknown',
          source: 'used_ingredients',
          note:
            ingredient.amount === null
              ? 'この材料は「適量」なので、残りを数値で出せません。'
              : '記録された量の単位が合わないため、残りを計算できません。ユーザーに確認してください。',
        };
      }

      const usedAmount = Math.round(total * 1000) / 1000;
      const remaining = Math.round((ingredient.amount - usedAmount) * 1000) / 1000;

      if (remaining <= 0) {
        return {
          ...base,
          status: 'satisfied',
          source: 'used_ingredients',
          usedAmount,
          remainingAmount: 0,
        };
      }

      return {
        ...base,
        status: 'partially_added',
        source: 'used_ingredients',
        usedAmount,
        remainingAmount: remaining,
        remainingDisplay: formatAmount(remaining, ingredient.unit),
      };
    }

    // 2. A completed step mentioning it. Evidence, not a quantity.
    const referencedByCompletedStep = steps.some(
      (step) =>
        completed.has(step.index) &&
        (step.ingredientRefs ?? []).some((ref) => foldName(ref) === foldName(ingredient.name)),
    );

    if (referencedByCompletedStep) {
      return {
        ...base,
        status: 'unknown',
        source: 'completed_steps',
        note:
          'この材料を使う工程は完了していますが、入れた量は記録されていません。' +
          '何をどれだけ入れたかユーザーに確認してください。',
      };
    }

    // 3. Nothing to go on.
    return { ...base, status: 'not_started', source: 'none' };
  });
}
