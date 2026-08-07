import { describe, expect, it } from 'vitest';

import {
  applyConsumption,
  applyDelta,
  applyStateChange,
  deriveQuantityState,
  isAvailable,
  type QuantitySnapshot,
} from './quantity';

function snapshot(overrides: Partial<QuantitySnapshot> = {}): QuantitySnapshot {
  return { quantity: null, unit: null, quantity_state: 'available', ...overrides };
}

describe('quantity reduction', () => {
  it('subtracts a precise amount (卵6個 − 2個 = 4個)', () => {
    const result = applyConsumption(
      snapshot({ quantity: 6, unit: '個' }),
      { amount: 2, unit: '個' },
    );

    expect(result).toMatchObject({
      status: 'applied',
      action: 'decrease',
      quantity: 4,
      quantityDelta: -2,
      quantity_state: 'available',
    });
  });

  it('clamps at zero and flips the state to empty', () => {
    const result = applyConsumption(snapshot({ quantity: 1, unit: '個' }), { amount: 5 });

    expect(result).toMatchObject({ status: 'applied', quantity: 0, quantity_state: 'empty' });
  });

  it('avoids binary-float drift', () => {
    const result = applyConsumption(snapshot({ quantity: 0.3 }), { amount: 0.1 });
    expect(result.status === 'applied' && result.quantity).toBe(0.2);
  });

  it('refuses a unit that does not match the stored one', () => {
    const result = applyConsumption(
      snapshot({ quantity: 500, unit: 'g' }),
      { amount: 2, unit: '個' },
    );

    expect(result.status).toBe('needs_clarification');
  });

  it('never invents a consumed amount (「醤油使った」)', () => {
    const result = applyConsumption(snapshot({ quantity: 1000, unit: 'ml' }), {});
    expect(result.status).toBe('needs_clarification');
  });

  it('downgrades the fuzzy state when the stock level is unknown', () => {
    const result = applyConsumption(
      snapshot({ quantity: null, quantity_state: 'plenty' }),
      { amount: 100, unit: 'ml' },
    );

    expect(result).toMatchObject({
      status: 'applied',
      action: 'set_state',
      quantity: null,
      quantity_state: 'available',
    });
  });

  it('rejects a non-positive amount', () => {
    expect(applyConsumption(snapshot({ quantity: 5 }), { amount: 0 }).status).toBe(
      'needs_clarification',
    );
    expect(applyConsumption(snapshot({ quantity: 5 }), { amount: -1 }).status).toBe(
      'needs_clarification',
    );
  });
});

// PHASE 2 — the two phrasings people actually use.
describe('remaining ("卵あと2個")', () => {
  it('sets the level instead of subtracting', () => {
    const result = applyConsumption(
      snapshot({ quantity: 6, unit: '個' }),
      { remaining: 2, unit: '個' },
    );

    expect(result).toMatchObject({
      status: 'applied',
      action: 'set_quantity',
      quantity: 2,
      quantityDelta: -4,
    });
  });

  it('accepts a correction upward — they can see the fridge and we cannot', () => {
    const result = applyConsumption(snapshot({ quantity: 2 }), { remaining: 5 });
    expect(result).toMatchObject({ quantity: 5, quantityDelta: 3 });
  });

  it('treats「あと0個」as empty', () => {
    const result = applyConsumption(snapshot({ quantity: 3 }), { remaining: 0 });
    expect(result).toMatchObject({ quantity: 0, quantity_state: 'empty' });
  });

  it('records the level even when the previous quantity was unknown', () => {
    const result = applyConsumption(snapshot({ quantity: null }), { remaining: 2 });
    expect(result).toMatchObject({ quantity: 2, quantityDelta: null });
  });

  it('rejects a negative remaining', () => {
    expect(applyConsumption(snapshot({ quantity: 3 }), { remaining: -1 }).status).toBe(
      'needs_clarification',
    );
  });

  it('still refuses a mismatched unit', () => {
    const result = applyConsumption(
      snapshot({ quantity: 500, unit: 'g' }),
      { remaining: 2, unit: '個' },
    );
    expect(result.status).toBe('needs_clarification');
  });
});

describe('fraction ("キャベツ半分使った")', () => {
  it('consumes the given share of what is there', () => {
    const result = applyConsumption(snapshot({ quantity: 1, unit: '玉' }), { fraction: 0.5 });
    expect(result).toMatchObject({
      status: 'applied',
      action: 'decrease',
      quantity: 0.5,
      quantityDelta: -0.5,
    });
  });

  it('handles a third', () => {
    const result = applyConsumption(snapshot({ quantity: 300, unit: 'g' }), { fraction: 1 / 3 });
    expect(result.status === 'applied' && result.quantity).toBe(200);
  });

  it('empties the item when the whole lot was used', () => {
    const result = applyConsumption(snapshot({ quantity: 2 }), { fraction: 1 });
    expect(result).toMatchObject({ quantity: 0, quantity_state: 'empty' });
  });

  it('moves the fuzzy state rather than inventing a number when the quantity is unknown', () => {
    const result = applyConsumption(
      snapshot({ quantity: null, quantity_state: 'plenty' }),
      { fraction: 0.5 },
    );

    expect(result).toMatchObject({
      status: 'applied',
      action: 'set_state',
      quantity: null,
      quantity_state: 'available',
    });
  });

  it('rejects a share outside 0–1', () => {
    expect(applyConsumption(snapshot({ quantity: 4 }), { fraction: 0 }).status).toBe(
      'needs_clarification',
    );
    expect(applyConsumption(snapshot({ quantity: 4 }), { fraction: 1.5 }).status).toBe(
      'needs_clarification',
    );
  });
});

