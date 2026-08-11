/**
 * One voice turn, as an explicit state machine.
 *
 * The handlers used to keep this in scattered locals: a `handledCalls` set, an
 * `activeTool` string, and nothing at all for "did a response ever come back".
 * That could not represent the states the device actually reached — a turn
 * whose response was cancelled, a tool whose output was never delivered, a
 * commit that produced no response — so those states were indistinguishable
 * from a healthy turn and the UI kept showing a live call over a dead one.
 *
 * Pure, so every one of those paths is testable without a peer connection.
 * The hook owns the socket; this owns what is allowed to happen next.
 *
 * The invariants it exists to enforce:
 *
 *   1. at most one first response per user turn
 *   2. at most one `function_call_output` per call id
 *   3. at most one continuation `response.create` per turn
 *   4. never a `response.create` while a response is still active
 *   5. only `status === 'completed'` counts as a completed response
 *   6. an unresolved turn is never silently replaced by the next request
 */

export type TurnPhase =
  | 'idle'
  | 'listening'
  | 'committing'
  | 'waiting_for_response'
  | 'responding'
  | 'running_tool'
  | 'continuing_after_tool'
  | 'completed'
  | 'recoverable_error'
  | 'unresolved';

/** Why a turn stopped being trustworthy. */
export type TurnFailure =
  | 'failed'
  | 'cancelled'
  | 'incomplete'
  | 'no_response'
  | 'no_continuation'
  | 'channel_lost'
  | 'api_error';

export type TurnState = {
  phase: TurnPhase;
  /** The response currently generating, if any. */
  activeResponseId: string | null;
  /** First responses created since this turn was committed (invariant 1). */
  responsesCreated: number;
  /** call_ids already dispatched to the tool route (invariant 2, first half). */
  callsSeen: string[];
  /** call_ids whose output has been sent back (invariant 2, second half). */
  outputsSent: string[];
  /** Continuation requests issued after a tool (invariant 3). */
  continuationsRequested: number;
  /** When the current wait began, for the timeout checks. */
  waitingSince: number | null;
  failure: TurnFailure | null;
  /**
   * Set once a card has been drawn for this turn. The card comes from the
   * tool's structured output and stays valid even if the spoken half of the
   * turn then fails — losing it would throw away the thing that worked.
   */
  cardShown: boolean;
};

export type VoiceEvent =
  | { type: 'speech_started'; at: number }
  | { type: 'speech_stopped'; at: number }
  | { type: 'committed'; at: number }
  | { type: 'response_created'; at: number; responseId: string }
  | { type: 'function_call_ready'; at: number; callId: string }
  | { type: 'tool_output_sent'; at: number; callId: string }
  | { type: 'continuation_requested'; at: number }
  | { type: 'card_shown'; at: number }
  | { type: 'response_done'; at: number; responseId: string; status: string }
  | { type: 'channel_lost'; at: number }
  | { type: 'api_error'; at: number }
  | { type: 'retry_requested'; at: number };

export const INITIAL_TURN: TurnState = {
  phase: 'idle',
  activeResponseId: null,
  responsesCreated: 0,
  callsSeen: [],
  outputsSent: [],
  continuationsRequested: 0,
  waitingSince: null,
  failure: null,
  cardShown: false,
};

/**
 * How long a wait may last before the turn is declared stuck.
 *
 * Measured, not guessed. In the QA session's ledger, consecutive tool calls
 * inside one turn — which each cost a full model round trip plus the tool —
 * were 1–10s apart, with 10s the worst case. These sit above that and below
 * the 30s fetch timeout the tool relay already uses, so a slow-but-working
 * turn is never cut off and a dead one does not hang indefinitely.
 */
export const TURN_TIMEOUTS = {
  /** Committed, but no `response.created` came back. */
  noResponseMs: 12_000,
  /** Tool output delivered, but the follow-up response never finished. */
  noContinuationMs: 20_000,
} as const;

/** A fresh turn, keeping nothing from the last one. */
function startTurn(at: number): TurnState {
  return { ...INITIAL_TURN, phase: 'listening', waitingSince: at };
}

export function reduceTurn(state: TurnState, event: VoiceEvent): TurnState {
  switch (event.type) {
    case 'speech_started':
      // New speech during a response is an interruption, not a fresh turn —
      // but the turn it interrupts is over either way, so the state resets.
      return startTurn(event.at);

    case 'speech_stopped':
      return { ...state, phase: 'committing', waitingSince: event.at };

    case 'committed':
      return { ...state, phase: 'waiting_for_response', waitingSince: event.at };

    case 'response_created':
      return {
        ...state,
        phase: 'responding',
        activeResponseId: event.responseId,
        responsesCreated: state.responsesCreated + 1,
        waitingSince: event.at,
        failure: null,
      };

    case 'function_call_ready':
      if (state.callsSeen.includes(event.callId)) return state;
      return {
        ...state,
        phase: 'running_tool',
        callsSeen: [...state.callsSeen, event.callId],
        waitingSince: event.at,
      };

    case 'tool_output_sent':
      if (state.outputsSent.includes(event.callId)) return state;
      return {
        ...state,
        outputsSent: [...state.outputsSent, event.callId],
        waitingSince: event.at,
      };

    case 'continuation_requested':
      return {
        ...state,
        phase: 'continuing_after_tool',
        continuationsRequested: state.continuationsRequested + 1,
        waitingSince: event.at,
      };

    case 'card_shown':
      return { ...state, cardShown: true };

    case 'response_done': {
      // Invariant 5. `cancelled` carries partial output and reads exactly like
      // a finished turn if only the event name is checked — which is how a
      // cancelled response's function calls were being executed.
      const cleared = { ...state, activeResponseId: null };

      if (event.status !== 'completed') {
        return {
          ...cleared,
          phase: 'unresolved',
          failure: toFailure(event.status),
          waitingSince: event.at,
        };
      }

      // A response that asked for tools is not the end of the turn; the
      // continuation that follows the tool output is.
      if (state.phase === 'running_tool') {
        return { ...cleared, waitingSince: event.at };
      }

      return { ...cleared, phase: 'completed', failure: null, waitingSince: null };
    }

    case 'channel_lost':
      return {
        ...state,
        phase: 'unresolved',
        activeResponseId: null,
        failure: 'channel_lost',
        waitingSince: event.at,
      };

    case 'api_error':
      // Recoverable on its own: the turn may still complete. It only becomes
      // unresolved if the wait then times out.
      return { ...state, phase: 'recoverable_error', failure: 'api_error' };

    case 'retry_requested':
      return {
        ...state,
        phase: 'waiting_for_response',
        activeResponseId: null,
        failure: null,
        waitingSince: event.at,
      };

    default:
      return state;
  }
}

