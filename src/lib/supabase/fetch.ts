/**
 * Bounded fetch for the Supabase client.
 *
 * PostgREST calls have no timeout by default, so a stalled connection would
 * hang a server action until the platform killed it — the cooking screen would
 * just sit there. 10s is far above a normal query and far below "give up".
 */
const SUPABASE_TIMEOUT_MS = 10_000;

export function timeoutFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Respect a caller-supplied signal (e.g. request abort) alongside ours.
  const signals = [AbortSignal.timeout(SUPABASE_TIMEOUT_MS)];
  if (init?.signal) signals.push(init.signal);

  return fetch(input, { ...init, signal: AbortSignal.any(signals) });
}
