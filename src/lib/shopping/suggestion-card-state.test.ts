import { describe, expect, it } from 'vitest';

import type { AddSuggestedOutcome } from './actions-core';
import {
  allAdded,
  applyOutcome,
  canSubmit,
  initialCardState,
  isAdded,
  isBlocked,
  selectedNames,
  toggleSuggestion,
  type CardState,
} from './suggestion-card-state';

/**
 * PHASE 10 — the card is reusable.
 *
 * The bug these exist to prevent: treating a completed press as a completed
 * card. That closed the checkboxes after the first add, so a second one could
 * never be sent no matter what the request key did.
 */

const NAMES = ['玉ねぎ', 'じゃが芋'];

const done = (added: string[], failed: string[] = []): AddSuggestedOutcome => ({
  status: 'done',
  added,
  failed: failed.map((name) => ({ name, message: 'うまくいきませんでした。もう一度お試しください。' })),
  notices: [],
});

function pick(state: CardState, ...names: string[]): CardState {
  return names.reduce(toggleSuggestion, state);
}

describe('a second add on the same card', () => {
  it('runs the whole two-press sequence', () => {
    // 1. Two candidates on the card.
    let state = initialCardState('req-1');
    expect(canSubmit(state, NAMES)).toBe(false);

    // 2. Tick only 玉ねぎ and send.
    state = pick(state, '玉ねぎ');
    expect(selectedNames(state)).toEqual(['玉ねぎ']);

    state = applyOutcome(state, done(['玉ねぎ']), 'req-2');

    // 3. 玉ねぎ is added and locked; じゃが芋 is still available.
    expect(isAdded(state, '玉ねぎ')).toBe(true);
    expect(isAdded(state, 'じゃが芋')).toBe(false);
    expect(isBlocked(state)).toBe(false);
    expect(allAdded(state, NAMES)).toBe(false);

    // 4. The key moved on.
    expect(state.requestId).toBe('req-2');

    // 5. じゃが芋 can be ticked and sent.
    state = pick(state, 'じゃが芋');
    expect(canSubmit(state, NAMES)).toBe(true);
    expect(selectedNames(state)).toEqual(['じゃが芋']);

    // 6. And it lands once.
    state = applyOutcome(state, done(['じゃが芋']), 'req-3');
    expect([...state.added].sort()).toEqual(['じゃが芋', '玉ねぎ']);
    expect(state.requestId).toBe('req-3');
  });

  it('will not re-tick something already added', () => {
    let state = applyOutcome(pick(initialCardState('req-1'), '玉ねぎ'), done(['玉ねぎ']), 'req-2');

    state = toggleSuggestion(state, '玉ねぎ');

    expect(state.picked.has('玉ねぎ')).toBe(false);
  });

  it('clears the added line from the selection', () => {
    const state = applyOutcome(
      pick(initialCardState('req-1'), '玉ねぎ', 'じゃが芋'),
      done(['玉ねぎ']),
      'req-2',
    );

    // じゃが芋 was never sent, so it stays ticked.
    expect(selectedNames(state)).toEqual(['じゃが芋']);
  });

  it('hides the button only once every candidate is added', () => {
    let state = applyOutcome(pick(initialCardState('req-1'), '玉ねぎ'), done(['玉ねぎ']), 'req-2');
    expect(allAdded(state, NAMES)).toBe(false);

    state = applyOutcome(pick(state, 'じゃが芋'), done(['じゃが芋']), 'req-3');
    expect(allAdded(state, NAMES)).toBe(true);
    expect(canSubmit(state, NAMES)).toBe(false);
  });
});

describe('partial success', () => {
  it('locks what landed and leaves the failure selectable', () => {
    const state = applyOutcome(
      pick(initialCardState('req-1'), '玉ねぎ', 'じゃが芋'),
      done(['玉ねぎ'], ['じゃが芋']),
      'req-2',
    );

    expect(isAdded(state, '玉ねぎ')).toBe(true);
    expect(isAdded(state, 'じゃが芋')).toBe(false);
    // The failure stays ticked, so pressing again retries exactly it.
    expect(selectedNames(state)).toEqual(['じゃが芋']);
    expect(canSubmit(state, NAMES)).toBe(true);
  });

  it('retries only the failure, under the new key', () => {
    let state = applyOutcome(
      pick(initialCardState('req-1'), '玉ねぎ', 'じゃが芋'),
      done(['玉ねぎ'], ['じゃが芋']),
      'req-2',
    );

    expect(state.requestId).toBe('req-2');
    expect(selectedNames(state)).toEqual(['じゃが芋']);

    state = applyOutcome(state, done(['じゃが芋']), 'req-3');

    // 玉ねぎ is not sent a second time, so it cannot be added twice.
    expect([...state.added].sort()).toEqual(['じゃが芋', '玉ねぎ']);
  });
});

describe('outcomes that are not `done`', () => {
  it('closes the card on `unknown`', () => {
    const state = applyOutcome(
      pick(initialCardState('req-1'), '玉ねぎ'),
      { status: 'unknown', message: '結果を確定できません。買い物リストを確認してください。' },
      'req-2',
    );

    expect(isBlocked(state)).toBe(true);
    expect(canSubmit(state, NAMES)).toBe(false);
    // The key is kept, so nothing can be resent under a fresh one.
    expect(state.requestId).toBe('req-1');
    // We do not know what landed, so nothing is marked added.
    expect(state.added.size).toBe(0);
  });

  it('will not even tick a line once blocked', () => {
    const blocked = applyOutcome(
      initialCardState('req-1'),
      { status: 'unknown', message: 'x' },
      'req-2',
    );

    expect(toggleSuggestion(blocked, '玉ねぎ').picked.size).toBe(0);
  });

  it('keeps the selection and the key on `in_flight`', () => {
    const state = applyOutcome(
      pick(initialCardState('req-1'), '玉ねぎ'),
      { status: 'in_flight', message: '追加を処理中です。' },
      'req-2',
    );

    expect(state.requestId).toBe('req-1');
    expect(selectedNames(state)).toEqual(['玉ねぎ']);
    expect(isBlocked(state)).toBe(false);
  });

  it('keeps the selection and the key on `unavailable`', () => {
    const state = applyOutcome(
      pick(initialCardState('req-1'), '玉ねぎ'),
      { status: 'unavailable', message: '追加できませんでした。' },
      'req-2',
    );

    expect(state.requestId).toBe('req-1');
    expect(selectedNames(state)).toEqual(['玉ねぎ']);
    expect(canSubmit(state, NAMES)).toBe(true);
  });

  it('keeps the selection and the key on `rejected`', () => {
    const state = applyOutcome(
      pick(initialCardState('req-1'), '玉ねぎ'),
      { status: 'rejected', message: '追加するものを選んでください' },
      'req-2',
    );

    expect(state.requestId).toBe('req-1');
    expect(selectedNames(state)).toEqual(['玉ねぎ']);
  });
});

describe('pending', () => {
  it('blocks while a press is in flight, without closing the card', () => {
    const state = pick(initialCardState('req-1'), '玉ねぎ');

    expect(isBlocked(state, true)).toBe(true);
    expect(canSubmit(state, NAMES, true)).toBe(false);
    // Not a permanent state — the same card is usable once it settles.
    expect(canSubmit(state, NAMES, false)).toBe(true);
  });
});
