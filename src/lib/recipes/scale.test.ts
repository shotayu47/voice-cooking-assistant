import { describe, expect, it } from 'vitest';

import type { Recipe } from '@/types/domain';
import {
  CAPACITY_NOTE,
  HEAT_AND_TIME_NOTE,
  isValidServings,
  MAX_SERVINGS,
  resolveScaling,
  scaleRecipe,
  scaledIngredientByName,
  withoutScaling,
  withTargetServings,
} from './scale';

const recipe: Recipe = {
  title: '鶏の照り焼き',
  servings: 2,
  ingredients: [
    { name: '鶏もも肉', amount: 300, unit: 'g', required: true },
    { name: '卵', amount: 1, unit: '個', required: true },
    { name: '醤油', amount: 2, unit: '大さじ', required: true },
    { name: '塩', required: true },
    { name: '揚げ油', amount: 500, unit: 'ml', required: true },
    { name: '青ねぎ', amount: 1, unit: '本', required: false },
  ],
  steps: [{ index: 0, instruction: '鶏もも肉を一口大に切る', ingredientRefs: ['鶏もも肉'] }],
};

const amountOf = (view: ReturnType<typeof scaleRecipe>, name: string) =>
  view.ingredients.find((entry) => entry.name === name);

describe('resolveScaling', () => {
  it('treats a recipe with no scaling metadata as unadjusted', () => {
    expect(resolveScaling(recipe)).toEqual({
      baseServings: 2,
      targetServings: 2,
      factor: 1,
      adjusted: false,
    });
  });

  it('reads a snapshot written before PHASE 8', () => {
    // No `scaling` key at all — every pre-PHASE 8 session snapshot looks
    // like this, and none of them may break.
    const legacy = { ...recipe, servings: 4 } as Recipe;
    expect(resolveScaling(legacy).baseServings).toBe(4);
    expect(resolveScaling(legacy).adjusted).toBe(false);
  });

  it('falls back to a usable base when the stored servings are nonsense', () => {
    expect(resolveScaling({ ...recipe, servings: 0 }).baseServings).toBe(1);
    expect(
      resolveScaling({ ...recipe, scaling: { baseServings: -3, targetServings: 2 } })
        .baseServings,
    ).toBe(2);
  });
});

describe('withTargetServings', () => {
  it('records the target without touching the amounts', () => {
    const adjusted = withTargetServings(recipe, 4);

    expect(adjusted.scaling).toEqual({ baseServings: 2, targetServings: 4 });
    // The point of the whole design: the recipe as written survives.
    expect(adjusted.ingredients).toEqual(recipe.ingredients);
    expect(adjusted.servings).toBe(2);
  });

  it('always rescales from the original base, never from the last result', () => {
    const twice = withTargetServings(withTargetServings(recipe, 4), 3);

    expect(twice.scaling).toEqual({ baseServings: 2, targetServings: 3 });
    expect(amountOf(scaleRecipe(twice), '鶏もも肉')?.amount).toBe(450);

    // 2 → 4 → 3 → 2 must land exactly back on the recipe's own figure. A
    // design that overwrote the amounts would drift here.
    const backToStart = withTargetServings(twice, 2);
    expect(amountOf(scaleRecipe(backToStart), '鶏もも肉')?.amount).toBe(300);
    expect(amountOf(scaleRecipe(backToStart), '卵')?.amount).toBe(1);
  });

  it('can be removed entirely', () => {
    expect(withoutScaling(withTargetServings(recipe, 4)).scaling).toBeUndefined();
  });
});

