import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';
import { moveStep, updateStatus } from './service';

/**
 * Duplicate-execution guards (production-readiness audit).
 *
 * The voice path relays function calls from the browser, so the same "次" can
 * arrive twice: repeated event, retried relay, or a model that emits the call
 * again. One utterance must move exactly one step.
 */

const USER_ID = 'user-1';

const RECIPE = {
  title: '親子丼',
  servings: 1,
  ingredients: [{ name: '玉ねぎ', required: true }],
  steps: [
    { index: 0, instruction: '玉ねぎを切る' },
    { index: 1, instruction: '鶏肉を切る' },
    { index: 2, instruction: '煮る' },
    { index: 3, instruction: '卵をとじる' },
  ],
};

function seedSession(overrides: Row = {}): Row {
  return {
    id: 'session-1',
    user_id: USER_ID,
    recipe_id: 'recipe-1',
    recipe_snapshot: RECIPE,
    current_step: 0,
    total_steps: 4,
    status: 'active',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    last_ai_step_move_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function setup(seed: Tables): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase(seed);
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

describe('AI-initiated step moves', () => {
  let ctx: ServiceContext;
  let tables: Tables;

  beforeEach(() => {
    vi.useRealTimers();
    ({ ctx, tables } = setup({ cooking_sessions: [seedSession()] }));
  });

  it('advances once, then ignores an immediate duplicate relay', async () => {
    const first = await moveStep(ctx, 'session-1', 'next', undefined, { aiInitiated: true });
    expect(first.session.current_step).toBe(1);

    // The same utterance relayed again a moment later, with a fresh call_id
    // so the idempotency ledger cannot catch it.
    const second = await moveStep(ctx, 'session-1', 'next', undefined, { aiInitiated: true });

    expect(second.session.current_step).toBe(1);
    expect(tables.cooking_sessions[0].current_step).toBe(1);
  });

  it('ignores a duplicate 「戻る」 relay too', async () => {
    ({ ctx, tables } = setup({
      cooking_sessions: [seedSession({ current_step: 2 })],
    }));

    await moveStep(ctx, 'session-1', 'previous', undefined, { aiInitiated: true });
    await moveStep(ctx, 'session-1', 'previous', undefined, { aiInitiated: true });

    expect(tables.cooking_sessions[0].current_step).toBe(1);
  });

  it('allows a genuine second 「次」 once the debounce window has passed', async () => {
    await moveStep(ctx, 'session-1', 'next', undefined, { aiInitiated: true });

    // Backdate the marker rather than sleeping: the guard reads wall-clock.
    tables.cooking_sessions[0].last_ai_step_move_at = new Date(
      Date.now() - 5_000,
    ).toISOString();

    const again = await moveStep(ctx, 'session-1', 'next', undefined, { aiInitiated: true });

    expect(again.session.current_step).toBe(2);
    expect(tables.cooking_sessions[0].current_step).toBe(2);
  });

  it('does not debounce taps from the UI, which carry an expected step', async () => {
    // Two deliberate taps in quick succession, each reporting the step it saw.
    const first = await moveStep(ctx, 'session-1', 'next', 0);
    const second = await moveStep(ctx, 'session-1', 'next', 1);

    expect(first.session.current_step).toBe(1);
    expect(second.session.current_step).toBe(2);
  });

  it('records the move marker only for AI-initiated moves', async () => {
    await moveStep(ctx, 'session-1', 'next', 0);
    expect(tables.cooking_sessions[0].last_ai_step_move_at).toBeNull();

    await moveStep(ctx, 'session-1', 'next', undefined, { aiInitiated: true });
    expect(tables.cooking_sessions[0].last_ai_step_move_at).not.toBeNull();
  });
});

describe('terminal session status', () => {
  it('refuses to reopen a completed session', async () => {
    const { ctx, tables } = setup({
      cooking_sessions: [seedSession({ status: 'completed', completed_at: '2026-01-01T01:00:00Z' })],
    });

    await expect(updateStatus(ctx, 'session-1', 'paused')).rejects.toThrow();
    await expect(updateStatus(ctx, 'session-1', 'active')).rejects.toThrow();
    expect(tables.cooking_sessions[0].status).toBe('completed');
  });

  it('refuses to reopen a cancelled session', async () => {
    const { ctx, tables } = setup({
      cooking_sessions: [seedSession({ status: 'cancelled' })],
    });

    await expect(updateStatus(ctx, 'session-1', 'active')).rejects.toThrow();
    expect(tables.cooking_sessions[0].status).toBe('cancelled');
  });

  it('treats a replayed finish as a no-op rather than an error', async () => {
    const { ctx } = setup({
      cooking_sessions: [seedSession({ status: 'completed' })],
    });

    const result = await updateStatus(ctx, 'session-1', 'completed');
    expect(result.status).toBe('completed');
  });

  it('still allows finishing an active session', async () => {
    const { ctx, tables } = setup({ cooking_sessions: [seedSession()] });

    await updateStatus(ctx, 'session-1', 'completed');
    expect(tables.cooking_sessions[0].status).toBe('completed');
    expect(tables.cooking_sessions[0].completed_at).not.toBeNull();
  });
});
