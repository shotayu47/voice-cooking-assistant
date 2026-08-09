/**
 * State for one suggestion card, as a set of pure transitions.
 *
 * The card is used more than once: a person adds the two things they need
 * tonight, then goes back and adds a third. So a completed press must close
 * only the lines it added — not the card. Treating "this press finished" as
 * "this card is finished" made the second add impossible, which is the reason
 * this lives here, in something that can be tested, rather than in a component.
 *
 * The one state that does close the card is `unknown`: rows may or may not
 * exist, and any further press risks adding them twice.
 */

import { shouldRotateRequestId, type AddSuggestedOutcome } from './actions-core';

export type CardState = {
  /** Everything added so far, across every press on this card. */
  added: ReadonlySet<string>;
  /** What is ticked right now. */
  picked: ReadonlySet<string>;
  /** The last outcome, kept for what it says to the user. */
  outcome: AddSuggestedOutcome | null;
  /** The key the next press will use. */
  requestId: string;
};

export function initialCardState(requestId: string): CardState {
  return { added: new Set(), picked: new Set(), outcome: null, requestId };
}

/** Tick or untick one line. Lines already added cannot be re-ticked. */
export function toggleSuggestion(state: CardState, name: string): CardState {
  if (state.added.has(name) || isBlocked(state)) return state;

  const picked = new Set(state.picked);
  if (picked.has(name)) picked.delete(name);
  else picked.add(name);

  return { ...state, picked };
}

/**
 * Fold in what the server said.
 *
 * `freshRequestId` is passed in rather than generated here so this stays
 * pure; the caller supplies a new uuid and this decides whether to take it.
 */
export function applyOutcome(
  state: CardState,
  outcome: AddSuggestedOutcome,
  freshRequestId: string,
): CardState {
  const requestId = shouldRotateRequestId(outcome.status) ? freshRequestId : state.requestId;

  if (outcome.status !== 'done') {
    // Nothing landed that we know of. Leave the selection alone so the user
    // can press again — except for `unknown`, where `isBlocked` stops them.
    return { ...state, outcome, requestId };
  }

  const added = new Set(state.added);
  for (const name of outcome.added) added.add(name);

  // Drop what succeeded from the selection and keep what failed ticked, so
  // pressing again retries exactly the failures — under the new key.
  const picked = new Set<string>();
  for (const name of state.picked) {
    if (!added.has(name)) picked.add(name);
  }

  return { added, picked, outcome, requestId };
}

/**
 * Whether the card refuses further presses.
 *
 * `done` is deliberately absent: a finished press closes the lines it added,
 * not the card.
 */
export function isBlocked(state: CardState, pending = false): boolean {
  return pending || state.outcome?.status === 'unknown';
}

export function isAdded(state: CardState, name: string): boolean {
  return state.added.has(name);
}

/** True once every candidate on the card has been added. */
export function allAdded(state: CardState, names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => state.added.has(name));
}

export function canSubmit(state: CardState, names: readonly string[], pending = false): boolean {
  return !isBlocked(state, pending) && state.picked.size > 0 && !allAdded(state, names);
}

/** The lines a press should send. */
export function selectedNames(state: CardState): string[] {
  return [...state.picked];
}