describe('precedence between the phrasings', () => {
  it('consume_all wins over everything', () => {
    const result = applyConsumption(snapshot({ quantity: 8 }), {
      consumeAll: true,
      remaining: 5,
      fraction: 0.5,
      amount: 2,
    });
    expect(result).toMatchObject({ quantity: 0, action: 'consume_all' });
  });

  it('remaining wins over fraction and amount', () => {
    const result = applyConsumption(snapshot({ quantity: 8 }), {
      remaining: 5,
      fraction: 0.5,
      amount: 2,
    });
    expect(result).toMatchObject({ quantity: 5, action: 'set_quantity' });
  });

  it('fraction wins over amount', () => {
    const result = applyConsumption(snapshot({ quantity: 8 }), { fraction: 0.5, amount: 2 });
    expect(result).toMatchObject({ quantity: 4 });
  });
});

describe('consume-all', () => {
  it('empties an item with a tracked quantity', () => {
    const result = applyConsumption(
      snapshot({ quantity: 2, unit: '個', quantity_state: 'available' }),
      { consumeAll: true },
    );

    expect(result).toMatchObject({
      status: 'applied',
      action: 'consume_all',
      quantity: 0,
      quantity_state: 'empty',
      quantityDelta: -2,
    });
  });

  it('empties an item with no tracked quantity without inventing one', () => {
    const result = applyConsumption(snapshot({ quantity_state: 'plenty' }), {
      consumeAll: true,
    });

    expect(result).toMatchObject({
      status: 'applied',
      quantity: null,
      quantity_state: 'empty',
      quantityDelta: null,
    });
  });

  it('takes priority over an amount when both are given', () => {
    const result = applyConsumption(snapshot({ quantity: 8 }), {
      amount: 2,
      consumeAll: true,
    });

    expect(result.status === 'applied' && result.quantity).toBe(0);
  });
});

describe('quantity-state transitions', () => {
  it('reports empty at or below zero', () => {
    expect(deriveQuantityState(0, 'plenty')).toBe('empty');
    expect(deriveQuantityState(-1, 'available')).toBe('empty');
  });

  it('revives an empty item once a positive quantity exists', () => {
    expect(deriveQuantityState(3, 'empty')).toBe('available');
    expect(deriveQuantityState(3, 'unknown')).toBe('available');
  });

  it('preserves a deliberate fuzzy state', () => {
    expect(deriveQuantityState(2, 'low')).toBe('low');
    expect(deriveQuantityState(9, 'plenty')).toBe('plenty');
  });

  it('leaves the state untouched when there is no quantity', () => {
    expect(deriveQuantityState(null, 'low')).toBe('low');
  });

  it('zeroes the quantity when marked empty so the two never disagree', () => {
    const result = applyStateChange(snapshot({ quantity: 4 }), 'empty');
    expect(result).toMatchObject({ quantity: 0, quantity_state: 'empty' });
  });

  it('clears a zero quantity when the user says stock exists', () => {
    const result = applyStateChange(snapshot({ quantity: 0, quantity_state: 'empty' }), 'plenty');
    expect(result).toMatchObject({ quantity: null, quantity_state: 'plenty' });
  });
});

describe('quick adjustment', () => {
  it('increments from a null quantity as if it were zero', () => {
    const result = applyDelta(snapshot(), 1);
    expect(result).toMatchObject({ quantity: 1, action: 'increase' });
  });

  it('never goes negative', () => {
    const result = applyDelta(snapshot({ quantity: 0 }), -1);
    expect(result).toMatchObject({ quantity: 0, quantity_state: 'empty' });
  });

  it('rejects a zero delta', () => {
    expect(applyDelta(snapshot({ quantity: 3 }), 0).status).toBe('needs_clarification');
  });
});

describe('isAvailable', () => {
  it('treats empty state or zero quantity as unusable', () => {
    expect(isAvailable(snapshot({ quantity_state: 'empty' }))).toBe(false);
    expect(isAvailable(snapshot({ quantity: 0 }))).toBe(false);
    expect(isAvailable(snapshot({ quantity: 2 }))).toBe(true);
    expect(isAvailable(snapshot({ quantity_state: 'unknown' }))).toBe(true);
  });
});
