'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getServiceContext } from '@/lib/supabase/server';
import {
  getCurrentStep,
  moveStep,
  startSession,
  updateStatus,
} from '@/lib/cooking/service';
import type { CookingSessionStatus } from '@/types/domain';

export type StepState = {
  currentStep: number;
  totalSteps: number;
  isFinalStep: boolean;
  status: CookingSessionStatus;
};

/**
 * Move one step. `expectedStep` is the step the client is currently showing —
 * if it no longer matches, the tap is a duplicate and nothing moves.
 */
export async function moveStepAction(
  sessionId: string,
  direction: 'next' | 'previous',
  expectedStep: number,
): Promise<StepState> {
  const { ctx } = await getServiceContext();
  const view = await moveStep(ctx, sessionId, direction, expectedStep);

  revalidatePath(`/cooking/${sessionId}`);

  return {
    currentStep: view.session.current_step,
    totalSteps: view.totalSteps,
    isFinalStep: view.isFinalStep,
    status: view.session.status,
  };
}

/**
 * Re-read the authoritative step. Used after an AI turn, which may have moved
 * the step through a tool call the cooking screen didn't initiate.
 */
export async function getStepStateAction(sessionId: string): Promise<StepState> {
  const { ctx } = await getServiceContext();
  const view = await getCurrentStep(ctx, sessionId);

  return {
    currentStep: view.session.current_step,
    totalSteps: view.totalSteps,
    isFinalStep: view.isFinalStep,
    status: view.session.status,
  };
}

export async function finishSessionAction(
  sessionId: string,
  status: 'completed' | 'cancelled',
): Promise<void> {
  const { ctx } = await getServiceContext();
  await updateStatus(ctx, sessionId, status);

  revalidatePath('/history');
  revalidatePath('/');
  redirect('/history');
}

export async function startCookingAction(recipeId: string): Promise<void> {
  const { ctx } = await getServiceContext();
  const session = await startSession(ctx, recipeId);

  revalidatePath('/');
  redirect(`/cooking/${session.id}`);
}
