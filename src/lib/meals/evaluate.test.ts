import { describe, expect, it } from 'vitest';

import type { InventoryItem } from '@/types/domain';
import { evaluateCandidate, evaluateCandidates } from './evaluate';

/**
 * PHASE 3 — the server decides what is makeable.
 *
 * These exercise the production path: the tool hands candidates straight to
 * evaluateCandidates, so classifyMealCandidate / usesExpiringIngredient /
 * isStapleSeasoning are now covered as live logic rather than in isolation.
 */

const TODAY = '2026-08-10';

function item(name: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `id-${name}`,
    user_id: 'user',
    name,
    normalized_name: name,
    category: null,
    quantity: 1,
    unit: null,
    quantity_state: 'available',
    storage_location: 'fridge',
    expiry_date: null,
    opened: false,
    notes: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

const evaluate = (
  required: string[],
  inventory: InventoryItem[],
  expiring: InventoryItem[] = [],
) =>
  evaluateCandidate(
    { title: 'テスト料理', requiredIngredients: required },
    inventory,
    { expiring, today: TODAY },
  );

describe('bucket is decided from real inventory', () => {
  it('everything on hand', () => {
    const result = evaluate(['鶏もも肉', '玉ねぎ'], [item('鶏もも肉'), item('玉ねぎ')]);

    expect(result.bucket).toBe('fully_stocked');
    expect(result.bucketLabel).toBe('今あるものだけで作れる');
    expect(result.missing).toEqual([]);
    expect(result.onHand).toEqual(['鶏もも肉', '玉ねぎ']);
  });

  it('only a staple seasoning is short', () => {
    const result = evaluate(['鶏もも肉', '醤油'], [item('鶏もも肉')]);

    expect(result.bucket).toBe('staples_only');
    expect(result.missing).toEqual([
      { name: '醤油', reason: 'absent', isStaple: true },
    ]);
  });

  it('one real ingredient short', () => {
    const result = evaluate(['鶏もも肉', '玉ねぎ'], [item('鶏もも肉')]);
    expect(result.bucket).toBe('one_missing');
  });

  it('two or three short', () => {
    const result = evaluate(['鶏もも肉', '玉ねぎ', '人参'], [item('鶏もも肉')]);
    expect(result.bucket).toBe('few_missing');
  });

  it('too many short to be worth suggesting', () => {
    const result = evaluate(['a', 'b', 'c', 'd'], []);
    expect(result.bucket).toBe('not_feasible');
  });

  // The bug fixed in 34650a8, now guarded on the live path.
  it('does not count 油揚げ as a seasoning', () => {
    const result = evaluate(['豆腐', '油揚げ'], [item('豆腐')]);

    expect(result.bucket).toBe('one_missing');
    expect(result.missing[0]).toMatchObject({ name: '油揚げ', isStaple: false });
  });

  it('still counts a real seasoning variety as a staple', () => {
    const result = evaluate(['鶏もも肉', '濃口醤油'], [item('鶏もも肉')]);
    expect(result.bucket).toBe('staples_only');
  });
});

describe('why an ingredient is missing', () => {
  it('absent from the inventory entirely', () => {
    expect(evaluate(['玉ねぎ'], []).missing[0].reason).toBe('absent');
  });

  it('present but used up', () => {
    const result = evaluate(['玉ねぎ'], [item('玉ねぎ', { quantity: 0, quantity_state: 'empty' })]);
    expect(result.missing[0].reason).toBe('out_of_stock');
  });

  // Safety rule, decided here rather than asked of the model.
  it('present but past its 消費期限', () => {
    const result = evaluate(
      ['鶏もも肉'],
      [item('鶏もも肉', { expiry_date: '2026-08-08', expiry_kind: 'use_by', expiry_source: 'user' })],
    );

    expect(result.missing[0].reason).toBe('expired');
    expect(result.bucket).toBe('one_missing');
  });

  it('past a 賞味期限 still counts as usable', () => {
    const result = evaluate(
      ['卵'],
      [item('卵', { expiry_date: '2026-08-08', expiry_kind: 'best_before', expiry_source: 'user' })],
    );

    expect(result.missing).toEqual([]);
    expect(result.bucket).toBe('fully_stocked');
  });
});

describe('name resolution', () => {
  it('finds an item through the alias dictionary', () => {
    expect(evaluate(['たまねぎ'], [item('玉ねぎ')]).bucket).toBe('fully_stocked');
  });

  it('treats an ambiguous match as on hand — any chicken will do', () => {
    const result = evaluate(['鶏肉'], [item('鶏もも肉'), item('鶏むね肉')]);
    expect(result.bucket).toBe('fully_stocked');
  });

  it('ignores blank ingredient names', () => {
    expect(evaluate(['鶏もも肉', '  '], [item('鶏もも肉')]).bucket).toBe('fully_stocked');
  });
});

describe('near-expiry usage', () => {
  const chicken = item('鶏もも肉', {
    expiry_date: '2026-08-11',
    expiry_kind: 'use_by',
    expiry_source: 'estimated',
  });

  it('reports which expiring items a dish would use up', () => {
    const result = evaluate(['鶏もも肉', '玉ねぎ'], [chicken, item('玉ねぎ')], [chicken]);

    expect(result.usesExpiring).toBe(true);
    expect(result.expiringUsed).toEqual(['鶏もも肉']);
  });

  it('is false when the dish uses none of them', () => {
    const result = evaluate(['玉ねぎ'], [item('玉ねぎ'), chicken], [chicken]);
    expect(result.usesExpiring).toBe(false);
  });

  it('counts an optional ingredient as using it up', () => {
    const result = evaluateCandidate(
      { title: 'x', requiredIngredients: ['玉ねぎ'], optionalIngredients: ['鶏もも肉'] },
      [item('玉ねぎ'), chicken],
      { expiring: [chicken], today: TODAY },
    );
    expect(result.usesExpiring).toBe(true);
  });
});

describe('ordering', () => {
  const inventory = [item('鶏もも肉'), item('玉ねぎ')];

  it('puts the most makeable first', () => {
    const result = evaluateCandidates(
      [
        { title: '要2品', requiredIngredients: ['鶏もも肉', 'a', 'b'] },
        { title: '作れる', requiredIngredients: ['鶏もも肉', '玉ねぎ'] },
        { title: '要1品', requiredIngredients: ['鶏もも肉', 'a'] },
      ],
      inventory,
      { expiring: [], today: TODAY },
    );

    expect(result.map((entry) => entry.title)).toEqual(['作れる', '要1品', '要2品']);
  });

  it('cleanup mode puts expiry-clearing dishes first even if one thing is short', () => {
    const chicken = item('鶏もも肉', {
      expiry_date: '2026-08-11',
      expiry_kind: 'use_by',
      expiry_source: 'estimated',
    });

    const result = evaluateCandidates(
      [
        { title: '作れるが期限は減らない', requiredIngredients: ['玉ねぎ'] },
        { title: '期限を消化できる', requiredIngredients: ['鶏もも肉', 'a'] },
      ],
      [chicken, item('玉ねぎ')],
      { expiring: [chicken], today: TODAY, mode: 'fridge_cleanup' },
    );

    expect(result[0].title).toBe('期限を消化できる');
  });

  it('normal mode keeps makeability ahead of expiry', () => {
    const chicken = item('鶏もも肉', {
      expiry_date: '2026-08-11',
      expiry_kind: 'use_by',
      expiry_source: 'estimated',
    });

    const result = evaluateCandidates(
      [
        { title: '期限を消化できるが1品足りない', requiredIngredients: ['鶏もも肉', 'a'] },
        { title: '作れる', requiredIngredients: ['玉ねぎ'] },
      ],
      [chicken, item('玉ねぎ')],
      { expiring: [chicken], today: TODAY },
    );

    expect(result[0].title).toBe('作れる');
  });
});
