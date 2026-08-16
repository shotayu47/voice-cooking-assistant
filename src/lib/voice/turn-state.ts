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
 *   3. at most `MAX_TOOL_ROUNDS` continuation `response.create`s per turn
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
  /** The continuation guard tripped; a tools-forbidden reply has been asked for. */
  | 'awaiting_forced_final'
  | 'forced_final_responding'
  /** A liveness check arrived mid-response: cancel sent, waiting for its done. */
  | 'cancelling_response'
  | 'awaiting_liveness_create'
  | 'awaiting_liveness_response'
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
  | 'api_error'
  /** The guard tripped and the one forced final had already been spent. */
  | 'forced_final_unavailable'
  /** The forced final asked for yet another tool instead of answering. */
  | 'forced_final_looped';

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
  /**
   * The response a cancel has been sent for and whose `done` is still owed.
   *
   * Kept separate from `activeResponseId` because both matter at once: the old
   * response is being torn down while the liveness reply is queued behind it.
   */
  cancellingResponseId: string | null;
  /** The response interrupted by new speech, kept rather than discarded. */
  interruptedResponseId: string | null;
  /** Continuation requests issued after a tool (invariant 3). */
  continuationsRequested: number;
  /**
   * Tools-forbidden replies asked for after the guard tripped.
   *
   * At most one per committed user turn. Without it the guard was a dead end:
   * the tool result was delivered, no reply was ever requested, and the turn
   * sat in `running_tool` until the watchdog called it stalled 21s later.
   */
  forcedFinalRequested: number;
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
  | { type: 'liveness_cancel_sent'; at: number; responseId: string }
  | { type: 'liveness_create_sent'; at: number }
  | { type: 'forced_final_requested'; at: number }
  | { type: 'forced_final_unavailable'; at: number }
  | { type: 'forced_final_looped'; at: number }
  | { type: 'card_shown'; at: number }
  | {
      type: 'response_done';
      at: number;
      responseId: string;
      status: string;
      /**
       * `status_details.reason`. `turn_detected` is the one that matters here:
       * it means the server's VAD ended the response because the user started
       * speaking, which is the feature working, not a failure.
       */
      reason?: string;
    }
  | { type: 'channel_lost'; at: number }
  | { type: 'api_error'; at: number }
  | { type: 'retry_requested'; at: number };

