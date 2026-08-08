/**
 * Amount scaling (PHASE 8).
 *
 * The model writes the sentence; the arithmetic happens here. Letting a
 * language model multiply amounts in prose produces two failures that are hard
 * to see: a quietly wrong number (250g × 1.5 = 350g), and — worse — the
 * cooking time being scaled along with the ingredients.
 *
 * The recipe as written is never rewritten. `scaling` records the base and the
 * target, and every figure below is derived from the base, so 2 → 4 → 3
 * servings recomputes rather than compounds.
 *
 * Pure: no I/O, no model calls.
 */

import { foldName } from '@/lib/inventory/normalize';
import type { Recipe, RecipeScaling } from '@/types/domain';
import { formatAmount } from './units';

/** Matches the recipe schema's own ceiling. */
export const MAX_SERVINGS = 20;

export type ScalePolicy =
  /** Multiplied by the servings ratio. The default, and the common case. */
  | 'linear'
  /** Decided by the pan, not by how many people are eating. Not multiplied. */
  | 'pan_bound'
  /** 「適量」「少々」 — no number to scale, and none is invented. */
  | 'no_amount';

export type ScaledIngredient = {
  name: string;
  policy: ScalePolicy;
  /** Amount for the target servings. Null when there was no number. */
  amount: number | null;
  unit: string | null;
  /** The recipe's own amount, for the base servings. */
  baseAmount: number | null;
  /** Ready to read aloud: 「1と1/2個」. */
  display: string;
  required: boolean;
  note?: string;
};

export type ScaledRecipeView = {
  baseServings: number;
  targetServings: number;
  factor: number;
  /** False when the target equals the base — nothing was adjusted. */
  adjusted: boolean;
  ingredients: ScaledIngredient[];
  /** Things the numbers alone do not say. Meant to be passed to the user. */
  notes: string[];
};

/**
 * The rule the whole phase exists to protect.
 *
 * Doubling the food does not double the time — and it does not leave it
 * unchanged either. Which way it moves depends on the pan, the depth of the
 * food and the thickness of each piece, none of which this app can see. So the
 * honest output is "we did not touch it, check for doneness", not a multiplier.
 */
export const HEAT_AND_TIME_NOTE =
  '加熱時間と火力は自動で倍率変更していません。量・鍋の大きさ・食材の厚みによって変わるため、' +
  '火の通りを確認しながら調整し、必要なら分けて調理してください。';

export const CAPACITY_NOTE =
  '鍋やフライパンに入りきるか確認してください。詰め込むと焼けずに蒸れます。分けて調理する方が確実です。';

export const NO_AMOUNT_NOTE =
  '「適量」「少々」と書かれた材料は数値化していません。味を見て調整してください。';

export const PAN_BOUND_NOTE =
  '揚げ油やゆで湯は鍋の大きさで決まる量なので倍率を掛けていません。';

/** Above this ratio the pan itself becomes the limit, not the ingredients. */
const CAPACITY_WARNING_FACTOR = 2;

/**
 * Amounts fixed by the pan rather than by the number of eaters.
 *
 * Deliberately a tiny list of unambiguous names. 「油」 alone is not on it and
 * must not be: 揚げ油 is pan-bound, 炒め油 大さじ1 scales perfectly well, and
 * guessing which one a given line means is exactly the kind of inference that
 * produces a silently wrong number. Anything not matched here scales linearly.
 * Additions are a code-review decision, like the PHASE 7 playbook.
 */
const PAN_BOUND_NAMES = ['揚げ油', '揚げ用油', '揚げ物用油', 'ゆで湯', '茹で湯', 'ゆでる湯'];

const PAN_BOUND_KEYS = PAN_BOUND_NAMES.map(foldName);

function isPanBound(name: string): boolean {
  const key = foldName(name);
  return PAN_BOUND_KEYS.some((pattern) => key.includes(pattern));
}

/** A servings count we are willing to compute with. */
export function isValidServings(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SERVINGS
  );
}

function usableServings(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(value, MAX_SERVINGS);
}

