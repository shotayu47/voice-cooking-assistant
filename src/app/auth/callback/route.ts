import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

import { safeNext } from '@/lib/auth/redirect';
import { createClient } from '@/lib/supabase/server';

/**
 * Completes a link-based sign-in.
 *
 * Day-to-day sign-in is the six-digit email OTP, which never reaches this
 * route — it is verified in a Server Action. Two shapes still arrive here:
 *  - `?code=` — the PKCE flow, kept for the OAuth providers coming next.
 *  - `?token_hash=&type=` — magic-link mail already in users' inboxes, kept
 *    for the migration window so links sent before the switch still work.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;

  // `next` is attacker-controlled. Resolving it against our own origin is the
  // only check that holds — see src/lib/auth/redirect.ts.
  const next = safeNext(searchParams.get('next'), origin);

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
    return redirectToError(origin, 'link', error.message);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, origin));
    return redirectToError(origin, 'link', error.message);
  }

  return redirectToError(origin, 'malformed');
}

/**
 * Sends the user to the error page with a reason *code*, not a message.
 *
 * The raw Supabase text is English and written for developers, and anything
 * put in this query string is rendered back to whoever opens the URL — so the
 * page owns the wording and only ever renders strings it knows. The original
 * error stays in the server log.
 */
function redirectToError(origin: string, reason: 'link' | 'malformed', detail?: string) {
  if (detail) console.error(`[auth/callback] ${reason}:`, detail);

  const url = new URL('/auth/error', origin);
  url.searchParams.set('reason', reason);
  return NextResponse.redirect(url);
}
