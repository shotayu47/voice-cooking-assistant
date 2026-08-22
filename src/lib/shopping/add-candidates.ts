import 'server-only';

import type { ServiceContext } from '@/lib/inventory/service';

import {
  addSelectedShoppingCandidates as addSelected,
  type AddedShoppingCandidate,
} from './add-candidates-core';
import type { SelectedShoppingCandidate } from './selected-candidates';
import { createShoppingItem } from './service';

export type { AddedShoppingCandidate } from './add-candidates-core';

/**
 * The real write boundary: wires the DI'd core to the actual
 * `createShoppingItem` service call for the given user.
 *
 * No independent `shopping_items` insert exists here or in the core — every
 * row this produces went through the same validation, normalization, and
 * duplicate detection as a manually typed line.
 */
export async function addSelectedShoppingCandidates(
  ctx: ServiceContext,
  selected: readonly SelectedShoppingCandidate[],
): Promise<AddedShoppingCandidate[]> {
  return addSelected({ create: (input) => createShoppingItem(ctx, input) }, selected);
}
