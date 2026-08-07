import { z } from 'zod';

import { DIFFICULTIES } from '@/types/domain';

/**
 * PHASE 3 — the boundary between what the model claims and what the app
 * evaluates. The model may only submit dishes and their ingredient lists;
 * feasibility is computed server-side, so there is nothing here for it to
 * assert about the inventory.
 */

export const candidateIngredientSchema = z.object({
  name: z.string().trim().min(1).max(100),
  amount: z.number().positive().finite().max(100_000).optional().nullable(),
  unit: z.string().trim().max(20).optional().nullable(),
  required: z.boolean().optional().nullable().default(true),
});

export const mealCandidateSchema = z.object({
  title: z.string().trim().min(1).max(100),
  estimated_minutes: z.number().int().positive().max(600).optional().nullable(),
  difficulty: z.enum(DIFFICULTIES).optional().nullable(),
  reason: z.string().trim().max(200).optional().nullable(),
  ingredients: z.array(candidateIngredientSchema).min(1).max(30),
});

/** SPEC §11.2 caps proposals at 3〜5; 6 leaves a little slack before refusing. */
export const evaluateMealCandidatesSchema = z.object({
  candidates: z.array(mealCandidateSchema).min(1).max(6),
  mode: z.enum(['normal', 'cleanout']).optional().nullable().default('normal'),
});

export type EvaluateMealCandidatesInput = z.input<typeof evaluateMealCandidatesSchema>;
