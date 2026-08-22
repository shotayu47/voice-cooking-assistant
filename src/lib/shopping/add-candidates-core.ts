/**
 * Writes exactly the shopping candidates the caller selected — nothing more.
 *
 * This is a write *boundary*, not a suggestion engine: it takes no
 * `MissingIngredient[]` and does not decide which candidates matter. A caller
 * (a future PHASE's tool handler, or a UI action) must name each candidate it
 * wants written. Given dependencies instead of a real service context, so the
 * decision of "which candidates get a row" is testable without a database —
 * matching the DI pattern in `actions-core.ts`.
 */

import type { SelectedShoppingCandidate } from './selected-candidates';
import type { CreateShoppingItemResult } from './service';

export type AddCandidatesDeps = {
  create: (input: {
    name: string;
    quantity?: number;
    unit?: string;
  }) => Promise<CreateShoppingItemResult>;
};

/** One candidate's write result, still paired with the candidate it came from. */
export type AddedShoppingCandidate = CreateShoppingItemResult & {
  candidate: SelectedShoppingCandidate;
};

/**
 * Adds each selected candidate through `deps.create`, one call per candidate.
 *
 * Sequential, not parallel: if a call fails partway through, the rejection
 * propagates immediately instead of the function resolving with a result
 * array that quietly omits the failure or, worse, invents one. Nothing here
 * catches — a failed write is a failed call, not a value to return.
 */
export async function addSelectedShoppingCandidates(
  deps: AddCandidatesDeps,
  selected: readonly SelectedShoppingCandidate[],
): Promise<AddedShoppingCandidate[]> {
  const results: AddedShoppingCandidate[] = [];

  for (const candidate of selected) {
    const { item, duplicates } = await deps.create({
      name: candidate.name,
      ...(candidate.quantity === undefined ? {} : { quantity: candidate.quantity }),
      ...(candidate.unit === undefined ? {} : { unit: candidate.unit }),
    });
    results.push({ candidate, item, duplicates });
  }

  return results;
}
