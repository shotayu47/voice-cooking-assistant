import { ServiceError } from '@/lib/inventory/service';

/**
 * The decision behind the 「新しい会話」 button, separated from the Server
 * Action so it can be tested without a request.
 *
 * There is deliberately no idempotency ledger here, unlike the shopping
 * add. `startNewConversation` is already safe to press twice: the second
 * press finds a conversation with no messages in it and returns that one
 * untouched rather than opening another. A ledger would guard a race the
 * database already refuses — migration 0006 allows one active conversation
 * per user, so the losing press adopts the winner's row.
 */

export type NewConversationOutcome =
  | { status: 'done'; conversationId: string }
  | { status: 'error'; message: string };

export type ConversationDeps = {
  startNew: (cookingSessionId: string | null) => Promise<string>;
  revalidate: (path: string) => void;
};

const FAILED = '新しい会話を始められませんでした。もう一度お試しください。';

/**
 * Retrying is safe to offer here, which is why the message says so. Nothing
 * is written until the old conversation is closed, and closing it twice is
 * the no-op above — so unlike the shopping write, a failed press leaves no
 * state that a second press could duplicate.
 */
export async function runStartNewConversation(
  deps: ConversationDeps,
  cookingSessionId: string | null,
): Promise<NewConversationOutcome> {
  let conversationId: string;

  try {
    conversationId = await deps.startNew(cookingSessionId);
  } catch (error) {
    // A database failure is expected traffic and becomes a message. Anything
    // else is a bug and must not be dressed up as one.
    if (error instanceof ServiceError) return { status: 'error', message: FAILED };
    throw error;
  }

  // Only after the conversation actually changed. Revalidating on the failure
  // path would re-render the page against the conversation that is still open
  // and make a failed press look like it worked.
  deps.revalidate('/chat');
  return { status: 'done', conversationId };
}
