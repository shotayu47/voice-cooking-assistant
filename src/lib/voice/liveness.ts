/**
 * "もしもし？" must not become "次の工程は玉ねぎのカットです".
 *
 * When a turn dies silently the user checks whether anyone is there. On the
 * device that check was treated as a brand-new request, and the only rich
 * context in the prompt is the cooking session in progress — so the assistant
 * answered with the next cooking step, about a dish nobody had mentioned,
 * while the shopping question it had been asked was still unanswered.
 *
 * Fixing that in the prompt alone would be asking the model to be careful
 * about a state it cannot see. The turn state is known on the client, so the
 * routing decision is made here, where it can be tested.
 */

/**
 * Phrases that only ever mean "are you still there".
 *
 * Deliberately narrow. 「お願いします」 is *not* here: it is an ordinary way to
 * ask for something ("これでお願いします"), and treating it as a liveness check
 * would swallow real requests. The list is for utterances that carry no task
 * at all.
 */
const LIVENESS_PHRASES = [
  'もしもし',
  '聞こえてる',
  '聞こえてます',
  '聞こえますか',
  '聞こえる',
  'きこえてる',
  'きこえますか',
  'いる',
  'いますか',
  'おーい',
  'おういー',
  'hello',
  'あれ',
];

/** Utterances that explicitly ask to move the cooking along. */
const EXPLICIT_COOKING_PHRASES = [
  '次の工程',
  '次のステップ',
  '調理を続け',
  '料理を続け',
  '次は',
  '手順',
  '工程を教え',
  '次に進',
];

export type UtteranceKind = 'liveness_check' | 'explicit_cooking' | 'request';

/**
 * Classify one transcript.
 *
 * Explicit intent wins over the liveness list, so "次の工程は？" is a real
 * request even though it is short — the point is never to *block* cooking
 * guidance, only to stop it being volunteered.
 */
export function classifyUtterance(transcript: string): UtteranceKind {
  const text = transcript.trim().replace(/[。、．，!！?？\s]/g, '').toLowerCase();
  if (text === '') return 'request';

  if (EXPLICIT_COOKING_PHRASES.some((phrase) => text.includes(phrase))) {
    return 'explicit_cooking';
  }

  // A liveness check is the whole utterance, not a fragment of one: "聞こえる
  // ように大きく切って" contains 聞こえる but is a request about cooking.
  const isShort = text.length <= 12;
  if (isShort && LIVENESS_PHRASES.some((phrase) => text.includes(phrase))) {
    return 'liveness_check';
  }

  return 'request';
}

export type LivenessAction =
  /** Tell the user what happened to the turn that never finished. */
  | 'report_unresolved'
  /** Answer the check plainly, without volunteering a new topic. */
  | 'neutral_ack'
  /** Ordinary traffic — let the model handle it. */
  | 'pass_through';

/**
 * What to do with an utterance, given whether the previous turn resolved.
 *
 * The unresolved case is the one that was broken: the check gets the state of
 * the turn it is asking about, not a new answer about something else.
 */
export function decideLivenessAction(
  kind: UtteranceKind,
  hasUnresolvedTurn: boolean,
): LivenessAction {
  if (kind === 'liveness_check') {
    return hasUnresolvedTurn ? 'report_unresolved' : 'neutral_ack';
  }
  return 'pass_through';
}

/**
 * The neutral reply to a liveness check.
 *
 * Asks which thread to pick up rather than choosing one. Choosing is what
 * produced the cooking-step answer.
 */
export const NEUTRAL_ACK = '聞こえています。どの話を続けますか？';

/**
 * Instructions for the constrained response the client asks for after a
 * liveness check. Sent instead of letting the turn run as a free request, so
 * the answer cannot wander into the cooking session.
 */
export function livenessInstructions(action: LivenessAction, failureMessage: string | null): string {
  if (action === 'report_unresolved') {
    return [
      '直前の応答が完了しませんでした。',
      failureMessage ? `状況: ${failureMessage}` : '',
      'ユーザーには、前の依頼が完了しなかったことと、もう一度試せることだけを1文で伝えてください。',
      '調理の工程や次の手順を案内してはいけません。新しい話題を始めてはいけません。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    `「${NEUTRAL_ACK}」とだけ答えてください。`,
    '調理の工程や次の手順を案内してはいけません。新しい話題を始めてはいけません。',
  ].join('\n');
}
