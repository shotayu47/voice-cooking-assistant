/**
 * Parses a future AI tool's `selected` payload into `ShoppingCandidate[]`.
 *
 * Pure: no I/O, no `createShoppingItem` call, no AI tool definition. This only
 * decides whether the wire payload is well-formed and how it maps onto the
 * existing domain type — the same DB-free boundary as `candidates.ts`.
 */

import { z } from 'zod';

import { MISSING_REASONS } from '@/lib/meals/evaluate';
import type { ShoppingCandidate } from '@/lib/shopping/candidates';

/**
 * A server-provided candidate after the user has selected it.
 *
 * `quantity` / `unit` are not candidate facts: they are optional details the
 * user may add while confirming the selection (for example, "味噌を1個").
 * Keeping them separate from `ShoppingCandidate` prevents suggestion code
 * from inventing an amount for a missing ingredient.
 */
export type SelectedShoppingCandidate = ShoppingCandidate & {
  quantity?: number;
  unit?: string;
};

const selectedShoppingCandidateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    reason: z.enum(MISSING_REASONS),
    is_staple: z.boolean(),
    quantity: z.number().positive().finite().optional(),
    unit: z.string().trim().min(1).max(30).optional(),
  })
  .strict()
  .refine((value) => value.unit === undefined || value.quantity !== undefined, {
    message: '単位を使うときは数量も必要です',
    path: ['unit'],
  });

const selectedShoppingCandidatesSchema = z.array(selectedShoppingCandidateSchema);

/**
 * Validates `input` as an array of wire candidates and maps each to the
 * selected domain shape (`is_staple` -> `isStaple`), preserving an amount
 * only when it was supplied explicitly.
 *
 * Throws the normal Zod validation error on anything malformed, so callers
 * (a future tool handler's `executeTool`) can classify the failure themselves
 * rather than this module deciding what an invalid payload means.
 */
export function parseSelectedShoppingCandidates(input: unknown): SelectedShoppingCandidate[] {
  const parsed = selectedShoppingCandidatesSchema.parse(input);

  return parsed.map(({ name, reason, is_staple, quantity, unit }) => ({
    name,
    reason,
    isStaple: is_staple,
    ...(quantity === undefined ? {} : { quantity }),
    ...(unit === undefined ? {} : { unit }),
  }));
}
