/**
 * Did the user actually ask to move the cooking on?
 *
 * "次の工程を教えて" — a request to *hear* the next step — advanced the session
 * twice and marked two steps complete that nobody had done. The model chose
 * `advance_cooking_step`, and nothing between that choice and the database
 * asked whether the user had authorised a write.
 *
 * The tool description and the prompt both invited it: each listed a bare
 * 「次」 as a completion signal, and 「次の工程を教えて」 contains 「次」. Those are
 * fixed separately — but a prompt already said "ユーザーが質問しているだけの場合、
 * 勝手に工程を進めないでください" and was overridden anyway, which is the reason
 * this gate exists rather than a better sentence.
 *
 * Fail-closed: a step only moves when the utterance can be positively read as
 * authorising it. Anything else — a bare 「次」, a mixed phrasing, no transcript
 * at all — leaves the database alone.
 */

export type StepIntent =
  /** The user said they finished, or asked to move on. */
  | 'advance'
  /** The user asked what the step is. Read the step; write nothing. */
  | 'read_only'
  /** Cannot be told apart. Treated as read-only, because writes need proof. */
  | 'ambiguous';

/**
 * Interrogatives and "say it again" phrasings.
 *
 * These are what make an utterance a question about the step rather than a
 * statement about having done it.
 */
const READ_ONLY_MARKERS = [
  '教えて',
  'おしえて',
  '何',
  'なに',
  'どこ',
  'どれ',
  'どの',
  'いつ',
  'どのくらい',
  'どれくらい',
  '確認',
  '読み上げ',
  '言って',
  'もう一度',
  '聞かせ',
  '現在',
  '今の',
  'いまの',
];

/**
 * Completion and progression.
 *
 * Deliberately excludes a bare 「次」: on its own it is exactly as likely to
 * begin "次は何をする？" as "次へ進めて", and it is the word that caused this.
 */
const ADVANCE_MARKERS = [
  'できた',
  '出来た',
  'できました',
  'でき ました',
  '終わった',
  '終わりました',
  'おわった',
  '済んだ',
  '完了',
  '次へ進',
  '次に進',
  '進めて',
  '進んで',
  'すすめて',
];

/**
 * Classify one recognised utterance.
 *
 * An utterance carrying both kinds of marker is `ambiguous`, not `advance` —
 * "完了したか教えて" asks a question about completion and must not perform one.
 */
export function classifyStepUtterance(transcript: string | null | undefined): StepIntent {
  if (typeof transcript !== 'string') return 'ambiguous';

  const text = transcript.trim().replace(/[。、．，!！?？\s]/g, '');
  if (text === '') return 'ambiguous';

  const asksAboutIt = READ_ONLY_MARKERS.some((marker) => text.includes(marker));
  const declaresItDone = ADVANCE_MARKERS.some((marker) => text.includes(marker));

  if (asksAboutIt && !declaresItDone) return 'read_only';
  if (declaresItDone && !asksAboutIt) return 'advance';
  return 'ambiguous';
}

export type AdvanceDecision =
  | 'allow'
  /** No authorising utterance could be matched to this call. */
  | 'refuse_unauthorised'
  /** One step per committed turn, however many times the model asks. */
  | 'refuse_already_advanced';

/**
 * The gate itself.
 *
 * `transcript` is the recognition result for the *same committed turn* as the
 * tool call. When the two cannot be correlated it must be passed as null, and
 * the answer is no — a write attributed to the wrong utterance is exactly the
 * failure being prevented.
 */
export function decideAdvance(
  transcript: string | null | undefined,
  advancesThisTurn: number,
): AdvanceDecision {
  if (advancesThisTurn > 0) return 'refuse_already_advanced';
  return classifyStepUtterance(transcript) === 'advance' ? 'allow' : 'refuse_unauthorised';
}

/**
 * What goes back to the model when a step change is refused.
 *
 * It still needs an output for that `call_id` or it waits forever, and it
 * needs to know why — otherwise it tries again. `currentStep` is included when
 * it could be read, so the model can answer the question that was actually
 * asked instead of reporting a failure.
 */
export function refusedAdvanceOutput(decision: AdvanceDecision, currentStep: unknown): unknown {
  const message =
    decision === 'refuse_already_advanced'
      ? 'この発話ではすでに1工程進めています。同じ依頼で二重に進めることはできません。現在の工程を案内してください。'
      : 'ユーザーは工程の完了を明示していません。工程は進めていません。現在の工程を読み上げて案内し、進める場合は「できた」「次へ進めて」と言ってもらうよう促してください。';

  return {
    advanced: false,
    reason: decision,
    message,
    ...(currentStep === undefined || currentStep === null ? {} : { current: currentStep }),
  };
}
