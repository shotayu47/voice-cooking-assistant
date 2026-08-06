import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';
import { getCurrentStep, getOpenSession, moveStep, startSession, updateStatus } from './service';

const USER_ID = 'user-1';

const RECIPE = {
  title: '親子丼',
  servings: 1,
  estimatedMinutes: 20,
  difficulty: 'easy',
  ingredients: [{ name: '玉ねぎ', amount: 1, unit: '個', required: true }],
  steps: [
    { index: 0, instruction: '玉ねぎを薄切りにする', ingredientRefs: ['玉ねぎ'] },
    { index: 1, instruction: '鶏肉を一口大に切る' },
    { index: 2, instruction: '玉ねぎを煮る' },
  ],
};

function seedSession(overrides: Row = {}): Row {
  return {
    id: 'session-1',
    user_id: USER_ID,
    recipe_id: 'recipe-1',
    recipe_snapshot: RECIPE,
    current_step: 0,
    total_steps: 3,
    status: 'active',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function setup(seed: Tables): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase(seed);
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

describe('moveStep', () => {
  let ctx: ServiceContext;
  let tables: Tables;

  beforeEach(() => {
    ({ ctx, tables } = setup({ cooking_sessions: [seedSession()] }));
  });

  // SPEC §20 Scenario 2
  it('「次」 advances exactly one step and persists it', async () => {
    const view = await moveStep(ctx, 'session-1', 'next');

    expect(view.session.current_step).toBe(1);
    expect(view.stepNumber).toBe(2);
    expect(tables.cooking_sessions[0].current_step).toBe(1);
  });

  it('「戻る」 returns exactly one step', async () => {
    await moveStep(ctx, 'session-1', 'next');
    const view = await moveStep(ctx, 'session-1', 'previous');

    expect(view.session.current_step).toBe(0);
    expect(tables.cooking_sessions[0].current_step).toBe(0);
  });

  it('ignores a duplicate tap carrying a stale expected step', async () => {
    const first = await moveStep(ctx, 'session-1', 'next', 0);
    expect(first.session.current_step).toBe(1);

    // The same tap arriving twice still believes it is on step 0.
    const second = await moveStep(ctx, 'session-1', 'next', 0);
    expect(second.session.current_step).toBe(1);
    expect(tables.cooking_sessions[0].current_step).toBe(1);
  });

  it('does not advance past the final step', async () => {
    ({ ctx, tables } = setup({ cooking_sessions: [seedSession({ current_step: 2 })] }));

    const view = await moveStep(ctx, 'session-1', 'next');

    expect(view.session.current_step).toBe(2);
    expect(view.isFinalStep).toBe(true);
    expect(tables.cooking_sessions[0].current_step).toBe(2);
  });

  it('does not move before the first step', async () => {
    const view = await moveStep(ctx, 'session-1', 'previous');
    expect(view.session.current_step).toBe(0);
  });

  it('refuses to move a finished session', async () => {
    ({ ctx } = setup({ cooking_sessions: [seedSession({ status: 'completed' })] }));
    await expect(moveStep(ctx, 'session-1', 'next')).rejects.toThrow();
  });

  it('will not touch another user’s session', async () => {
    ({ ctx } = setup({ cooking_sessions: [seedSession({ user_id: 'user-2' })] }));
    await expect(moveStep(ctx, 'session-1', 'next')).rejects.toThrow();
  });
});

// SPEC §20 Scenario 3 — asking a question must not change the step.
describe('getCurrentStep', () => {
  it('reads the step without changing it', async () => {
    const { ctx, tables } = setup({ cooking_sessions: [seedSession({ current_step: 1 })] });

    const before = await getCurrentStep(ctx, 'session-1');
    const after = await getCurrentStep(ctx, 'session-1');

    expect(before.session.current_step).toBe(1);
    expect(after.session.current_step).toBe(1);
    expect(tables.cooking_sessions[0].current_step).toBe(1);
  });

  it('surfaces the instruction and progress for the current step', async () => {
    const { ctx } = setup({ cooking_sessions: [seedSession({ current_step: 1 })] });

    const view = await getCurrentStep(ctx, 'session-1');

    expect(view.step?.instruction).toBe('鶏肉を一口大に切る');
    expect(view.stepNumber).toBe(2);
    expect(view.totalSteps).toBe(3);
    expect(view.isFinalStep).toBe(false);
  });
});

describe('session lifecycle', () => {
  it('snapshots the recipe so later edits cannot change the steps', async () => {
    const { ctx, tables } = setup({
      cooking_sessions: [],
      recipes: [
        {
          id: 'recipe-1',
          user_id: USER_ID,
          title: '親子丼',
          description: null,
          servings: 1,
          estimated_minutes: 20,
          difficulty: 'easy',
          ingredients: RECIPE.ingredients,
          steps: RECIPE.steps,
          source_type: 'ai',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const session = await startSession(ctx, 'recipe-1');
    expect(session.total_steps).toBe(3);

    // Mutating the source recipe leaves the running session alone.
    tables.recipes[0].steps = [];
    const view = await getCurrentStep(ctx, session.id);
    expect(view.totalSteps).toBe(3);
    expect(view.step?.instruction).toBe('玉ねぎを薄切りにする');
  });

  it('resumes the existing session when the same recipe is started again', async () => {
    const { ctx, tables } = setup({
      cooking_sessions: [seedSession({ current_step: 2 })],
      recipes: [
        {
          id: 'recipe-1',
          user_id: USER_ID,
          title: '親子丼',
          servings: 1,
          ingredients: RECIPE.ingredients,
          steps: RECIPE.steps,
          source_type: 'ai',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const session = await startSession(ctx, 'recipe-1');

    expect(session.id).toBe('session-1');
    expect(session.current_step).toBe(2);
    expect(tables.cooking_sessions).toHaveLength(1);
  });

  it('marks a session completed and stamps completed_at', async () => {
    const { ctx, tables } = setup({ cooking_sessions: [seedSession()] });

    const session = await updateStatus(ctx, 'session-1', 'completed');

    expect(session.status).toBe('completed');
    expect(tables.cooking_sessions[0].completed_at).not.toBeNull();
    expect(await getOpenSession(ctx)).toBeNull();
  });

  it('reports the open session for resume', async () => {
    const { ctx } = setup({ cooking_sessions: [seedSession({ current_step: 1 })] });

    const open = await getOpenSession(ctx);
    expect(open?.id).toBe('session-1');
    expect(open?.current_step).toBe(1);
  });
});
