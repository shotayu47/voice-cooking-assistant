import 'server-only';

import type { CookingSession, CookingSessionStatus, Recipe } from '@/types/domain';
import { ServiceError, type ServiceContext } from '@/lib/inventory/service';
import { getRecipe, toRecipeSnapshot } from '@/lib/recipes/service';
import { advanceStep, isFinalStep, previousStep, stepAt } from './steps';

/**
 * `*` rather than an explicit list so the code runs against a database where
 * migration 0002 has not been applied yet. Naming `last_ai_step_move_at`
 * explicitly would make every cooking query fail with 42703 on an un-migrated
 * database — a broken cooking screen is a far worse outcome than a duplicate
 * guard that is temporarily inactive.
 */
const SESSION_COLUMNS = '*';

/**
 * How long after an AI-initiated step move a second one is treated as a
 * duplicate relay rather than a new instruction. A person saying 「次」 twice
 * on purpose pauses far longer than this; a duplicated event does not.
 */
const AI_STEP_MOVE_DEBOUNCE_MS = 1500;

const OPEN_STATUSES: CookingSessionStatus[] = ['active', 'paused'];

export async function getSession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<CookingSession | null> {
  const { data, error } = await ctx.supabase
    .from('cooking_sessions')
    .select(SESSION_COLUMNS)
    .eq('user_id', ctx.userId)
    .eq('id', sessionId)
    .maybeSingle();

  if (error) throw new ServiceError(error.message);
  return (data as CookingSession | null) ?? null;
}

