/**
 * Whether a chat reply carries a shopping card, and what it carries.
 *
 * Split out of the component so the rule can be tested. The device failure was
 * a card that never appeared, and "did the reply have candidates attached" is
 * exactly the question that had no test — the transport was checked by calling
 * the API directly, which skips the client entirely.
 */

import {
  lineageKeyOf,
  recipeIdsOf,
  REVISED_CARD_NOTICE,
  type RevisionChain,
} from './card-lineage';
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
  /**
   * Which dish this card is about, stable across revisions of its recipe.
   * A new result for the same lineage replaces the card rather than stacking
   * a second one beside it.
   */
  lineageKey?: string;
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

/**
 * The caption shown above a card that came from a voice turn.
 *
 * Fixed text written here, never the assistant's sentence. The model is about
 * to read the same names out loud, and using that sentence would make the
 * card a reading of prose rather than of the tool's structured output.
 */
export const VOICE_SUGGESTION_CAPTION =
  '音声で提案された候補です。追加するものを選んでください。';

/**
 * Adds a voice turn's candidates to the transcript, keyed by the function
 * call that produced them.
 *
 * Two things make this idempotent, and both are needed: the relay to
 * `/api/realtime/tool` can be retried, and the same `response.done` can be
 * seen twice. Either way the card is replaced in place rather than added
 * again. A second, *different* call keeps its own card, so a turn that asks
 * for two dishes does not lose the first one's candidates.
 */
export function withVoiceSuggestions(
  messages: ChatMessage[],
  callId: string,
  suggestions: ShoppingSuggestion[],
  options: { chain?: RevisionChain; revised?: boolean } = {},
): ChatMessage[] {
  // Structured output only, and only when there is something to pick from.
  // A failed revision or a failed suggestion leaves the old card standing.
  if (suggestions.length === 0) return messages;

  const chain = options.chain ?? new Map<string, string>();
  const lineageKey = lineageKeyOf(recipeIdsOf(suggestions), chain);

  const id = `voice-${callId}`;
  const card: ChatMessage = {
    ...assistantMessage(id, {
      reply: options.revised ? REVISED_CARD_NOTICE : VOICE_SUGGESTION_CAPTION,
      shoppingSuggestions: suggestions,
    }),
    lineageKey,
  };

  /*
   * Replace by lineage, not by call id.
   *
   * The old card is dropped and the new one appended rather than swapped in
   * place, so the card remounts: a fresh card starts with everything
   * unchecked, and any selection the user had made but not confirmed on the
   * superseded card goes with it. Nothing already added to the shopping list
   * is touched — that lives in the database and is the user's.
   */
  const kept = messages.filter(
    (message) => !(hasSuggestionCard(message) && message.lineageKey === lineageKey),
  );

  // Cards for other dishes are untouched by all of this.
  return [...kept, card];
}
