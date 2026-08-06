import { describe, expect, it } from 'vitest';

import type { InventoryItem } from '@/types/domain';
import { foldName, normalizeIngredientName, resolveInventoryItem } from './normalize';

function item(name: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `id-${name}`,
    user_id: 'user',
    name,
    normalized_name: normalizeIngredientName(name),
    category: null,
    quantity: null,
    unit: null,
    quantity_state: 'available',
    storage_location: null,
    expiry_date: null,
    opened: false,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('foldName', () => {
  it('folds width, case, whitespace and kana form into one key', () => {
    expect(foldName('　玉ねぎ ')).toBe(foldName('玉ネギ'));
    expect(foldName('Ｃｈｉｃｋｅｎ')).toBe('chicken');
    expect(foldName('ﾆﾝﾆｸ')).toBe(foldName('にんにく'));
  });
});

describe('normalizeIngredientName', () => {
  it('resolves aliases to a canonical name (SPEC §14)', () => {
    expect(normalizeIngredientName('鶏もも')).toBe('鶏もも肉');
    expect(normalizeIngredientName('鳥もも')).toBe('鶏もも肉');
    expect(normalizeIngredientName('チキン')).toBe('鶏肉');
    expect(normalizeIngredientName('chicken thigh')).toBe('鶏もも肉');
  });

  it('leaves unknown names alone rather than guessing', () => {
    expect(normalizeIngredientName('ヤンニョムソース')).toBe('ヤンニョムソース');
  });

  it('trims and normalises width without changing meaning', () => {
    expect(normalizeIngredientName('  トマト  ')).toBe('トマト');
  });
});

describe('resolveInventoryItem', () => {
  const inventory = [item('鶏もも肉'), item('玉ねぎ'), item('醤油')];

  it('matches an exact name', () => {
    const result = resolveInventoryItem('玉ねぎ', inventory);
    expect(result.status).toBe('matched');
    expect(result.status === 'matched' && result.item.name).toBe('玉ねぎ');
  });

  it('matches through the alias dictionary', () => {
    const result = resolveInventoryItem('たまねぎ', inventory);
    expect(result.status === 'matched' && result.item.name).toBe('玉ねぎ');
  });

  it('matches a partial name when it is unambiguous', () => {
    const result = resolveInventoryItem('鶏もも', inventory);
    expect(result.status === 'matched' && result.item.name).toBe('鶏もも肉');
  });

  it('reports ambiguity instead of picking one', () => {
    const result = resolveInventoryItem('鶏', [item('鶏もも肉'), item('鶏むね肉')]);
    expect(result.status).toBe('ambiguous');
    expect(result.status === 'ambiguous' && result.candidates).toHaveLength(2);
  });

  it('does not merge genuinely different ingredients', () => {
    const result = resolveInventoryItem('片栗粉', inventory);
    expect(result.status).toBe('not_found');
  });

  // A generic term shares no substring with the specific cut, so without the
  // generic tier 「鶏肉使った」 is wrongly answered "you don't have that".
  it('treats a generic term with several matches as ambiguous', () => {
    const result = resolveInventoryItem('鶏肉', [item('鶏もも肉'), item('鶏むね肉')]);

    expect(result.status).toBe('ambiguous');
    expect(result.status === 'ambiguous' && result.candidates.map((c) => c.name)).toEqual([
      '鶏もも肉',
      '鶏むね肉',
    ]);
  });

  it('resolves a generic term when only one item is covered', () => {
    const result = resolveInventoryItem('鶏肉', [item('鶏もも肉'), item('玉ねぎ')]);
    expect(result.status === 'matched' && result.item.name).toBe('鶏もも肉');
  });

  it('does not let a generic term reach an unrelated ingredient', () => {
    const result = resolveInventoryItem('牛肉', [item('鶏もも肉'), item('玉ねぎ')]);
    expect(result.status).toBe('not_found');
  });

  it('still reports not_found when the category has no stock at all', () => {
    expect(resolveInventoryItem('魚', [item('鶏もも肉')]).status).toBe('not_found');
  });

  it('returns not_found for an empty inventory', () => {
    expect(resolveInventoryItem('玉ねぎ', []).status).toBe('not_found');
  });
});
