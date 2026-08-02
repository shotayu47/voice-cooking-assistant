import { z } from 'zod';

import { DIFFICULTIES } from '@/types/domain';

/**
 * Recipe shape (SPEC §9). The model produces these, so the schema is the
 * boundary that keeps a malformed generation out of the database — and out of
 * a cooking session whose step count must be trustworthy.
 */

export const recipeIngredientSchema = z.object({
  inventoryItemId: z.uuid().optional().nullable(),
  name: z.string().trim().min(1).max(100),
  amount: z.number().positive().finite().optional().nullable(),
  unit: z.string().trim().max(20).optional().nullable(),
  required: z.boolean().default(true),
  substituteOptions: z.array(z.string().trim().min(1).max(100)).max(5).optional(),
});

export const recipeStepSchema = z.object({
  index: z.number().int().nonnegative(),
  instruction: z.string().trim().min(1).max(500),
  durationSeconds: z.number().int().positive().max(60 * 60 * 6).optional().nullable(),
  heat: z
    .object({
      type: z.enum(['ih_10', 'low_medium_high']).default('ih_10'),
      value: z.number().int().min(1).max(10).optional().nullable(),
      label: z.string().trim().max(30).optional().nullable(),
    })
    .optional()
    .nullable(),
  ingredientRefs: z.array(z.string().trim().min(1)).max(10).optional(),
  safetyNote: z.string().trim().max(300).optional().nullable(),
});

export const recipeSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  servings: z.number().int().positive().max(20).default(1),
  estimatedMinutes: z.number().int().positive().max(600).optional().nullable(),
  difficulty: z.enum(DIFFICULTIES).optional().nullable(),
  ingredients: z.array(recipeIngredientSchema).min(1).max(40),
  steps: z
    .array(recipeStepSchema)
    .min(1, '手順が空のレシピは開始できません')
    .max(40),
});

export type ParsedRecipe = z.output<typeof recipeSchema>;

/**
 * Re-index steps to 0..n-1 in array order. The model is asked for sequential
 * indices but the cooking session addresses steps positionally, so this
 * guarantees they agree.
 */
export function normalizeStepIndices(recipe: ParsedRecipe): ParsedRecipe {
  return {
    ...recipe,
    steps: recipe.steps.map((step, index) => ({ ...step, index })),
  };
}
