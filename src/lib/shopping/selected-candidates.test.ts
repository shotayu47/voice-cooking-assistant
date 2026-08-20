import { describe, expect, it } from 'vitest';

import { parseSelectedShoppingCandidates } from './selected-candidates';

describe('parseSelectedShoppingCandidates', () => {
  it('returns an empty array for an empty array', () => {
    expect(parseSelectedShoppingCandidates([])).toEqual([]);
  });

  it('preserves name/reason/order and maps is_staple to isStaple', () => {
    const result = parseSelectedShoppingCandidates([
      { name: '醤油', reason: 'out_of_stock', is_staple: true },
      { name: '牛肉', reason: 'expired', is_staple: false },
    ]);

    expect(result).toEqual([
      { name: '醤油', reason: 'out_of_stock', isStaple: true },
      { name: '牛肉', reason: 'expired', isStaple: false },
    ]);
  });

  it('trims the name', () => {
    const result = parseSelectedShoppingCandidates([
      { name: '  卵  ', reason: 'absent', is_staple: false },
    ]);

    expect(result[0].name).toBe('卵');
  });

  it('rejects a blank name', () => {
    expect(() =>
      parseSelectedShoppingCandidates([{ name: '   ', reason: 'absent', is_staple: false }]),
    ).toThrow();
  });

  it('rejects an unknown reason', () => {
    expect(() =>
      parseSelectedShoppingCandidates([
        { name: '卵', reason: 'because_i_said_so', is_staple: false },
      ]),
    ).toThrow();
  });

  it('rejects a missing is_staple', () => {
    expect(() =>
      parseSelectedShoppingCandidates([{ name: '卵', reason: 'absent' }]),
    ).toThrow();
  });

  it('rejects a wrong-typed is_staple', () => {
    expect(() =>
      parseSelectedShoppingCandidates([{ name: '卵', reason: 'absent', is_staple: 'yes' }]),
    ).toThrow();
  });

  it('rejects extra keys', () => {
    expect(() =>
      parseSelectedShoppingCandidates([
        { name: '卵', reason: 'absent', is_staple: false, extra: 'nope' },
      ]),
    ).toThrow();
  });

  it('rejects a non-array', () => {
    expect(() => parseSelectedShoppingCandidates({ name: '卵' })).toThrow();
    expect(() => parseSelectedShoppingCandidates('not an array')).toThrow();
    expect(() => parseSelectedShoppingCandidates(null)).toThrow();
  });
});
