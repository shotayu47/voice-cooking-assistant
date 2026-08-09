/**
 * Whether a chat reply carries a shopping card, and what it carries.
 *
 * Split out of the component so the rule can be tested. The device failure was
 * a card that never appeared, and "did the reply have candidates attached" is
 * exactly the question that had no test — the transport was checked by calling
 * the API directly, which skips the client entirely.
 */

import type { ShoppingSuggestion } from './suggest';

/** The shape `/api/chat` returns, as far as the card is concerned. */
export type ChatTurnResponse = {
  reply: string;
  shoppingSuggestions?: ShoppingSuggestion[] | null;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Absent unless this turn produced candidates. */
  suggestions?: ShoppingSuggestion[];
};

/**
 * Builds the assistant message for a reply.
 *
 * An empty list is dropped rather than carried as `[]`, so the render
 * condition stays a single truthiness check and an empty array cannot draw an
 * empty card.
 */
export function assistantMessage(id: string, response: ChatTurnResponse): ChatMessage {
  const suggestions = response.shoppingSuggestions ?? [];

  return {
    id,
    role: 'assistant',
    content: response.reply,
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
}

/** True when this message should render a suggestion card. */
export function hasSuggestionCard(message: ChatMessage): boolean {
  return (message.suggestions?.length ?? 0) > 0;
}
