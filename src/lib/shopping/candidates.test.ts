import { describe, expect, it } from 'vitest';

import type { MissingIngredient } from '@/lib/meals/evaluate';

import { missingIngredientsToShoppingCandidates } from './candidates';

function missing(
  name: string,
  reason: MissingIngredient['reason'] = 'absent',
  isStaple = false,
): MissingIngredient {
  return { name, reason, isStaple };
}

describe('missingIngredientsToShoppingCandidates', () => {
  it('preserves reason and isStaple', () => {
    const result = missingIngredientsToShoppingCandidates([
      missing('醤油', 'out_of_stock', true),
      missing('牛肉', 'expired', false),
    ]);

    expect(result).toEqual([
      { name: '醤油', reason: 'out_of_stock', isStaple: true },
      { name: '牛肉', reason: 'expired', isStaple: false },
    ]);
  });

  it('does not produce duplicate candidates for spelling variants that share a shoppingKey', () => {
    const result = missingIngredientsToShoppingCandidates([
      missing('たまご'),
      missing('タマゴ'),
      missing('卵'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('たまご');
  });

  it('keeps different ingredients as separate candidates', () => {
    const result = missingIngredientsToShoppingCandidates([missing('卵'), missing('牛乳')]);

    expect(result.map((c) => c.name)).toEqual(['卵', '牛乳']);
  });

  it('preserves input order', () => {
    const result = missingIngredientsToShoppingCandidates([
      missing('人参'),
      missing('じゃが芋'),
      missing('玉ねぎ'),
    ]);

    expect(result.map((c) => c.name)).toEqual(['人参', 'じゃが芋', '玉ねぎ']);
  });

  it('does not create a candidate for a blank or whitespace-only name', () => {
    const result = missingIngredientsToShoppingCandidates([
      missing(''),
      missing('   '),
      missing('卵'),
    ]);

    expect(result.map((c) => c.name)).toEqual(['卵']);
  });
});