describe('scaleRecipe', () => {
  it('multiplies ordinary amounts by the servings ratio', () => {
    const view = scaleRecipe(withTargetServings(recipe, 4));

    expect(view.factor).toBe(2);
    expect(amountOf(view, '鶏もも肉')).toMatchObject({
      amount: 600,
      baseAmount: 300,
      display: '600g',
      policy: 'linear',
    });
    expect(amountOf(view, '醤油')?.display).toBe('大さじ4');
  });

  it('scales down as readily as up', () => {
    const view = scaleRecipe(withTargetServings(recipe, 1));
    expect(amountOf(view, '鶏もも肉')?.amount).toBe(150);
    expect(amountOf(view, '醤油')?.amount).toBe(1);
  });

  it('keeps a fractional count exact instead of rounding it to a whole', () => {
    // 1個 at 2 servings, cooked for 3. Rounding to 2個 would change the recipe
    // by a third of an egg without saying so; 「1と1/2個」 is the truth, and
    // the assistant can explain beating it and using half.
    const view = scaleRecipe(withTargetServings(recipe, 3));
    expect(amountOf(view, '卵')).toMatchObject({ amount: 1.5, display: '1と1/2個' });
  });

  it('does not invent a number for 適量 / 少々', () => {
    const view = scaleRecipe(withTargetServings(recipe, 4));
    expect(amountOf(view, '塩')).toMatchObject({ policy: 'no_amount', amount: null });
  });

  it('leaves amounts fixed by the pan alone', () => {
    const view = scaleRecipe(withTargetServings(recipe, 4));
    expect(amountOf(view, '揚げ油')).toMatchObject({ policy: 'pan_bound', amount: 500 });
  });

  it('scales a plain 油 like anything else', () => {
    // 「油」 is only pan-bound when the recipe says so. Guessing that a
    // tablespoon of frying oil means a pan full of it is how a wrong number
    // gets in silently.
    const withCookingOil: Recipe = {
      ...recipe,
      ingredients: [{ name: '油', amount: 1, unit: '大さじ', required: true }],
    };
    const view = scaleRecipe(withTargetServings(withCookingOil, 4));
    expect(amountOf(view, '油')).toMatchObject({ policy: 'linear', amount: 2 });
  });

  it('never scales cooking time or heat', () => {
    const adjusted = withTargetServings(recipe, 4);
    expect(adjusted.steps).toEqual(recipe.steps);
    expect(scaleRecipe(adjusted).notes).toContain(HEAT_AND_TIME_NOTE);
  });

  it('warns about the pan once the amount doubles', () => {
    expect(scaleRecipe(withTargetServings(recipe, 4)).notes).toContain(CAPACITY_NOTE);
    expect(scaleRecipe(withTargetServings(recipe, 3)).notes).not.toContain(CAPACITY_NOTE);
  });

  it('says nothing when nothing was adjusted', () => {
    expect(scaleRecipe(recipe).notes).toEqual([]);
    expect(scaleRecipe(recipe).adjusted).toBe(false);
  });

  it('survives a recipe with no ingredients', () => {
    const empty = { ...recipe, ingredients: [] };
    expect(scaleRecipe(withTargetServings(empty, 4)).ingredients).toEqual([]);
  });
});

describe('scaledIngredientByName', () => {
  it('resolves through the same name folding as the rest of the app', () => {
    const adjusted = withTargetServings(recipe, 4);
    expect(scaledIngredientByName(adjusted, '鶏もも肉')?.amount).toBe(600);
    expect(scaledIngredientByName(adjusted, '存在しない')).toBeNull();
  });
});

describe('isValidServings', () => {
  it('accepts whole servings within the recipe schema ceiling', () => {
    expect(isValidServings(1)).toBe(true);
    expect(isValidServings(MAX_SERVINGS)).toBe(true);
  });

  it('rejects everything that would produce a nonsense amount', () => {
    expect(isValidServings(0)).toBe(false);
    expect(isValidServings(-2)).toBe(false);
    expect(isValidServings(2.5)).toBe(false);
    expect(isValidServings(MAX_SERVINGS + 1)).toBe(false);
    expect(isValidServings('4')).toBe(false);
    expect(isValidServings(null)).toBe(false);
    expect(isValidServings(Number.NaN)).toBe(false);
  });
});
