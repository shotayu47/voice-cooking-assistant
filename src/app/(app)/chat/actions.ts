'use server';

import { revalidatePath } from 'next/cache';

import {
  runStartNewConversation,
  type NewConversationOutcome,
} from '@/lib/ai/conversation-actions-core';
import { startNewConversation } from '@/lib/ai/service';
import { getServiceContext } from '@/lib/supabase/server';

/**
 * Closes the current conversation and opens a fresh one.
 *
 * A wrapper, like the shopping actions: authenticate, hand the service
 * function to the core, return what it decided. Nothing is deleted — the old
 * conversation and its messages stay exactly where they are, marked `closed`.
 *
 * `cookingSessionId` comes from the client so the replacement stays attached
 * to the cooking in progress. It is only ever used as a foreign key on the new
 * row; a wrong value cannot reach another user's data, because the insert is
 * scoped to `ctx.userId` and RLS applies on top.
 */
export async function startNewConversationAction(
  cookingSessionId: string | null,
): Promise<NewConversationOutcome> {
  const { ctx } = await getServiceContext();

  return runStartNewConversation(
    {
      startNew: (sessionId) => startNewConversation(ctx, sessionId),
      revalidate: revalidatePath,
    },
    cookingSessionId,
  );
}
