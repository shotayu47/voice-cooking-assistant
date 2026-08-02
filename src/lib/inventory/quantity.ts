/**
 * Pure quantity / quantity-state arithmetic (SPEC §5.2, §8.4, §11.2).
 *
 * Everything here is a pure function so the rules can be tested without a
 * database. The hard requirement: an ambiguous statement must never
 * destructively change inventory, and a consumed amount must never be invented.
 */

import type { QuantityState, TransactionAction } from '@/types/domain';

export type QuantitySnapshot = {
  quantity: number | null;
  unit: string | null;
  quantity_state: QuantityState;
};

/**
 * Derive the state implied by a new quantity, preserving the fuzzy state when
 * there is no precise quantity to reason about.
 */
export function deriveQuantityState(
  quantity: number | null,
  previousState: QuantityState,
): QuantityState {
  if (quantity === null) return previousState;
  if (quantity <= 0) return 'empty';
  // A positive quantity contradicts "empty"; anything else the user set stands.
  if (previousState === 'empty' || previousState === 'unknown') return 'available';
  return previousState;
}

export type ConsumeInput = {
  amount?: number | null;
  unit?: string | null;
  consumeAll?: boolean;
};

export type ConsumeOutcome =
  | {
      status: 'applied';
      action: TransactionAction;
      quantity: number | null;
      quantity_state: QuantityState;
      quantityDelta: number | null;
    }
  | { status: 'needs_clarification'; reason: string };

/**
 * Apply a consumption statement to an item.
 *
 * `consumeAll` is the only path that empties an item outright. A bare
 * "使った" with no amount on an item with a tracked quantity is refused
 * rather than guessed.
 */
export function applyConsumption(
  snapshot: QuantitySnapshot,
  input: ConsumeInput,
): ConsumeOutcome {
  if (input.consumeAll) {
    return {
      status: 'applied',
      action: 'consume_all',
      quantity: snapshot.quantity === null ? null : 0,
      quantity_state: 'empty',
      quantityDelta: snapshot.quantity === null ? null : -snapshot.quantity,
    };
  }

  const amount = input.amount ?? null;

  if (amount === null) {
    // 「醤油使った」 — no amount given. Do not invent one.
    return {
      status: 'needs_clarification',
      reason: '消費量が指定されていません。数量を指定するか「使い切った」と伝えてください。',
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      status: 'needs_clarification',
      reason: '消費量は正の数で指定してください。',
    };
  }

  if (snapshot.quantity === null) {
    // We know how much was used but not how much there was. Reducing an
    // unknown quantity to a number would be fabrication; downgrade the fuzzy
    // state instead and leave the quantity unknown.
    return {
      status: 'applied',
      action: 'set_state',
      quantity: null,
      quantity_state: snapshot.quantity_state === 'plenty' ? 'available' : 'low',
      quantityDelta: null,
    };
  }

  if (
    input.unit &&
    snapshot.unit &&
    input.unit.trim() !== '' &&
    input.unit.trim() !== snapshot.unit.trim()
  ) {
    return {
      status: 'needs_clarification',
      reason: `単位が一致しません（在庫: ${snapshot.unit} / 指定: ${input.unit}）。`,
    };
  }

  const next = Math.max(0, roundQuantity(snapshot.quantity - amount));

  return {
    status: 'applied',
    action: 'decrease',
    quantity: next,
    quantity_state: deriveQuantityState(next, snapshot.quantity_state),
    quantityDelta: roundQuantity(next - snapshot.quantity),
  };
}

/** Quick +1 / -1 style adjustment from the inventory list. */
export function applyDelta(
  snapshot: QuantitySnapshot,
  delta: number,
): ConsumeOutcome {
  if (!Number.isFinite(delta) || delta === 0) {
    return { status: 'needs_clarification', reason: '増減量が不正です。' };
  }

  const base = snapshot.quantity ?? 0;
  const next = Math.max(0, roundQuantity(base + delta));

  return {
    status: 'applied',
    action: delta > 0 ? 'increase' : 'decrease',
    quantity: next,
    quantity_state: deriveQuantityState(next, snapshot.quantity_state),
    quantityDelta: roundQuantity(next - base),
  };
}

/**
 * Fuzzy state buttons (「少ない」「十分ある」「使い切った」). Marking an item
 * empty zeroes a tracked quantity so the two never disagree.
 */
export function applyStateChange(
  snapshot: QuantitySnapshot,
  state: QuantityState,
): ConsumeOutcome {
  if (state === 'empty') {
    return {
      status: 'applied',
      action: 'consume_all',
      quantity: snapshot.quantity === null ? null : 0,
      quantity_state: 'empty',
      quantityDelta: snapshot.quantity === null ? null : -snapshot.quantity,
    };
  }

  return {
    status: 'applied',
    action: 'set_state',
    // Leaving a zero quantity while claiming stock exists is contradictory.
    quantity: snapshot.quantity === 0 ? null : snapshot.quantity,
    quantity_state: state,
    quantityDelta: null,
  };
}

/** Trim binary-float noise (0.1 + 0.2) without losing real precision. */
function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** True when the item should be treated as unavailable for cooking. */
export function isAvailable(snapshot: QuantitySnapshot): boolean {
  if (snapshot.quantity_state === 'empty') return false;
  if (snapshot.quantity !== null && snapshot.quantity <= 0) return false;
  return true;
}
