import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';

/**
 * Completes the magic-link sign-in.
 *
 * Two shapes arrive here depending on the Supabase email template:
 *  - `?code=` — the PKCE flow used by @supabase/ssr (default).
 *  - `?token_hash=&type=` — templates rewritten to hit this route directly.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;

  // Only same-origin paths — an open redirect here would be a phishing vector.
  const rawNext = searchParams.get('next') ?? '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
    return redirectToError(origin, error.message);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, origin));
    return redirectToError(origin, error.message);
  }

  return redirectToError(origin, 'リンクが不正です');
}

function redirectToError(origin: string, message: string) {
  const url = new URL('/auth/error', origin);
  url.searchParams.set('message', message);
  return NextResponse.redirect(url);
}
