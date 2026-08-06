import { cache } from 'react';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

import { getSupabaseAnonKey, getSupabaseUrl } from './env';
import { timeoutFetch } from './fetch';
import { timed } from '@/lib/perf';

/**
 * Server-side data access layer.
 *
 * Authentication is established once per request from the JWT's *verified*
 * claims rather than by asking the Auth server who the user is. The project
 * signs tokens with an asymmetric key (ES256) and publishes a JWKS, so
 * `getClaims()` checks the signature locally with a cached public key — no
 * network round trip on the hot path. `getUser()` would cost one Auth request
 * per call, and a normal navigation made three of them before touching data.
 *
 * `getSession()` is deliberately never used as an authorization boundary: it
 * decodes the cookie without verifying it.
 */

/**
 * One Supabase client per request. `cache` memoizes for the duration of a
 * single render pass, so layout, page and services share a client — and its
 * in-memory session — instead of each re-reading cookies.
 */
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    global: { fetch: timeoutFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
});

export type AuthContext = {
  userId: string;
  email: string | null;
};

/**
 * Verified identity for this request, or null.
 *
 * Memoized per request: several Server Components and services ask for it
 * during one render and must not each redo the verification. `cache` is
 * request-scoped, so nothing is ever shared between users.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const supabase = await createClient();

  const { data, error } = await timed('auth:getClaims', () => supabase.auth.getClaims());

  const claims = data?.claims;
  if (error || !claims?.sub) return null;

  return {
    userId: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
  };
});

export class UnauthorizedError extends Error {
  constructor() {
    super('Not authenticated');
    this.name = 'UnauthorizedError';
  }
}

/**
 * Verified identity, or throw. Every route handler and mutation goes through
 * this — SPEC §19「Tool endpoints verify authenticated user」.
 */
export async function requireUser() {
  const auth = await getAuthContext();
  if (!auth) throw new UnauthorizedError();

  const supabase = await createClient();
  return { supabase, user: auth };
}

/** The `{ supabase, userId }` pair every service function takes. */
export async function getServiceContext() {
  const { supabase, user } = await requireUser();
  return { ctx: { supabase, userId: user.userId }, user };
}
