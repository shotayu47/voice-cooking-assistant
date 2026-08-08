/**
 * Post-login redirect safety.
 *
 * Every auth entry point carries a `next` parameter that an attacker fully
 * controls — it survives in the URL of a login page we happily hand out. If we
 * redirect to it without proof that it stays on our own site, the login page
 * becomes an open redirect: a phishing link that starts on the real domain,
 * shows the real login form, and lands the user somewhere else.
 *
 * The dangerous part is that "starts with a slash" looks like proof and is not.
 * The URL parser treats a backslash as a slash for http(s), so `/\evil.test`
 * passes a `startsWith('/') && !startsWith('//')` check and still resolves to
 * `https://evil.test/`. Leading tabs and newlines are stripped before parsing,
 * so `\t//evil.test` does the same. The only reliable check is to resolve the
 * candidate the way a browser would and look at the origin that comes out.
 */

/** Where a missing or rejected `next` lands. */
export const DEFAULT_NEXT = '/';

/**
 * Stand-in origin used when the caller has no real one to offer.
 *
 * `.invalid` is reserved by RFC 2606 and can never be registered, so nothing an
 * attacker controls resolves to it. It is only a probe: `safeNext` returns a
 * path, never an absolute URL, so the origin actually redirected to is always
 * the one supplied by the runtime.
 */
const PROBE_ORIGIN = 'https://next.invalid';

/**
 * Reduces a caller-supplied `next` to a path that is guaranteed to stay on
 * `origin`, falling back to {@link DEFAULT_NEXT} when it would not.
 *
 * Returns `pathname + search + hash` — never an absolute URL — so the caller
 * resolves it against its own trusted origin.
 */
export function safeNext(raw: string | null | undefined, origin: string = PROBE_ORIGIN): string {
  if (typeof raw !== 'string' || raw === '') return DEFAULT_NEXT;

  // A same-origin path always starts with a slash. This alone proves nothing
  // (see the module comment) — it only rejects the obvious cases early, such as
  // `evil.test/x`, which would otherwise resolve to a valid but nonsensical
  // path relative to whatever page we are on.
  if (!raw.startsWith('/')) return DEFAULT_NEXT;

  let base: URL;
  let resolved: URL;
  try {
    base = new URL(origin);
    resolved = new URL(raw, base);
  } catch {
    return DEFAULT_NEXT;
  }

  // The authoritative check. `javascript:` and `data:` have an opaque origin
  // ("null"), which can never equal a real one, so they are rejected here too.
  if (resolved.origin !== base.origin) return DEFAULT_NEXT;

  // Take the parser's normalized output rather than the raw string, so nothing
  // that survived parsing (stripped control characters, `..` segments) is
  // handed back in its original form.
  const next = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return next.startsWith('/') ? next : DEFAULT_NEXT;
}
