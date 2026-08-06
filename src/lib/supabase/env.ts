/**
 * Supabase public credentials.
 *
 * Newer Supabase dashboards issue a "publishable" key (sb_publishable_...)
 * in place of the legacy anon JWT; both fill the same role with RLS as the
 * boundary. Accept either env name so setup matches whatever the dashboard
 * showed.
 *
 * NEXT_PUBLIC_ values are inlined at build time, so each candidate must be
 * spelled out — no dynamic process.env lookups.
 */
export function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured');
  return url;
}

export function getSupabaseAnonKey(): string {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
  if (!key) {
    throw new Error(
      'Set NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) in .env.local',
    );
  }
  return key;
}
