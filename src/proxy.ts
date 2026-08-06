import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/supabase/env';
import { timed } from '@/lib/perf';

const PUBLIC_PATHS = ['/login', '/auth/callback', '/auth/error'];

/**
 * Refreshes the Supabase session cookie on every request and gates the app
 * behind auth.
 *
 * Uses `getClaims()`, which verifies the JWT signature locally against the
 * project's published JWKS (tokens are ES256) instead of asking the Auth
 * server. That keeps this a real authorization check while removing a network
 * round trip from every single navigation. `getSession()` would not be
 * acceptable here — it decodes the cookie without verifying it.
 *
 * Cookie refresh is preserved: `getClaims()` reads the session first, which
 * renews an expired token and writes the new cookies through `setAll`.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { data } = await timed('proxy:auth', () => supabase.auth.getClaims());
  const isAuthenticated = Boolean(data?.claims?.sub);

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );

  if (!isAuthenticated && !isPublic) {
    // API callers must get a status they can branch on. Redirecting them to
    // the login page would hand `fetch` an HTML body with a 200, which reads
    // as success to the voice and chat clients.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthenticated && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the PWA files.
     */
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
