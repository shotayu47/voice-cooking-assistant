import { describe, expect, it } from 'vitest';

import { findDuplicates, shoppingKey, type DuplicateCandidate } from './dedupe';

function line(id: string, name: string, checked = false): DuplicateCandidate {
  return { id, name, checked };
}

describe('shoppingKey', () => {
  it('folds hiragana, katakana and half-width katakana to one key', () => {
    const key = shoppingKey('たまご');
    expect(shoppingKey('タマゴ')).toBe(key);
    expect(shoppingKey('ﾀﾏｺﾞ')).toBe(key);
  });

  it('resolves an alias to the same key as its canonical name', () => {
    expect(shoppingKey('たまご')).toBe(shoppingKey('卵'));
  });

  it('absorbs surrounding whitespace', () => {
    expect(shoppingKey('  牛乳  ')).toBe(shoppingKey('牛乳'));
    expect(shoppingKey('牛　乳')).toBe(shoppingKey('牛乳'));
  });

  it('absorbs case and full-width/half-width differences', () => {
    expect(shoppingKey('Milk')).toBe(shoppingKey('milk'));
    expect(shoppingKey('ＭＩＬＫ')).toBe(shoppingKey('milk'));
  });

  it('is empty for a name with nothing comparable in it', () => {
    expect(shoppingKey('')).toBe('');
    expect(shoppingKey('   ')).toBe('');
  });
});

describe('findDuplicates', () => {
  it('finds an existing line written a different way', () => {
    const existing = [line('a', 'たまご'), line('b', '牛乳')];

    expect(findDuplicates('卵', existing).map((item) => item.id)).toEqual(['a']);
    expect(findDuplicates('ﾀﾏｺﾞ', existing).map((item) => item.id)).toEqual(['a']);
    expect(findDuplicates(' 牛乳 ', existing).map((item) => item.id)).toEqual(['b']);
  });

  it('excludes items that are already checked', () => {
    // Buying the same thing on a later trip is normal, so a bought line is not
    // a reason to warn about a new one.
    const existing = [line('bought', '卵', true)];

    expect(findDuplicates('卵', existing)).toEqual([]);
  });

  it('still finds an unchecked duplicate when a checked one also exists', () => {
    const existing = [line('bought', '卵', true), line('todo', 'たまご')];

    expect(findDuplicates('卵', existing).map((item) => item.id)).toEqual(['todo']);
  });

  it('returns every match, not just the first', () => {
    const existing = [line('a', '卵'), line('b', 'たまご'), line('c', '牛乳')];

    expect(findDuplicates('タマゴ', existing).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('does not treat a different ingredient as a duplicate', () => {
    expect(findDuplicates('牛乳', [line('a', '卵')])).toEqual([]);
  });

  it('reports rather than merges — the existing lines are returned untouched', () => {
    const existing = [line('a', '卵')];
    const before = structuredClone(existing);

    const found = findDuplicates('卵', existing);

    expect(found).toHaveLength(1);
    expect(existing).toEqual(before);
  });

  it('finds nothing for a blank name', () => {
    expect(findDuplicates('', [line('a', '卵')])).toEqual([]);
    expect(findDuplicates('   ', [line('a', '卵')])).toEqual([]);
  });

  it('finds nothing in an empty list', () => {
    expect(findDuplicates('卵', [])).toEqual([]);
  });
});