export const INITIAL_TURN: TurnState = {
  phase: 'idle',
  activeResponseId: null,
  cancellingResponseId: null,
  interruptedResponseId: null,
  responsesCreated: 0,
  callsSeen: [],
  outputsSent: [],
  continuationsRequested: 0,
  forcedFinalRequested: 0,
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
/**
 * How many tool round trips one committed turn may take.
 *
 * It was 1, which cannot express the flows this app is built around. The
 * canonical ones cost a continuation each:
 *
 *   create_recipe → suggest_shopping_items                     2
 *   search_meal_candidates → create_recipe → suggest_shopping  3
 *
 * so a budget of 1 ended the turn after the first tool and the shopping
 * suggestion was never reached — the model was cut off mid-plan and filled the
 * silence with a promise to do it later.
 *
 * Six leaves room for those three rounds plus a retry at each stage, which the
 * device needed: a `create_recipe` whose arguments failed to parse was retried
 * and the retry alone exhausted the old budget. It stays a hard ceiling, so an
 * endless tool loop still terminates — and repeats of the *same* call are
 * caught earlier and more precisely by signature.
 */
export const MAX_TOOL_ROUNDS = 6;

export const TURN_TIMEOUTS = {
  /** Committed, but no `response.created` came back. */
  noResponseMs: 12_000,
  /** Tool output delivered, but the follow-up response never finished. */
  noContinuationMs: 20_000,
} as const;

export function reduceTurn(state: TurnState, event: VoiceEvent): TurnState {
  switch (event.type) {
    case 'speech_started':
      // Listening again — but the budget is deliberately *not* reset here.
      // Speech that never commits is not a new request, and refreshing the
      // tool allowance on every barge-in would hand the model another round
      // of tools for a turn the user never finished making.
      //
      // The interrupted response's id is kept rather than discarded: the
      // server is still winding it down and will report its `done`, which has
      // to be recognisable as *that* response and not as an answer to what the
      // user is saying now.
      return {
        ...state,
        phase: 'listening',
        waitingSince: event.at,
        failure: null,
        interruptedResponseId: state.activeResponseId ?? state.interruptedResponseId,
      };

    case 'speech_stopped':
      return { ...state, phase: 'committing', waitingSince: event.at };

    case 'committed':
      // A committed user turn is what earns a fresh budget.
      return {
        ...state,
        phase: 'waiting_for_response',
        waitingSince: event.at,
        continuationsRequested: 0,
        forcedFinalRequested: 0,
        callsSeen: [],
        outputsSent: [],
        cardShown: false,
        failure: null,
      };

    case 'response_created':
      return {
        ...state,
        // The forced final is still a response, but it must stay
        // distinguishable: a tool call arriving under it is a loop, whereas
        // under an ordinary response it is normal traffic.
        phase:
          state.phase === 'awaiting_forced_final'
            ? 'forced_final_responding'
            : state.phase === 'awaiting_liveness_response' ||
                state.phase === 'awaiting_liveness_create'
              ? 'awaiting_liveness_response'
              : 'responding',
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

    case 'liveness_cancel_sent':
      return {
        ...state,
        phase: 'cancelling_response',
        cancellingResponseId: event.responseId,
        waitingSince: event.at,
      };

    case 'liveness_create_sent':
      return { ...state, phase: 'awaiting_liveness_response', waitingSince: event.at };

    case 'forced_final_requested':
      return {
        ...state,
        phase: 'awaiting_forced_final',
        forcedFinalRequested: state.forcedFinalRequested + 1,
        waitingSince: event.at,
      };

    case 'forced_final_unavailable':
      // The guard tripped with the one forced final already spent. Say so now
      // rather than leaving the turn to be declared stalled 20s later.
      return {
        ...state,
        phase: 'unresolved',
        failure: 'forced_final_unavailable',
        waitingSince: event.at,
      };

    case 'forced_final_looped':
      // It asked for another tool instead of answering. Asking again would be
      // the loop the guard exists to prevent.
      return {
        ...state,
        phase: 'unresolved',
        activeResponseId: null,
        failure: 'forced_final_looped',
        waitingSince: event.at,
      };

    case 'card_shown':
      return { ...state, cardShown: true };

    case 'response_done': {
      /*
       * Which response finished decides whether this concerns the turn at all.
       *
       * An interruption puts several responses in flight at once — the one
       * being torn down, the one the server started for the new utterance, and
       * the liveness reply queued behind the cancel. Matching on the event name
       * alone let any of them rewrite the turn: a stale `completed` cleared
       * `waitingSince` and disarmed the watchdog for good, and a stale
       * `cancelled` marked a healthy turn unresolved.
       */
      if (state.cancellingResponseId === event.responseId) {
        // The cancel landed. The liveness reply may now be created — and only
        // now, which is the ordering that was missing.
        return {
          ...state,
          phase: 'awaiting_liveness_create',
          cancellingResponseId: null,
          activeResponseId: null,
          waitingSince: event.at,
        };
      }

      /*
       * The user talked over the assistant.
       *
       * `cancelled` with `turn_detected` is the server's VAD reporting that a
       * new utterance began — the barge-in that the interruption feature
       * exists to allow. Reading only `status !== 'completed'` turned that
       * into "応答に失敗しました" plus a retry button, 39ms after the user
       * started a perfectly ordinary sentence, while the turn that followed
       * went on to complete normally.
       *
       * So it clears the response and leaves everything else alone: the phase
       * stays `listening`, no failure is recorded, and nothing is shown. Any
       * other `cancelled`, and every `failed`, still becomes unresolved.
       */
      if (event.status === 'cancelled' && event.reason === 'turn_detected') {
        return {
          ...state,
          activeResponseId:
            state.activeResponseId === event.responseId ? null : state.activeResponseId,
          interruptedResponseId:
            state.interruptedResponseId === event.responseId
              ? null
              : state.interruptedResponseId,
        };
      }

      const concernsThisTurn =
        state.activeResponseId === null || state.activeResponseId === event.responseId;
      if (!concernsThisTurn) {
        // Someone else's ending. Recorded by the caller, ignored here.
        return state;
      }

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
  return state.continuationsRequested < MAX_TOOL_ROUNDS && state.activeResponseId === null;
}

/**
 * May the client ask for a tools-forbidden final answer?
 *
 * This is what the guard falls through to. The tool ran and its result was
 * delivered, so there *is* something to answer with — the only thing the guard
 * should prevent is another round of tools, not the reply itself. One per
 * committed turn, so a model that keeps reaching for tools still terminates.
 */
export function canForceFinal(state: TurnState): boolean {
  return state.forcedFinalRequested === 0 && state.activeResponseId === null;
}

/** True while a forced final is outstanding, so a tool call under it is a loop. */
export function isForcingFinal(state: TurnState): boolean {
  return state.phase === 'awaiting_forced_final' || state.phase === 'forced_final_responding';
}

/**
 * After a stall, is a plain "ask again" the wrong move?
 *
 * When tool output has already been delivered, re-running the ordinary path
 * lets the model choose tools again and arrive back at the same guard — which
 * is exactly what the retry button did. Route those through the forced final.
 */
export function retryShouldForceFinal(state: TurnState): boolean {
  return state.outputsSent.length > 0 && state.forcedFinalRequested === 0;
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
    state.phase === 'awaiting_forced_final' ||
    state.phase === 'forced_final_responding' ||
    // A cancel that never reports, or a liveness reply that never arrives,
    // both leave the user talking to nothing. Ordinary `listening` stays
    // unmonitored: a continuous call may sit silent indefinitely.
    state.phase === 'cancelling_response' ||
    state.phase === 'awaiting_liveness_create' ||
    state.phase === 'awaiting_liveness_response' ||
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
    case 'forced_final_unavailable':
    case 'forced_final_looped':
      // Distinct wording on purpose: the work was done, the sentence was not.
      return `調べた結果はありますが、返答をまとめられませんでした。${suffix}`;
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
  // The forced final was the last resort and it did not land. Offering to try
  // again would walk the same path into the same guard; the user is better
  // served by the explicit way out.
  if (state.failure === 'forced_final_unavailable' || state.failure === 'forced_final_looped') {
    return false;
  }
  return true;
}
