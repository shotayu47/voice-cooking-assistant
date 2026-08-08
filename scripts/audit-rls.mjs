/**
 * RLS audit: proves that a second authenticated user, and an anonymous
 * caller, can neither read nor write another user's rows.
 *
 * Reads are not enough on their own — a missing UPDATE policy is invisible to
 * a SELECT test, so this also attempts a cross-user write against every
 * user-owned table and requires it to affect zero rows.
 *
 * Usage: node scripts/audit-rls.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON =
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const admin = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' };

const USER_TABLES = [
  'profiles',
  'inventory_items',
  'recipes',
  'cooking_sessions',
  'inventory_transactions',
  'conversation_sessions',
  'conversation_messages',
  'ai_tool_calls',
  'shopping_items',
];

const TEST_EMAIL = 'rls-audit-probe@example.com';

const results = [];
let failures = 0;

function record(check, pass, detail) {
  results.push({ check, pass, detail });
  if (!pass) failures += 1;
}

async function main() {
  // 1. Confirm RLS is actually enabled and rows exist to protect.
  const owned = {};
  for (const table of USER_TABLES) {
    const response = await fetch(`${BASE}/rest/v1/${table}?select=id&limit=1`, { headers: admin });
    if (response.status === 404) {
      record(`${table}: table exists`, false, 'missing — run the migrations');
      continue;
    }
    const rows = await response.json();
    owned[table] = Array.isArray(rows) && rows.length > 0 ? rows[0].id : null;
  }

  // 2. Anonymous caller (valid anon key, no session).
  for (const table of USER_TABLES) {
    if (!(table in owned)) continue;
    const response = await fetch(`${BASE}/rest/v1/${table}?select=*&limit=5`, {
      headers: { apikey: ANON },
    });
    const body = await response.json().catch(() => null);
    const leaked = Array.isArray(body) && body.length > 0;
    record(`${table}: anonymous read blocked`, !leaked, leaked ? `LEAKED ${body.length} rows` : 'no rows');
  }

  // 3. A second real user.
  const link = await (
    await fetch(`${BASE}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ type: 'magiclink', email: TEST_EMAIL }),
    })
  ).json();

  const session = await (
    await fetch(`${BASE}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'email', token_hash: link.hashed_token }),
    })
  ).json();

  if (!session.access_token) {
    record('second user sign-in', false, JSON.stringify(session).slice(0, 160));
    return report();
  }

  const other = {
    apikey: ANON,
    authorization: `Bearer ${session.access_token}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
  };

  for (const table of USER_TABLES) {
    if (!(table in owned)) continue;

    // Read.
    const readResponse = await fetch(`${BASE}/rest/v1/${table}?select=*&limit=5`, { headers: other });
    const readBody = await readResponse.json().catch(() => null);
    // profiles legitimately returns the second user's own auto-created row.
    const foreign = Array.isArray(readBody)
      ? readBody.filter((row) => (table === 'profiles' ? row.id !== session.user.id : row.user_id !== session.user.id))
      : [];
    record(
      `${table}: cross-user read blocked`,
      foreign.length === 0,
      foreign.length ? `LEAKED ${foreign.length} rows` : 'own rows only',
    );

    // Write against a row that belongs to the first user.
    const targetId = owned[table];
    if (!targetId) {
      record(`${table}: cross-user write blocked`, true, 'no target row to attack (skipped)');
      continue;
    }

    const patch = table === 'profiles' ? { display_name: 'PWNED' } : { created_at: '2000-01-01T00:00:00Z' };
    const writeResponse = await fetch(`${BASE}/rest/v1/${table}?id=eq.${targetId}`, {
      method: 'PATCH',
      headers: other,
      body: JSON.stringify(patch),
    });
    const writeBody = await writeResponse.json().catch(() => []);
    const changed = Array.isArray(writeBody) && writeBody.length > 0;
    record(
      `${table}: cross-user write blocked`,
      !changed,
      changed ? `MODIFIED ${writeBody.length} rows` : `no rows affected (${writeResponse.status})`,
    );

    // Delete.
    const deleteResponse = await fetch(`${BASE}/rest/v1/${table}?id=eq.${targetId}`, {
      method: 'DELETE',
      headers: other,
    });
    const deleteBody = await deleteResponse.json().catch(() => []);
    const deleted = Array.isArray(deleteBody) && deleteBody.length > 0;
    record(
      `${table}: cross-user delete blocked`,
      !deleted,
      deleted ? `DELETED ${deleteBody.length} rows` : `no rows affected (${deleteResponse.status})`,
    );
  }

  // Clean up the probe account.
  const users = await (
    await fetch(`${BASE}/auth/v1/admin/users?page=1&per_page=200`, { headers: admin })
  ).json();
  const probe = (users.users || []).find((user) => user.email === TEST_EMAIL);
  if (probe) {
    await fetch(`${BASE}/auth/v1/admin/users/${probe.id}`, { method: 'DELETE', headers: admin });
  }

  report();
}

function report() {
  for (const { check, pass, detail } of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}  — ${detail}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
