import { describe, expect, it } from 'vitest';

import {
  classifyMealCandidate,
  isStapleSeasoning,
  missingStaples,
  surplusItems,
  usesExpiringIngredient,
} from './classification';

/**
 * PHASE 3 — 「今あるもので何作れる？」強化.
 *
 * There is no recipe catalog here: the model proposes dishes and reports
 * what they are missing. What must be right is the deterministic part —
 * which staples the user really has, and which bucket a reported shortfall
 * lands in.
 */

function item(overrides: Partial<Parameters<typeof missingStaples>[0][number]> = {}) {
  return {
    name: '醤油',
    quantity: null,
    unit: null,
    quantity_state: 'available' as const,
    ...overrides,
  };
}

describe('isStapleSeasoning', () => {
  it('recognises a staple by its canonical name', () => {
    expect(isStapleSeasoning('醤油')).toBe(true);
  });

  it('resolves an alias to a staple', () => {
    // しょうゆ → 醤油, サラダ油 → 油
    expect(isStapleSeasoning('しょうゆ')).toBe(true);
    expect(isStapleSeasoning('サラダ油')).toBe(true);
  });

  it('does not treat an ordinary ingredient as a staple', () => {
    expect(isStapleSeasoning('鶏もも肉')).toBe(false);
    expect(isStapleSeasoning('玉ねぎ')).toBe(false);
  });
});

describe('missingStaples', () => {
  it('reports every staple as missing from an empty inventory', () => {
    expect(missingStaples([])).toContain('醤油');
    expect(missingStaples([])).toHaveLength(10);
  });

  it('excludes a staple that is in stock', () => {
    const result = missingStaples([item({ name: '醤油' })]);
    expect(result).not.toContain('醤油');
    expect(result).toContain('味噌');
  });

  it('resolves aliases when checking stock (しょうゆ counts as 醤油)', () => {
    const result = missingStaples([item({ name: 'しょうゆ' })]);
    expect(result).not.toContain('醤油');
  });

  it('does not count an empty item as available', () => {
    const result = missingStaples([item({ name: '醤油', quantity_state: 'empty' })]);
    expect(result).toContain('醤油');
  });
});

describe('surplusItems', () => {
  it('keeps only plenty, available items', () => {
    const items = [
      item({ name: '米', quantity_state: 'plenty' }),
      item({ name: '卵', quantity_state: 'available' }),
      item({ name: '牛乳', quantity_state: 'plenty', quantity: 0 }),
    ];
    expect(surplusItems(items).map((i) => i.name)).toEqual(['米']);
  });
});

describe('classifyMealCandidate', () => {
  it('is fully_stocked when nothing is missing', () => {
    expect(classifyMealCandidate([])).toBe('fully_stocked');
  });

  it('is staples_only when only basic seasonings are missing', () => {
    expect(classifyMealCandidate(['醤油', 'みりん'])).toBe('staples_only');
  });

  it('is one_missing when exactly one non-staple ingredient is missing', () => {
    expect(classifyMealCandidate(['鶏もも肉'])).toBe('one_missing');
  });

  it('does not let a staple inflate the missing count', () => {
    expect(classifyMealCandidate(['鶏もも肉', '醤油'])).toBe('one_missing');
  });

  it('is few_missing for two or three non-staple ingredients', () => {
    expect(classifyMealCandidate(['鶏もも肉', '玉ねぎ'])).toBe('few_missing');
    expect(classifyMealCandidate(['鶏もも肉', '玉ねぎ', '人参'])).toBe('few_missing');
  });

  it('is not_feasible past three non-staple ingredients', () => {
    expect(classifyMealCandidate(['鶏もも肉', '玉ねぎ', '人参', 'じゃが芋'])).toBe('not_feasible');
  });
});

describe('usesExpiringIngredient', () => {
  it('matches when a candidate uses a near-expiry item', () => {
    expect(usesExpiringIngredient(['鶏もも肉', '玉ねぎ'], ['鶏もも肉'])).toBe(true);
  });

  it('matches through aliasing', () => {
    expect(usesExpiringIngredient(['たまねぎ'], ['玉ねぎ'])).toBe(true);
  });

  it('is false when no ingredient is near expiry', () => {
    expect(usesExpiringIngredient(['鶏もも肉'], ['牛乳'])).toBe(false);
  });

  it('is false when nothing is expiring', () => {
    expect(usesExpiringIngredient(['鶏もも肉'], [])).toBe(false);
  });
});