function toFailure(status: string): TurnFailure {
  if (status === 'failed' || status === 'cancelled' || status === 'incomplete') return status;
  return 'failed';
}

// ---------------------------------------------------------------------------
// Decisions. The hook asks these before touching the data channel.
// ---------------------------------------------------------------------------

/** Invariant 2, first half — a call is dispatched to the tool route once. */
export function canExecuteCall(state: TurnState, callId: string): boolean {
  return !state.callsSeen.includes(callId);
}

/** Invariant 2, second half. */
export function canSendToolOutput(state: TurnState, callId: string): boolean {
  return !state.outputsSent.includes(callId);
}

/**
 * Invariants 3 and 4.
 *
 * The second half matters as much as the first: with `create_response: true`
 * the server starts its own response when the user's turn ends, so a
 * continuation sent while that one is still active is a second concurrent
 * response — which the API rejects, leaving the turn with no answer at all.
 */
export function canRequestContinuation(state: TurnState): boolean {
  return state.continuationsRequested === 0 && state.activeResponseId === null;
}

/** True once the turn can no longer be trusted to produce an answer. */
export function isUnresolved(state: TurnState): boolean {
  return state.phase === 'unresolved';
}

/** A turn that was committed and is still owed a response. */
export function isAwaitingAnswer(state: TurnState): boolean {
  return (
    state.phase === 'waiting_for_response' ||
    state.phase === 'responding' ||
    state.phase === 'running_tool' ||
    state.phase === 'continuing_after_tool' ||
    state.phase === 'recoverable_error'
  );
}

/**
 * Has the current wait gone on too long?
 *
 * Returns the failure to record, or null while there is still reason to wait.
 */
export function overdue(
  state: TurnState,
  now: number,
  timeouts: { noResponseMs: number; noContinuationMs: number } = TURN_TIMEOUTS,
): TurnFailure | null {
  if (state.waitingSince === null) return null;
  const waited = now - state.waitingSince;

  if (state.phase === 'waiting_for_response' || state.phase === 'committing') {
    return waited >= timeouts.noResponseMs ? 'no_response' : null;
  }

  if (
    state.phase === 'responding' ||
    state.phase === 'running_tool' ||
    state.phase === 'continuing_after_tool' ||
    state.phase === 'recoverable_error'
  ) {
    return waited >= timeouts.noContinuationMs ? 'no_continuation' : null;
  }

  return null;
}

/** Applies a timeout, moving the turn to unresolved. */
export function markOverdue(state: TurnState, failure: TurnFailure, at: number): TurnState {
  return { ...state, phase: 'unresolved', activeResponseId: null, failure, waitingSince: at };
}

/** What to tell the user, in Japanese, about a turn that did not finish. */
export function describeFailure(state: TurnState): string | null {
  if (state.phase !== 'unresolved' || !state.failure) return null;

  // The card is the half that survived. Say so, or the message reads as
  // though the candidates were lost too.
  const suffix = state.cardShown
    ? '候補は表示できましたが、読み上げを完了できませんでした。'
    : '';

  switch (state.failure) {
    case 'no_response':
      return `応答を受け取れませんでした。${suffix}`;
    case 'no_continuation':
      return `応答の途中で止まりました。${suffix}`;
    case 'cancelled':
      return `応答が中断されました。${suffix}`;
    case 'incomplete':
      return `応答が最後まで届きませんでした。${suffix}`;
    case 'channel_lost':
      return '接続が切れたため、応答を受け取れませんでした。';
    case 'failed':
    case 'api_error':
    default:
      return `応答に失敗しました。${suffix}`;
  }
}

/**
 * May the client re-ask for a response on this turn?
 *
 * Only when the turn is unresolved *and* the user's own item was committed —
 * re-running a response reuses that item rather than adding a second copy of
 * what they said. When the outcome is genuinely unknown the answer is no, and
 * the UI waits for the user instead of guessing.
 */
export function canRetry(state: TurnState): boolean {
  if (state.phase !== 'unresolved') return false;
  // Nothing was ever committed, so there is no turn to answer.
  if (state.failure === 'channel_lost') return false;
  return true;
}
