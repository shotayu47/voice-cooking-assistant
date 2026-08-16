/**
 * How much a recipe tool should propose to buy, if anything.
 *
 * This started as a boolean — candidates or no candidates — which quietly made
 * "レシピを作って、調味料も含めて買い物候補を出して" unanswerable in one turn.
 * The staples switch lived only on `suggest_shopping_items`, and the reply that
 * follows a folded result is asked for with `tool_choice: 'none'`, so there was
 * no second chance to go and fetch them. Three states say the whole thing once.
 *
 * Shared by the tool that computes candidates and the voice client that decides
 * what to do with a repeat, so both read the argument the same way. Pure.
 */

/** The argument name, in one place: the repeat guard has to know it too. */
export const SUGGESTION_MODE_ARG = 'shopping_suggestions_mode';

export const SUGGESTION_MODES = ['none', 'missing_only', 'include_staples'] as const;

export type SuggestionMode = (typeof SUGGESTION_MODES)[number];

/**
 * The mode a call asked for.
 *
 * Anything absent, misspelled, or of the wrong type reads as `none`. The
 * failure that costs something here is a card the user did not ask for, so an
 * unreadable answer produces no candidates rather than a guess.
 */
export function suggestionModeOf(args: unknown): SuggestionMode {
  if (!args || typeof args !== 'object') return 'none';

  const raw = (args as Record<string, unknown>)[SUGGESTION_MODE_ARG];
  return SUGGESTION_MODES.includes(raw as SuggestionMode) ? (raw as SuggestionMode) : 'none';
}

/** Whether 調味料・常備品 count as things to buy. Same switch the standalone tool takes. */
export function includesStaples(mode: SuggestionMode): boolean {
  return mode === 'include_staples';
}

/**
 * What became of the candidates for one recipe.
 *
 * Deliberately about the candidates alone. A recipe is saved before any of
 * this runs, and `failed` here must never read as a recipe that was not
 * written — a model that believes that writes it again.
 */
export type SuggestionStatus = 'ok' | 'empty' | 'failed';

/** `empty` is a real answer: there was nothing missing, so there is no card. */
export function statusForCount(count: number): SuggestionStatus {
  return count === 0 ? 'empty' : 'ok';
}
