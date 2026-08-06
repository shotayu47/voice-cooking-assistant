/**
 * Which function calls from a Realtime turn should actually be executed.
 *
 * Pure so it can be tested without a peer connection. This is the first of two
 * duplicate defences and the only one that works with no database support:
 *
 *  1. here — a call_id is relayed at most once, and one model turn moves the
 *     cooking step at most once.
 *  2. server — the idempotency ledger (migration 0002) and the step-move
 *     debounce, which additionally cover retries across separate requests.
 */

export type RealtimeFunctionCall = {
  type: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

export type ExecutableCall = {
  name: string;
  callId: string;
  arguments: string;
};

/** Tools that move the cooking step. At most one may run per model turn. */
const STEP_MOVE_TOOLS = new Set(['advance_cooking_step', 'previous_cooking_step']);

export function selectExecutableCalls(
  output: RealtimeFunctionCall[] | undefined,
  alreadyHandled: ReadonlySet<string>,
): ExecutableCall[] {
  const selected: ExecutableCall[] = [];
  const seenThisTurn = new Set<string>();
  let stepMoves = 0;

  for (const item of output ?? []) {
    if (item.type !== 'function_call') continue;
    if (!item.name || !item.call_id) continue;

    // Relayed before (repeated event, reconnect replay).
    if (alreadyHandled.has(item.call_id)) continue;
    // The same call listed twice inside one turn.
    if (seenThisTurn.has(item.call_id)) continue;

    // 「次」 said once must not skip two steps, however many times the model
    // asks for it.
    if (STEP_MOVE_TOOLS.has(item.name)) {
      if (stepMoves >= 1) continue;
      stepMoves += 1;
    }

    seenThisTurn.add(item.call_id);
    selected.push({
      name: item.name,
      callId: item.call_id,
      arguments: item.arguments ?? '{}',
    });
  }

  return selected;
}
