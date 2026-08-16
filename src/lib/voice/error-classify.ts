/**
 * Turns a Realtime error message into a fixed token.
 *
 * The API sometimes puts the only useful detail in `error.message`, which is
 * free text and can quote the conversation back — so it must never reach the
 * trace. Classifying into a closed set keeps the diagnostic value without
 * keeping the sentence: the output is one of these constants or nothing, and
 * no substring of the input can survive.
 */

export const ERROR_PATTERNS = [
  // The one this investigation is about: a second response asked for while
  // one is still generating.
  { token: 'active_response_conflict', test: /already\s+has\s+an?\s+active\s+response/i },
  { token: 'no_active_response', test: /no\s+active\s+response|not\s+active/i },
  { token: 'response_not_found', test: /response.{0,20}not\s+found/i },
  { token: 'item_not_found', test: /item.{0,20}not\s+found/i },
  { token: 'conversation_not_found', test: /conversation.{0,20}not\s+found/i },
  { token: 'rate_limit', test: /rate\s*limit|too\s+many\s+requests/i },
  { token: 'quota_exceeded', test: /quota|insufficient|billing/i },
  { token: 'timeout', test: /timed?\s*out|timeout/i },
  { token: 'session_expired', test: /expired|session.{0,20}ended/i },
  { token: 'unauthorized', test: /unauthori[sz]ed|forbidden|invalid.{0,20}(key|token|secret)/i },
  { token: 'unsupported_value', test: /unsupported|unknown\s+parameter|not\s+supported/i },
  { token: 'invalid_request', test: /invalid|missing\s+required|must\s+be/i },
] as const;

export type ErrorToken = (typeof ERROR_PATTERNS)[number]['token'] | 'unclassified';

/**
 * Returns a token, never any part of the input.
 *
 * `unclassified` is deliberate: an unrecognised message tells us a pattern is
 * missing, which is more useful than a message we are not allowed to read.
 */
export function classifyErrorMessage(message: unknown): ErrorToken | undefined {
  if (typeof message !== 'string' || message.trim() === '') return undefined;

  for (const { token, test } of ERROR_PATTERNS) {
    if (test.test(message)) return token;
  }
  return 'unclassified';
}
