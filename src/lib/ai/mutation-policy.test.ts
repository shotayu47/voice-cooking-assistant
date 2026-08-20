import { describe, expect, it } from 'vitest';

import { isMutation } from './service';

/**
 * PHASE 10.3b3a: membership only. add_selected_shopping_candidates must be
 * classified as a persistent mutation in the existing text-turn guard.
 */
describe('isMutation', () => {
  it('classifies add_selected_shopping_candidates as a mutation', () => {
    expect(isMutation('add_selected_shopping_candidates')).toBe(true);
  });

  it('keeps existing mutations classified as mutations', () => {
    expect(isMutation('add_inventory_item')).toBe(true);
    expect(isMutation('update_inventory_item')).toBe(true);
    expect(isMutation('consume_inventory_item')).toBe(true);
    expect(isMutation('create_recipe')).toBe(true);
    expect(isMutation('start_cooking_session')).toBe(true);
    expect(isMutation('finish_cooking_session')).toBe(true);
  });

  it('keeps read-only tools unclassified', () => {
    expect(isMutation('search_meal_candidates')).toBe(false);
    expect(isMutation('get_inventory')).toBe(false);
  });
});
