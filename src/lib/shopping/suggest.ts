/**
 * What is worth buying, worked out from recipes the server already stored.
 *
 * The model does not get to say what is missing. It nominates recipes by the
 * id `create_recipe` handed back, and everything after that — which
 * ingredients those recipes need, whether the fridge has them, why not, and
 * how much — is read from the database here. This is the same division PHASE 3
 * settled on: the model may invent dishes, but whether something is in the
 * fridge is a fact, and facts are decided server-side.
 *
 * Pure: takes rows in, returns suggestions out. No I/O.
 */

import { evaluateCandidate } from '@/lib/meals/evaluate';
import { MISSING_REASON_LABELS, type MissingReason } from '@/lib/meals/evaluate';
import type { InventoryItem, RecipeIngredient, ShoppingItem } from '@/types/domain';

import { findDuplicates, shoppingKey } from './dedupe';

/** How many recipes one suggestion call may draw on. */
export const MAX_SUGGESTION_RECIPES = 5;

/** The recipe fields this module needs — a subset of `StoredRecipe`. */
export type SuggestionRecipe = {
  id: string;
  title: string;
  ingredients: RecipeIngredient[];
};

/** Which recipe asked for this ingredient. */
export type SuggestionSource = {
  recipeId: string;
  title: string;
};

export type ShoppingSuggestion = {
  name: string;
  reason: MissingReason;
  reasonLabel: string;
  /** Only ever set from a recipe's own amount. Never estimated or summed. */
  quantity: number | null;
  unit: string | null;
  isStaple: boolean;
  /** True when an unchecked line with the same folded name is already on the
   *  list. A warning, not a veto — see PHASE 9. */
  alreadyOnList: boolean;
  sourceRecipes: SuggestionSource[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cleans the recipe ids the model supplied.
 *
 * Anything that is not a uuid is dropped rather than passed to the database —
 * the id is the one thing the model hands us, so it is the one thing that
 * needs checking. The cap keeps one turn from fanning out into an unbounded
 * number of reads.
 */
export function normalizeRecipeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const ids: string[] = [];

  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim().toLowerCase();
    if (!UUID.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_SUGGESTION_RECIPES) break;
  }

  return ids;
}

/**
 * The amount to carry onto the shopping line.
 *
 * A quantity with no unit is fine (「卵 2」); a unit with no quantity is not,
 * and the database refuses it. So an ingredient with no amount contributes
 * nothing rather than a bare unit.
 */
function amountOf(ingredient: RecipeIngredient): { quantity: number | null; unit: string | null } {
  const quantity =
    typeof ingredient.amount === 'number' && Number.isFinite(ingredient.amount) && ingredient.amount > 0
      ? ingredient.amount
      : null;

  return {
    quantity,
    unit: quantity === null ? null : (ingredient.unit?.trim() || null),
  };
}

/**
 * Turns stored recipes into a shopping list proposal.
 *
 * Nothing here writes. The caller shows the result and the user decides — a
 * suggestion that added itself would be the app doing the shopping.
 */
export function buildShoppingSuggestions(
  recipes: readonly SuggestionRecipe[],
  inventory: InventoryItem[],
  shoppingItems: readonly ShoppingItem[],
  options: { includeStaples?: boolean; today?: string } = {},
): ShoppingSuggestion[] {
  const merged = new Map<string, ShoppingSuggestion>();

  for (const recipe of recipes) {
    // Optional ingredients are never proposed: PHASE 3 already decided they
    // are nice-to-haves, and putting them on a shopping list turns a
    // suggestion into a bigger errand than the user asked for.
    const required = recipe.ingredients.filter((ingredient) => ingredient.required);
    if (required.length === 0) continue;

    // The authority on "is this missing, and why" — the same function the
    // meal-candidate path uses. `expiring` is deliberately empty: being near
    // its date is not a reason to buy something you still have. Only absent,
    // out of stock, and past a 消費期限 count, and `evaluateCandidate`
    // derives all three from the inventory rows themselves.
    const verdict = evaluateCandidate(
      { title: recipe.title, requiredIngredients: required.map((item) => item.name) },
      inventory,
      { expiring: [], today: options.today },
    );

    for (const missing of verdict.missing) {
      if (missing.isStaple && !options.includeStaples) continue;

      const key = shoppingKey(missing.name);
      if (key === '') continue;

      const source: SuggestionSource = { recipeId: recipe.id, title: recipe.title };
      const existing = merged.get(key);

      if (!existing) {
        const ingredient = required.find((item) => item.name === missing.name);
        merged.set(key, {
          name: missing.name,
          reason: missing.reason,
          reasonLabel: MISSING_REASON_LABELS[missing.reason],
          ...(ingredient ? amountOf(ingredient) : { quantity: null, unit: null }),
          isStaple: missing.isStaple,
          alreadyOnList: findDuplicates(missing.name, shoppingItems).length > 0,
          sourceRecipes: [source],
        });
        continue;
      }

      if (!existing.sourceRecipes.some((entry) => entry.recipeId === recipe.id)) {
        existing.sourceRecipes.push(source);
        // Two recipes wanting the same thing gives two amounts, and adding
        // them up would be inventing a number — 「大さじ2」 and 「200g」 do not
        // combine. Drop to a bare name and let the user write what they want.
        existing.quantity = null;
        existing.unit = null;
      }
    }
  }

  return [...merged.values()];
}
