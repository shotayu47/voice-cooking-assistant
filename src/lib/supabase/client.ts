import { createBrowserClient } from '@supabase/ssr';

import { getSupabaseAnonKey, getSupabaseUrl } from './env';

/**
 * Browser Supabase client. Only ever sees the anon/publishable key — every
 * read and write it makes is constrained by RLS.
 */
export function createClient() {
  return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey());
}
