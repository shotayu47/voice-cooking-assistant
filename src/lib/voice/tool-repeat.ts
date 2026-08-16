/**
 * Has this exact tool call already been made in this turn?
 *
 * `call_id` uniqueness is not the question. The model issues a fresh id every
 * time, so relaying "each id once" happily runs `create_recipe` twice for the
 * same recipe — which is precisely what a turn does when its first attempt
 * fails on malformed arguments and it simply tries again.
 *
 * The identity that matters is the tool plus its canonicalised arguments. Only
 * the digest is kept, never the arguments, so this can decide "same call" and
 * still record nothing about what was asked for.
 */

/**
 * Tools where a repeat inside one turn is a mistake rather than an intention.
 *
 * Creation is the whole list. `consume_inventory_item` and the step moves are
 * deliberately absent: using two of something, or moving on twice, are things
 * a person can genuinely ask for twice in one breath, and those already have
 * their own guards — the step-move debounce in `select-calls` and the
 * idempotency ledger on the server.
 */
export const REPEAT_SENSITIVE_TOOLS = new Set([
  'create_recipe',
  'revise_recipe',
  'add_inventory_item',
  'start_cooking_session',
]);

export type RepeatDecision =
  /** Run it. */
  | 'execute'
  /** Already ran with these arguments — answer from what it returned before. */
  | 'replay'
  /**
   * The same write, asked for with a different display option. The row exists;
   * only the read-only half of the request is new.
   */
  | 'reuse';

/** Identity of one call: what it does, and what it was asked to do it with. */
export function repeatKey(tool: string, signature: string): string {
  return `${tool}::${signature}`;
}

/** What a previous call with the same write signature left behind. */
export type PriorCall = {
  /** The digest of the *whole* request, display options included. */
  requestSignature: string | null;
  /** The row it created, when it created one. */
  recipeId: string | null;
};

/**
 * Has this write already happened this turn, and if so, is anything new being
 * asked for?
 *
 * Keyed on the write signature, not the whole request. A recipe asked for
 * twice with different candidate modes is one recipe: hashing the mode into
 * the identity made the second call look like a different write and inserted
 * the row again.
 *
 * `write` is null when the arguments could not be parsed. That case always
 * executes: two unparseable payloads are not known to be the same call, and
 * refusing to run on a comparison that could not be made would be worse than
 * running twice.
 */
export function decideRepeat(
  tool: string,
  signatures: { write: string | null; request: string | null },
  prior: PriorCall | undefined,
): RepeatDecision {
  if (signatures.write === null) return 'execute';
  if (!REPEAT_SENSITIVE_TOOLS.has(tool)) return 'execute';
  if (!prior) return 'execute';

  // Identical request, down to the display options: the stored result answers
  // it exactly, candidates included.
  if (prior.requestSignature === signatures.request) return 'replay';

  // Only the read-only half changed. Without a row to point at there is
  // nothing to reuse, so fall back to answering from what was returned before
  // rather than writing again.
  return prior.recipeId === null ? 'replay' : 'reuse';
}

/**
 * What to hand back for a call that was not re-run.
 *
 * The model is still owed an output for that `call_id` — without one it waits
 * forever — so the previous result is returned with a note saying it already
 * happened. That is what stops it trying a third time.
 */
export function replayedOutput(previous: unknown): unknown {
  return {
    ...(previous && typeof previous === 'object' ? previous : { previous }),
    repeated: true,
    note: 'この操作は同じ内容で実行済みです。同じ呼び出しを繰り返さず、次の手順に進んでください。',
  };
}
