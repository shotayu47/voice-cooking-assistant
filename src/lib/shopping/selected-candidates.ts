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

const selectedShoppingCandidateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    reason: z.enum(MISSING_REASONS),
    is_staple: z.boolean(),
  })
  .strict();

const selectedShoppingCandidatesSchema = z.array(selectedShoppingCandidateSchema);

/**
 * Validates `input` as an array of wire candidates and maps each to the
 * domain `ShoppingCandidate` shape (`is_staple` -> `isStaple`).
 *
 * Throws the normal Zod validation error on anything malformed, so callers
 * (a future tool handler's `executeTool`) can classify the failure themselves
 * rather than this module deciding what an invalid payload means.
 */
export function parseSelectedShoppingCandidates(input: unknown): ShoppingCandidate[] {
  const parsed = selectedShoppingCandidatesSchema.parse(input);

  return parsed.map(({ name, reason, is_staple }) => ({
    name,
    reason,
    isStaple: is_staple,
  }));
}
