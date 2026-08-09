import { describe, expect, it, vi } from 'vitest';

import { ServiceError } from '@/lib/inventory/service';

import { runStartNewConversation, type ConversationDeps } from './conversation-actions-core';

/**
 * What the 「新しい会話」 button is allowed to do.
 *
 * `startNewConversation` itself is pinned in `conversation.test.ts` against a
 * fake that models migration 0006's index. What is pinned here is the layer
 * above it: which failures become a message, which stay exceptions, and when
 * the page is allowed to re-render.
 */

function deps(overrides: Partial<ConversationDeps> = {}) {
  const revalidate = vi.fn();
  const base: ConversationDeps = {
    startNew: vi.fn(async () => 'conversation-2'),
    revalidate,
    ...overrides,
  };
  return { deps: base, revalidate: base.revalidate as ReturnType<typeof vi.fn> };
}

describe('runStartNewConversation', () => {
  it('returns the new conversation and refreshes the chat page', async () => {
    const { deps: d, revalidate } = deps();

    expect(await runStartNewConversation(d, null)).toEqual({
      status: 'done',
      conversationId: 'conversation-2',
    });
    expect(revalidate).toHaveBeenCalledWith('/chat');
  });

  it('keeps the conversation attached to the cooking in progress', async () => {
    const startNew = vi.fn(async () => 'conversation-2');
    const { deps: d } = deps({ startNew });

    await runStartNewConversation(d, 'session-9');

    expect(startNew).toHaveBeenCalledWith('session-9');
  });

  it('reports a database failure as a message the user can act on', async () => {
    const { deps: d } = deps({
      startNew: vi.fn(async () => {
        throw new ServiceError('connection reset');
      }),
    });

    const result = await runStartNewConversation(d, null);

    expect(result.status).toBe('error');
    // The raw database message is not something to put in front of a cook.
    expect(result).not.toHaveProperty('conversationId');
    if (result.status === 'error') expect(result.message).not.toContain('connection reset');
  });

  it('does not refresh the page when nothing changed', async () => {
    // Re-rendering here would show the still-open conversation as though the
    // press had worked.
    const { deps: d, revalidate } = deps({
      startNew: vi.fn(async () => {
        throw new ServiceError('nope');
      }),
    });

    await runStartNewConversation(d, null);

    expect(revalidate).not.toHaveBeenCalled();
  });

  it('lets an unexpected error through instead of calling it a database failure', async () => {
    const { deps: d } = deps({
      startNew: vi.fn(async () => {
        throw new TypeError('undefined is not a function');
      }),
    });

    await expect(runStartNewConversation(d, null)).rejects.toThrow(TypeError);
  });

  it('succeeds when the conversation was already empty', async () => {
    // `startNewConversation` hands back the same id rather than opening a
    // second blank row. Pressing twice must still read as success.
    const { deps: d, revalidate } = deps({ startNew: vi.fn(async () => 'conversation-1') });

    expect(await runStartNewConversation(d, null)).toEqual({
      status: 'done',
      conversationId: 'conversation-1',
    });
    expect(revalidate).toHaveBeenCalledWith('/chat');
  });
});
