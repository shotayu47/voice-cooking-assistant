import { describe, expect, it } from 'vitest';

import {
  classifyInventoryUtterance,
  decideInventoryAdd,
  refusedInventoryOutput,
} from './inventory-intent';

/**
 * "かつお節を買い物候補に入れて" wrote an inventory row: 10g of かつお節 in the
 * pantry, which the user had never said they owned. Worse, holding it made it
 * ineligible as a shopping candidate, so the request defeated its own purpose.
 *
 * Fail-closed, like the cooking-step gate. The distinction is possession: an
 * inventory row is a claim that the food is *here*.
 */

describe('a shopping request never writes an inventory row', () => {
  for (const utterance of [
    'かつお節を買い物候補に入れて',
    '買い物リストに追加して',
    '買うものに入れて',
    'かつお節が必要',
    'だしの材料が足りない',
  ]) {
    it(`refuses "${utterance}"`, () => {
      expect(classifyInventoryUtterance(utterance)).toBe('shopping');
      expect(decideInventoryAdd(utterance)).toBe('refuse_shopping_intent');
    });
  }
});

describe('an explicit possession does add one', () => {
  for (const utterance of [
    'かつお節を在庫に追加して',
    'かつお節を買ってきたから在庫に入れて',
    '家にかつお節がある',
    '冷蔵庫に豆腐を追加して',
    '冷凍庫にエビをストックしてる',
  ]) {
    it(`allows "${utterance}"`, () => {
      expect(classifyInventoryUtterance(utterance)).toBe('inventory');
      expect(decideInventoryAdd(utterance)).toBe('allow');
    });
  }

  it('is not fooled by the word "buy" inside an inventory statement', () => {
    // The whole point: "買ってきた" is how someone says the food is now here.
    // Matching the bare character 買 would reject the clearest allow case.
    expect(decideInventoryAdd('かつお節を買ってきたので在庫に追加して')).toBe('allow');
    expect(decideInventoryAdd('スーパーで買ってきた豆腐を冷蔵庫に入れて')).toBe('allow');
  });
});

describe('default deny', () => {
  it('refuses an utterance that reads both ways', () => {
    // "家に無いから買い物リストに入れて" mentions the house and the list. A
    // possession recorded on a guess is the failure being avoided.
    expect(classifyInventoryUtterance('家に無いから買い物リストに入れて')).toBe('ambiguous');
    expect(decideInventoryAdd('家に無いから買い物リストに入れて')).toBe('refuse_unclear');
  });

  it('refuses when no transcript could be correlated', () => {
    expect(decideInventoryAdd(null)).toBe('refuse_unclear');
    expect(decideInventoryAdd(undefined)).toBe('refuse_unclear');
    expect(decideInventoryAdd('')).toBe('refuse_unclear');
    expect(decideInventoryAdd('   ')).toBe('refuse_unclear');
  });

  it('refuses an utterance naming neither', () => {
    expect(decideInventoryAdd('かつお節')).toBe('refuse_unclear');
    expect(classifyInventoryUtterance(42 as unknown as string)).toBe('ambiguous');
  });

  it('refuses every repeat, so a retried call still writes nothing', () => {
    // The decision is stateless: refusing twice is refusing twice.
    const utterance = 'かつお節を買い物候補に入れて';
    expect(decideInventoryAdd(utterance)).toBe('refuse_shopping_intent');
    expect(decideInventoryAdd(utterance)).toBe('refuse_shopping_intent');
  });
});

describe('what the model is told', () => {
  it('returns an output, so it is not left waiting', () => {
    const output = refusedInventoryOutput('refuse_shopping_intent') as Record<string, unknown>;

    expect(output.added).toBe(false);
    expect(output.reason).toBe('refuse_shopping_intent');
    expect(String(output.message).length).toBeGreaterThan(0);
  });

  it('says plainly that nothing was added', () => {
    const output = refusedInventoryOutput('refuse_shopping_intent') as Record<string, unknown>;

    expect(String(output.message)).toContain('在庫には追加していません');
    expect(String(output.message)).toContain('在庫に追加したと言わないでください');
  });

  it('names where a shopping request actually belongs', () => {
    // Otherwise the model has no idea what to do instead and tries again.
    const output = refusedInventoryOutput('refuse_shopping_intent') as Record<string, unknown>;

    expect(String(output.message)).toContain('suggest_shopping_items');
  });

  it('asks for a clearer instruction when the intent was unreadable', () => {
    const output = refusedInventoryOutput('refuse_unclear') as Record<string, unknown>;

    expect(String(output.message)).toContain('在庫に追加して');
    expect(String(output.message)).toContain('買い物候補に入れて');
  });
});
