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
  'add_inventory_item',
  'start_cooking_session',
]);

export type RepeatDecision =
  /** Run it. */
  | 'execute'
  /** Already ran with these arguments — answer from what it returned before. */
  | 'replay';

/** Identity of one call: what it does, and what it was asked to do it with. */
export function repeatKey(tool: string, signature: string): string {
  return `${tool}::${signature}`;
}

/**
 * `signature` is null when the arguments could not be parsed. That case always
 * executes: two unparseable payloads are not known to be the same call, and
 * refusing to run on a comparison that could not be made would be worse than
 * running twice.
 */
export function decideRepeat(
  tool: string,
  signature: string | null,
  alreadyRun: ReadonlySet<string>,
): RepeatDecision {
  if (signature === null) return 'execute';
  if (!REPEAT_SENSITIVE_TOOLS.has(tool)) return 'execute';
  return alreadyRun.has(repeatKey(tool, signature)) ? 'replay' : 'execute';
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
