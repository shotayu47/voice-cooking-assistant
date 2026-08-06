import { describe, expect, it } from 'vitest';

import {
  addDays,
  daysBetween,
  estimateExpiry,
  freshnessOf,
} from './freshness';

/**
 * PHASE 1 — expiry tracking.
 *
 * The rule that matters throughout: an estimate must be reported as an
 * estimate. Everything else is arithmetic.
 */

const TODAY = '2026-08-10';

describe('estimateExpiry', () => {
  it('uses the shelf life for a known ingredient in a known place', () => {
    expect(
      estimateExpiry(
        { name: '鶏もも肉', category: 'meat', storageLocation: 'fridge' },
        TODAY,
      ),
    ).toEqual({ date: '2026-08-12', kind: 'use_by' });
  });

  it('extends the estimate when the same item is frozen', () => {
    expect(
      estimateExpiry(
        { name: '鶏もも肉', category: 'meat', storageLocation: 'freezer' },
        TODAY,
      ),
    ).toEqual({ date: '2026-09-09', kind: 'use_by' });
  });

  it('counts from the purchase date when one is known', () => {
    expect(
      estimateExpiry(
        {
          name: '鶏もも肉',
          category: 'meat',
          storageLocation: 'fridge',
          purchasedAt: '2026-08-01',
        },
        TODAY,
      )?.date,
    ).toBe('2026-08-03');
  });

  it('resolves an alias to the canonical shelf life', () => {
    // 「たまねぎ」 must find 玉ねぎ.
    expect(
      estimateExpiry({ name: 'たまねぎ', category: null, storageLocation: 'fridge' }, TODAY)
        ?.date,
    ).toBe('2026-09-09');
  });

  it('shortens the estimate once opened, and counts from the opening date', () => {
    const sealed = estimateExpiry(
      { name: '牛乳', category: 'egg_dairy', storageLocation: 'fridge' },
      TODAY,
    );
    const opened = estimateExpiry(
      {
        name: '牛乳',
        category: 'egg_dairy',
        storageLocation: 'fridge',
        opened: true,
        openedAt: '2026-08-09',
      },
      TODAY,
    );

    expect(sealed?.date).toBe('2026-08-17');
    expect(opened?.date).toBe('2026-08-12');
  });

  it('marks perishables as 消費期限 and shelf-stable goods as 賞味期限', () => {
    expect(
      estimateExpiry({ name: '豆腐', category: null, storageLocation: 'fridge' }, TODAY)?.kind,
    ).toBe('use_by');
    expect(
      estimateExpiry({ name: '醤油', category: 'seasoning', storageLocation: 'pantry' }, TODAY)
        ?.kind,
    ).toBe('best_before');
  });

  it('falls back to the category when the ingredient is unknown', () => {
    expect(
      estimateExpiry(
        { name: '謎の白身魚', category: 'fish', storageLocation: 'fridge' },
        TODAY,
      ),
    ).toEqual({ date: '2026-08-12', kind: 'use_by' });
  });

  it('returns null rather than inventing a date for a wholly unknown item', () => {
    expect(
      estimateExpiry({ name: '謎の粉', category: null, storageLocation: null }, TODAY),
    ).toBeNull();
    expect(
      estimateExpiry({ name: '謎の粉', category: 'other', storageLocation: 'pantry' }, TODAY),
    ).toBeNull();
  });

  it('assumes the longest storage option when the place is unknown', () => {
    // Guessing "fridge" for a cupboard item would under-report badly.
    expect(
      estimateExpiry({ name: 'じゃが芋', category: 'vegetable', storageLocation: null }, TODAY)
        ?.date,
    ).toBe('2026-09-09');
  });
});

describe('freshnessOf', () => {
  const at = (expiry: string, source: 'user' | 'estimated' = 'user') =>
    freshnessOf({ expiry_date: expiry, expiry_source: source, expiry_kind: 'use_by' }, TODAY);

  it('counts the days remaining', () => {
    expect(at('2026-08-11')).toMatchObject({ daysLeft: 1, level: 'soon', label: 'あと1日' });
  });

  it('flags today and overdue separately', () => {
    expect(at('2026-08-10')).toMatchObject({ level: 'today', label: '今日まで' });
    expect(at('2026-08-08')).toMatchObject({ level: 'expired', label: '2日過ぎ', daysLeft: -2 });
  });

  it('treats anything beyond three days as fine', () => {
    expect(at('2026-08-20')).toMatchObject({ level: 'ok' });
  });

  // The central requirement: never present a guess as fact.
  it('prefixes an estimated date with 推定', () => {
    expect(at('2026-08-13', 'estimated')).toMatchObject({
      estimated: true,
      label: '推定あと3日',
    });
    expect(at('2026-08-13', 'user')).toMatchObject({ estimated: false, label: 'あと3日' });
  });

  it('returns null when the item carries no date at all', () => {
    expect(freshnessOf({ expiry_date: null }, TODAY)).toBeNull();
  });

  it('does not claim an estimate when the source is unknown', () => {
    expect(
      freshnessOf({ expiry_date: '2026-08-13', expiry_source: 'unknown' }, TODAY)?.estimated,
    ).toBe(false);
  });
});

describe('date helpers', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
  });

  it('handles leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('measures the gap between two dates', () => {
    expect(daysBetween('2026-08-10', '2026-08-13')).toBe(3);
    expect(daysBetween('2026-08-10', '2026-08-07')).toBe(-3);
  });

  it('returns null for an unparseable date', () => {
    expect(daysBetween('not-a-date', '2026-08-10')).toBeNull();
  });
});
