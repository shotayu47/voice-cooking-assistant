import { describe, expect, it } from 'vitest';

import { describeCompletedWork, outcomeChangedShopping } from './service';

/**
 * PHASE 10.4b2: shoppingChanged must reflect only an executed ToolOutcome
 * whose effect is truthfully 'shopping_changed' — never the mere presence
 * of a shopping tool name, a zero-result, an error, or a duplicate-suppressed
 * replay (which all carry no `effect`).
 */
describe('outcomeChangedShopping', () => {
  it('is false by default for an outcome with no effect', () => {
    expect(outcomeChangedShopping({})).toBe(false);
    expect(outcomeChangedShopping({ effect: undefined })).toBe(false);
  });

  it('is true only for a shopping_changed effect', () => {
    expect(outcomeChangedShopping({ effect: 'shopping_changed' })).toBe(true);
  });

  it('is false for other real effects', () => {
    expect(outcomeChangedShopping({ effect: 'inventory_changed' })).toBe(false);
    expect(outcomeChangedShopping({ effect: 'session_changed' })).toBe(false);
  });

  it('is false for an error result carrying no effect', () => {
    expect(outcomeChangedShopping({})).toBe(false);
  });

  it('is false for a duplicate-suppressed replay carrying no effect', () => {
    // Mirrors the synthetic outcome the text loop returns for an
    // already-applied mutation: result only, no effect field.
    expect(outcomeChangedShopping({})).toBe(false);
  });
});

describe('describeCompletedWork', () => {
  it('reports plain failure when nothing changed, even if a shopping tool name appeared', () => {
    const reply = describeCompletedWork(['add_selected_shopping_candidates'], false, false);
    expect(reply).toBe('返答の生成に失敗しました。もう一度お試しください。在庫は変更されていません。');
    expect(reply).not.toContain('買い物');
  });

  it('mentions only the shopping list when shoppingChanged is true', () => {
    const reply = describeCompletedWork(['add_selected_shopping_candidates'], false, true);
    expect(reply).toContain('買い物リストへの追加は反映されました');
    expect(reply).not.toContain('在庫の変更');
    expect(reply).not.toContain('工程の移動');
  });

  it('mentions only the inventory when inventoryChanged is true', () => {
    const reply = describeCompletedWork(['add_inventory_item'], true, false);
    expect(reply).toContain('在庫の変更は反映されました');
    expect(reply).not.toContain('買い物');
  });

  it('mentions only the step move when a step tool ran with no other effect', () => {
    const reply = describeCompletedWork(['advance_cooking_step'], false, false);
    expect(reply).toContain('工程の移動は反映されました');
    expect(reply).not.toContain('買い物');
    expect(reply).not.toContain('在庫の変更');
  });

  it('combines all true categories truthfully', () => {
    const reply = describeCompletedWork(
      ['add_inventory_item', 'advance_cooking_step', 'add_selected_shopping_candidates'],
      true,
      true,
    );
    expect(reply).toContain('在庫の変更・買い物リストへの追加・工程の移動は反映されました');
  });
});
