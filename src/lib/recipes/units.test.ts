import { describe, expect, it } from 'vitest';

import { convertAmount, formatAmount, formatNumber, sameUnit, unitSpec } from './units';

describe('convertAmount', () => {
  it('converts within the same dimension', () => {
    expect(convertAmount(1, 'kg', 'g')).toBe(1000);
    expect(convertAmount(500, 'g', 'kg')).toBe(0.5);
    expect(convertAmount(1, 'L', 'ml')).toBe(1000);
    expect(convertAmount(200, 'ml', 'cc')).toBe(200);
  });

  it('treats 大さじ / 小さじ / カップ as the volumes they are defined as', () => {
    expect(convertAmount(1, '大さじ', 'ml')).toBe(15);
    expect(convertAmount(1, '小さじ', 'ml')).toBe(5);
    expect(convertAmount(1, 'カップ', 'ml')).toBe(200);
    expect(convertAmount(30, 'ml', '大さじ')).toBe(2);
  });

  it('refuses g ↔ ml — that needs a density we do not have', () => {
    expect(convertAmount(200, 'g', 'ml')).toBeNull();
    expect(convertAmount(200, 'ml', 'g')).toBeNull();
    expect(convertAmount(1, '大さじ', 'g')).toBeNull();
  });

  it('passes counted units through only when they are literally the same unit', () => {
    expect(convertAmount(2, '個', '個')).toBe(2);
    expect(convertAmount(2, '個', '枚')).toBeNull();
    expect(convertAmount(2, '個', 'g')).toBeNull();
  });

  it('does not assume a missing unit matches the other side', () => {
    expect(convertAmount(2, null, 'g')).toBeNull();
    expect(convertAmount(2, 'g', null)).toBeNull();
    expect(convertAmount(2, null, null)).toBeNull();
  });

  it('normalizes the way the unit was written', () => {
    expect(convertAmount(1, 'ｇ', 'g')).toBe(1);
    expect(convertAmount(1, 'グラム', 'g')).toBe(1);
    expect(convertAmount(1, 'ml', 'ミリリットル')).toBe(1);
  });
});

describe('sameUnit / unitSpec', () => {
  it('recognises the units it knows', () => {
    expect(unitSpec('kg')?.dimension).toBe('mass');
    expect(unitSpec('大さじ')?.dimension).toBe('volume');
    expect(unitSpec('個')).toBeNull();
    expect(unitSpec(null)).toBeNull();
  });

  it('does not call two empty units the same', () => {
    expect(sameUnit('個', '個')).toBe(true);
    expect(sameUnit(null, null)).toBe(false);
  });
});

describe('formatNumber', () => {
  it('writes fractions the way a recipe does', () => {
    expect(formatNumber(1.5, '個')).toBe('1と1/2');
    expect(formatNumber(0.5, '個')).toBe('1/2');
    expect(formatNumber(0.25, '大さじ')).toBe('1/4');
    expect(formatNumber(2 / 3, '個')).toBe('2/3');
    expect(formatNumber(4 / 3, '個')).toBe('1と1/3');
    expect(formatNumber(2, '個')).toBe('2');
  });

  it('leaves a number the user gave us alone rather than tidying it into a fraction', () => {
    // 0.33 is not 1/3, and pretending it is would change their figure.
    expect(formatNumber(0.33, '個')).toBe('0.33');
  });

  it('uses decimals for weights and volumes', () => {
    expect(formatNumber(375, 'g')).toBe('375');
    expect(formatNumber(1.5, 'g')).toBe('1.5');
    expect(formatNumber(266.666, 'g')).toBe('267');
  });
});

describe('formatAmount', () => {
  it('joins the number and the unit', () => {
    expect(formatAmount(1.5, '個')).toBe('1と1/2個');
    expect(formatAmount(300, 'g')).toBe('300g');
  });

  it('writes the spoon measures the way Japanese recipes do', () => {
    expect(formatAmount(2, '大さじ')).toBe('大さじ2');
    expect(formatAmount(1.5, '小さじ')).toBe('小さじ1と1/2');
    expect(formatAmount(1, 'カップ')).toBe('カップ1');
  });

  it('never invents a number for an amount that has none', () => {
    expect(formatAmount(null, '適量')).toBe('適量');
    expect(formatAmount(null, null)).toBe('');
    expect(formatAmount(undefined, '少々')).toBe('少々');
  });
});