/**
 * The base and target for a recipe, tolerating everything older data can be.
 *
 * A snapshot written before PHASE 8 has no `scaling` at all, so its own
 * `servings` is both the base and the target — it was never adjusted.
 */
export function resolveScaling(recipe: Recipe): {
  baseServings: number;
  targetServings: number;
  factor: number;
  adjusted: boolean;
} {
  const base =
    usableServings(recipe.scaling?.baseServings) ?? usableServings(recipe.servings) ?? 1;
  const target = usableServings(recipe.scaling?.targetServings) ?? base;

  return {
    baseServings: base,
    targetServings: target,
    factor: target / base,
    adjusted: target !== base,
  };
}

/**
 * Record a new target. The ingredient amounts are untouched — this is the
 * whole point: the base stays available for every later change.
 */
export function withTargetServings(recipe: Recipe, targetServings: number): Recipe {
  const { baseServings } = resolveScaling(recipe);
  const scaling: RecipeScaling = { baseServings, targetServings };
  return { ...recipe, scaling };
}

/** Undo any adjustment, returning to the recipe as written. */
export function withoutScaling(recipe: Recipe): Recipe {
  const next = { ...recipe };
  delete next.scaling;
  return next;
}

function scaleIngredient(
  ingredient: Recipe['ingredients'][number],
  factor: number,
): ScaledIngredient {
  const baseAmount =
    typeof ingredient.amount === 'number' && Number.isFinite(ingredient.amount)
      ? ingredient.amount
      : null;
  const unit = ingredient.unit ?? null;
  const required = ingredient.required !== false;

  // 「適量」「少々」. There is no number, so there is nothing to multiply and
  // nothing to invent.
  if (baseAmount === null) {
    return {
      name: ingredient.name,
      policy: 'no_amount',
      amount: null,
      unit,
      baseAmount: null,
      display: formatAmount(null, unit),
      required,
      note: '数量の指定がありません。味を見て調整してください。',
    };
  }

  if (isPanBound(ingredient.name)) {
    return {
      name: ingredient.name,
      policy: 'pan_bound',
      amount: baseAmount,
      unit,
      baseAmount,
      display: formatAmount(baseAmount, unit),
      required,
      note: '鍋の大きさで決まる量のため倍率を掛けていません。',
    };
  }

  // Full precision is kept; rounding happens only where it is displayed. A
  // 1.5個 egg stays 1.5個 rather than becoming 2 — the exact ratio is what
  // makes 2 → 4 → 3 servings return the original number.
  const amount = roundAmount(baseAmount * factor);

  return {
    name: ingredient.name,
    policy: 'linear',
    amount,
    unit,
    baseAmount,
    display: formatAmount(amount, unit),
    required,
  };
}

/** Trim binary-float noise without losing real precision (as PHASE 2 does). */
function roundAmount(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Every amount for the recipe's current target, plus what the numbers do not
 * say. This is a derived view — calling it never changes the recipe.
 */
export function scaleRecipe(recipe: Recipe): ScaledRecipeView {
  const { baseServings, targetServings, factor, adjusted } = resolveScaling(recipe);
  const ingredients = (recipe.ingredients ?? []).map((ingredient) =>
    scaleIngredient(ingredient, factor),
  );

  const notes: string[] = [];
  if (adjusted) notes.push(HEAT_AND_TIME_NOTE);
  if (factor >= CAPACITY_WARNING_FACTOR) notes.push(CAPACITY_NOTE);
  if (adjusted && ingredients.some((entry) => entry.policy === 'no_amount')) {
    notes.push(NO_AMOUNT_NOTE);
  }
  if (adjusted && ingredients.some((entry) => entry.policy === 'pan_bound')) {
    notes.push(PAN_BOUND_NOTE);
  }

  return { baseServings, targetServings, factor, adjusted, ingredients, notes };
}

/** The scaled amounts for one ingredient name, or null when unknown. */
export function scaledIngredientByName(
  recipe: Recipe,
  name: string,
): ScaledIngredient | null {
  const key = foldName(name);
  return (
    scaleRecipe(recipe).ingredients.find((entry) => foldName(entry.name) === key) ?? null
  );
}