/** The session the user is currently in the middle of, if any. */
export async function getOpenSession(ctx: ServiceContext): Promise<CookingSession | null> {
  const { data, error } = await ctx.supabase
    .from('cooking_sessions')
    .select(SESSION_COLUMNS)
    .eq('user_id', ctx.userId)
    .in('status', OPEN_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new ServiceError(error.message);
  return (data as CookingSession | null) ?? null;
}

export async function listHistory(ctx: ServiceContext, limit = 30): Promise<CookingSession[]> {
  const { data, error } = await ctx.supabase
    .from('cooking_sessions')
    .select(SESSION_COLUMNS)
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new ServiceError(error.message);
  return (data ?? []) as CookingSession[];
}

/**
 * Start cooking a saved recipe.
 *
 * The recipe is snapshotted so editing or deleting the original cannot change
 * the steps mid-cook (SPEC §6.4). A unique index allows only one open session
 * per user, so an existing one is resumed (same recipe) or cancelled first.
 */
export async function startSession(
  ctx: ServiceContext,
  recipeId: string,
): Promise<CookingSession> {
  const recipe = await getRecipe(ctx, recipeId);
  if (!recipe) throw new ServiceError('レシピが見つかりません');

  const snapshot = toRecipeSnapshot(recipe);
  if (!snapshot.steps.length) throw new ServiceError('手順のないレシピは開始できません');

  const open = await getOpenSession(ctx);
  if (open) {
    if (open.recipe_id === recipeId) return open;
    await updateStatus(ctx, open.id, 'cancelled');
  }

  const { data, error } = await ctx.supabase
    .from('cooking_sessions')
    .insert({
      user_id: ctx.userId,
      recipe_id: recipeId,
      recipe_snapshot: snapshot,
      current_step: 0,
      total_steps: snapshot.steps.length,
      status: 'active',
    })
    .select(SESSION_COLUMNS)
    .single();

  if (error) throw new ServiceError(error.message);
  return data as CookingSession;
}

export type StepView = {
  session: CookingSession;
  step: ReturnType<typeof stepAt>;
  stepNumber: number;
  totalSteps: number;
  isFinalStep: boolean;
};

export async function getCurrentStep(
  ctx: ServiceContext,
  sessionId: string,
): Promise<StepView> {
  const session = await requireSession(ctx, sessionId);
  return toStepView(session);
}

export function toStepView(session: CookingSession): StepView {
  const recipe = session.recipe_snapshot as Recipe;
  return {
    session,
    step: stepAt(recipe, session.current_step),
    stepNumber: session.current_step + 1,
    totalSteps: session.total_steps,
    isFinalStep: isFinalStep(session.current_step, session.total_steps),
  };
}

/**
 * Move one step, atomically.
 *
 * The update is conditional on the step we read, so a double-tap (or a second
 * tool call for the same utterance) matches zero rows and leaves the session
 * where it is — SPEC §18「Prevent accidental double-tap step advancement」.
 * Pass `expectedStep` from the client to make the guard explicit.
 */
export async function moveStep(
  ctx: ServiceContext,
  sessionId: string,
  direction: 'next' | 'previous',
  expectedStep?: number,
  options: { aiInitiated?: boolean } = {},
): Promise<StepView> {
  const session = await requireSession(ctx, sessionId);

  if (session.status !== 'active' && session.status !== 'paused') {
    throw new ServiceError('この料理はすでに終了しています');
  }

  if (expectedStep !== undefined && expectedStep !== session.current_step) {
    // The client is a step behind — its tap already landed. Report reality.
    return toStepView(session);
  }

  // A voice tool call carries no expected step, so a relay that is retried
  // with a fresh call_id would otherwise move a second time. One utterance,
  // one step.
  const hasMoveMarker = 'last_ai_step_move_at' in session;
  if (options.aiInitiated && !hasMoveMarker) {
    console.error(
      '[cooking] migration 0002 not applied — server-side duplicate step-move guard is INACTIVE',
    );
  }
  if (options.aiInitiated && session.last_ai_step_move_at) {
    const sinceLastMove = Date.now() - new Date(session.last_ai_step_move_at).getTime();
    if (sinceLastMove >= 0 && sinceLastMove < AI_STEP_MOVE_DEBOUNCE_MS) {
      return toStepView(session);
    }
  }

  const transition =
    direction === 'next'
      ? advanceStep(session.current_step, session.total_steps)
      : previousStep(session.current_step, session.total_steps);

  if (!transition.changed) return toStepView(session);

  const { data, error } = await ctx.supabase
    .from('cooking_sessions')
    .update({
      current_step: transition.currentStep,
      ...(options.aiInitiated && hasMoveMarker
        ? { last_ai_step_move_at: new Date().toISOString() }
        : {}),
    })
    .eq('user_id', ctx.userId)
    .eq('id', sessionId)
    .eq('current_step', session.current_step)
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (error) throw new ServiceError(error.message);

  // Zero rows means someone else already moved it. Re-read rather than retry.
  if (!data) return toStepView(await requireSession(ctx, sessionId));

  return toStepView(data as CookingSession);
}

const TERMINAL_STATUSES: CookingSessionStatus[] = ['completed', 'cancelled'];

export async function updateStatus(
  ctx: ServiceContext,
  sessionId: string,
  status: CookingSessionStatus,
): Promise<CookingSession> {
  const current = await requireSession(ctx, sessionId);

  // Finished is finished. Without this, 「一時停止して」 said after 「終了」 —
  // or a replayed finish_cooking_session — would put a completed dish back on
  // the home screen as the active cook.
  if (TERMINAL_STATUSES.includes(current.status)) {
    if (current.status === status) return current;
    throw new ServiceError('この料理はすでに終了しています');
  }

  const { data, error } = await ctx.supabase
    .from('cooking_sessions')
    .update({
      status,
      completed_at: status === 'completed' ? new Date().toISOString() : null,
    })
    .eq('user_id', ctx.userId)
    .eq('id', sessionId)
    .select(SESSION_COLUMNS)
    .single();

  if (error) throw new ServiceError(error.message);
  return data as CookingSession;
}

async function requireSession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<CookingSession> {
  const session = await getSession(ctx, sessionId);
  if (!session) throw new ServiceError('料理セッションが見つかりません');
  return session;
}
