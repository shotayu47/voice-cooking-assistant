/**
 * Pure cooking-step state transitions (SPEC §8.9, §8.10, §13).
 *
 * `current_step` is 0-based. The database holds the real value; these helpers
 * only compute what the next value should be, and they refuse to move past
 * either boundary.
 */

import type { Recipe, RecipeStep } from '@/types/domain';

export type StepTransition = {
  /** The step index after the transition. Unchanged when it was refused. */
  currentStep: number;
  /** False when the transition hit a boundary and nothing moved. */
  changed: boolean;
  /** True when the resulting step is the last one. */
  isFinalStep: boolean;
};

function clamp(index: number, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  return Math.min(Math.max(index, 0), totalSteps - 1);
}

export function isFinalStep(currentStep: number, totalSteps: number): boolean {
  return totalSteps > 0 && currentStep >= totalSteps - 1;
}

/** 「次」 — move forward exactly one step, never past the last one. */
export function advanceStep(currentStep: number, totalSteps: number): StepTransition {
  const from = clamp(currentStep, totalSteps);
  const to = clamp(from + 1, totalSteps);
  return { currentStep: to, changed: to !== from, isFinalStep: isFinalStep(to, totalSteps) };
}

/** 「戻る」 — move back exactly one step, never before the first one. */
export function previousStep(currentStep: number, totalSteps: number): StepTransition {
  const from = clamp(currentStep, totalSteps);
  const to = clamp(from - 1, totalSteps);
  return { currentStep: to, changed: to !== from, isFinalStep: isFinalStep(to, totalSteps) };
}

/** Jump to an explicit index, clamped into range. */
export function goToStep(index: number, totalSteps: number): StepTransition {
  const to = clamp(index, totalSteps);
  return { currentStep: to, changed: true, isFinalStep: isFinalStep(to, totalSteps) };
}

export function stepAt(recipe: Recipe, index: number): RecipeStep | null {
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) return null;
  const clamped = clamp(index, recipe.steps.length);
  return recipe.steps[clamped] ?? null;
}

/**
 * Ingredients referenced by a step, resolved to display strings like
 * 「玉ねぎ 1個」 so cooking mode can show amounts for the current step only.
 */
export function ingredientsForStep(recipe: Recipe, index: number): string[] {
  const step = stepAt(recipe, index);
  if (!step?.ingredientRefs?.length) return [];

  return step.ingredientRefs.map((ref) => {
    const ingredient = recipe.ingredients.find((candidate) => candidate.name === ref);
    if (!ingredient) return ref;
    const amount = [ingredient.amount, ingredient.unit].filter(Boolean).join('');
    return amount ? `${ingredient.name} ${amount}` : ingredient.name;
  });
}
