import { describe, expect, it } from 'vitest';

import type { Recipe } from '@/types/domain';
import {
  advanceStep,
  goToStep,
  ingredientsForStep,
  isFinalStep,
  previousStep,
  stepAt,
  stepProgress,
  withStepMarked,
  withStepUnmarked,
} from './steps';

const recipe: Recipe = {
  title: 'チーズタッカルビ',
  servings: 1,
  ingredients: [
    { name: '鶏もも肉', amount: 300, unit: 'g', required: true },
    { name: '玉ねぎ', amount: 1, unit: '個', required: true },
    { name: 'キャベツ', required: false },
  ],
  steps: [
    { index: 0, instruction: '玉ねぎを薄切りにする', ingredientRefs: ['玉ねぎ'] },
    { index: 1, instruction: '鶏もも肉を一口大に切る', ingredientRefs: ['鶏もも肉'] },
    { index: 2, instruction: 'フライパンを中火で温める' },
  ],
};

describe('advanceStep', () => {
  it('moves forward exactly one step', () => {
    expect(advanceStep(0, 3)).toEqual({ currentStep: 1, changed: true, isFinalStep: false });
    expect(advanceStep(1, 3)).toEqual({ currentStep: 2, changed: true, isFinalStep: true });
  });

  it('does not advance beyond the final step', () => {
    expect(advanceStep(2, 3)).toEqual({ currentStep: 2, changed: false, isFinalStep: true });
  });

  it('pulls an out-of-range step back into range', () => {
    expect(advanceStep(99, 3).currentStep).toBe(2);
  });
});

describe('previousStep', () => {
  it('moves back exactly one step', () => {
    expect(previousStep(2, 3)).toEqual({ currentStep: 1, changed: true, isFinalStep: false });
  });

  it('does not move before the first step', () => {
    expect(previousStep(0, 3)).toEqual({ currentStep: 0, changed: false, isFinalStep: false });
  });
});

describe('final-step boundary', () => {
  it('recognises the last index', () => {
    expect(isFinalStep(2, 3)).toBe(true);
    expect(isFinalStep(1, 3)).toBe(false);
  });

  it('treats a single-step recipe as immediately final', () => {
    expect(isFinalStep(0, 1)).toBe(true);
    expect(advanceStep(0, 1)).toEqual({ currentStep: 0, changed: false, isFinalStep: true });
  });

  it('never reports a final step for an empty recipe', () => {
    expect(isFinalStep(0, 0)).toBe(false);
    expect(advanceStep(0, 0).currentStep).toBe(0);
  });
});

describe('goToStep', () => {
  it('clamps into range', () => {
    expect(goToStep(-5, 3).currentStep).toBe(0);
    expect(goToStep(10, 3).currentStep).toBe(2);
  });
});

// PHASE 5 — once a step can be skipped, "before the current step" stops
// meaning "completed".
describe('withStepMarked', () => {
  it('adds an index in order', () => {
    expect(withStepMarked([0, 2], 1)).toEqual([0, 1, 2]);
  });

  it('is a union — marking twice does not duplicate', () => {
    expect(withStepMarked([0, 1], 1)).toEqual([0, 1]);
  });

  it('does not mutate the input', () => {
    const original = [0];
    withStepMarked(original, 1);
    expect(original).toEqual([0]);
  });
});

describe('withStepUnmarked', () => {
  it('removes an index', () => {
    expect(withStepUnmarked([0, 1, 2], 1)).toEqual([0, 2]);
  });

  it('is a no-op when the index is absent', () => {
    expect(withStepUnmarked([0, 2], 1)).toEqual([0, 2]);
  });
});

describe('stepProgress', () => {
  it('reports what is done, skipped and left', () => {
    expect(stepProgress(4, [0, 1], [2])).toEqual({
      completed: [0, 1],
      skipped: [2],
      remaining: [3],
      isFinished: false,
    });
  });

  it('is finished only when nothing is outstanding', () => {
    expect(stepProgress(3, [0, 1, 2], []).isFinished).toBe(true);
    expect(stepProgress(3, [0, 1], [2]).isFinished).toBe(true);
    expect(stepProgress(3, [0, 1], []).isFinished).toBe(false);
  });

  it('treats a step later completed as no longer skipped', () => {
    const progress = stepProgress(2, [0], [0, 1]);
    expect(progress.completed).toEqual([0]);
    expect(progress.skipped).toEqual([1]);
  });

  it('ignores indices outside the recipe', () => {
    const progress = stepProgress(2, [0, 5, -1], [99]);
    expect(progress.completed).toEqual([0]);
    expect(progress.skipped).toEqual([]);
    expect(progress.remaining).toEqual([1]);
  });

  it('deduplicates and sorts', () => {
    expect(stepProgress(3, [2, 0, 0], []).completed).toEqual([0, 2]);
  });

  it('reports an empty recipe as unfinished rather than done', () => {
    expect(stepProgress(0, [], []).isFinished).toBe(false);
  });

  it('counts nothing as done at the start', () => {
    expect(stepProgress(3, [], [])).toMatchObject({
      completed: [],
      skipped: [],
      remaining: [0, 1, 2],
    });
  });
});

describe('stepAt', () => {
  it('returns the instruction for the current index', () => {
    expect(stepAt(recipe, 1)?.instruction).toBe('鶏もも肉を一口大に切る');
  });

  it('returns null when there are no steps', () => {
    expect(stepAt({ ...recipe, steps: [] }, 0)).toBeNull();
  });
});

describe('ingredientsForStep', () => {
  it('resolves referenced ingredients with their amounts', () => {
    expect(ingredientsForStep(recipe, 0)).toEqual(['玉ねぎ 1個']);
    expect(ingredientsForStep(recipe, 1)).toEqual(['鶏もも肉 300g']);
  });

  it('returns nothing for a step with no references', () => {
    expect(ingredientsForStep(recipe, 2)).toEqual([]);
  });

  it('falls back to the raw reference when the ingredient is unlisted', () => {
    const withUnknown: Recipe = {
      ...recipe,
      steps: [{ index: 0, instruction: '入れる', ingredientRefs: ['謎の粉'] }],
    };
    expect(ingredientsForStep(withUnknown, 0)).toEqual(['謎の粉']);
  });
});
