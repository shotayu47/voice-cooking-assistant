/**
 * RLS audit: proves that a second authenticated user, and an anonymous
 * caller, can neither read nor write another user's rows.
 *
 * Reads are not enough on their own — a missing UPDATE policy is invisible to
 * a SELECT test, so this also attempts a cross-user write against every
 * user-owned table and requires it to affect zero rows.
 *
 * For most tables the victim row is whatever already exists, which means a
 * table that happens to be empty is only "skipped" rather than proven. The
 * shopping list does not rely on that: it brings its own victim user and its
 * own row (see `setUpShoppingFixture`), so its policies are exercised against
 * a real target on a fresh database and can never silently pass by absence.
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

/** The attacker: a real second user, used against every table. */
const TEST_EMAIL = 'rls-audit-probe@example.com';
/** The shopping-list victim, so the attack never lands on a real person's data. */
const VICTIM_EMAIL = 'rls-audit-victim@example.com';

/**
 * Values the victim row starts with. Every one satisfies a CHECK in migration
 * 0005 — a unit without a quantity, or `checked` without `checked_at`, would be
 * rejected by the database before RLS ever came into it.
 */
const FIXTURE = {
  name: 'RLS監査用',
  normalized_name: 'rls監査用',
  quantity: null,
  unit: null,
  checked: false,
  checked_at: null,
};

const results = [];
let failures = 0;

function record(check, pass, detail) {
  results.push({ check, pass, detail });
  if (!pass) failures += 1;
}

/** Mints a session for `email`, creating the user if it does not exist. */
async function signIn(email) {
  const link = await (
    await fetch(`${BASE}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ type: 'magiclink', email }),
    })
  ).json();

  return (
    await fetch(`${BASE}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'email', token_hash: link.hashed_token }),
    })
  ).json();
}

function authHeaders(accessToken) {
  return {
    apikey: ANON,
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
}

async function deleteUserByEmail(email) {
  const users = await (
    await fetch(`${BASE}/auth/v1/admin/users?page=1&per_page=200`, { headers: admin })
  ).json();
  const found = (users.users || []).find((user) => user.email === email);
  if (!found) return 'not present';

  const response = await fetch(`${BASE}/auth/v1/admin/users/${found.id}`, {
    method: 'DELETE',
    headers: admin,
  });
  return response.ok ? 'deleted' : `delete failed (${response.status})`;
}

/** Reads the fixture row back as service role — the authority on what is really stored. */
async function readFixture(id) {
  const response = await fetch(`${BASE}/rest/v1/shopping_items?id=eq.${id}&select=*`, {
    headers: admin,
  });
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/**
 * Creates the victim user and the row the shopping-list checks attack.
 *
 * Returns null when anything fails, and records the failure — a missing
 * fixture must never turn into a skipped check that reports as a pass.
 */
async function setUpShoppingFixture() {
  const session = await signIn(VICTIM_EMAIL);
  if (!session.access_token) {
    record('shopping_items: victim sign-in', false, 'could not mint a victim session');
    return null;
  }

  const response = await fetch(`${BASE}/rest/v1/shopping_items`, {
    method: 'POST',
    headers: { ...admin, prefer: 'return=representation' },
    body: JSON.stringify({ user_id: session.user.id, ...FIXTURE }),
  });
  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;

  if (!row?.id) {
    record('shopping_items: victim row created', false, `insert failed (${response.status})`);
    return null;
  }

  record('shopping_items: victim row created', true, 'synthetic row, no real user data');
  return { userId: session.user.id, accessToken: session.access_token, row };
}

/**
 * The checks the generic loop cannot make: a spoofed INSERT, proof that the
 * row is byte-for-byte unchanged after the attacks, and that the owner is
 * still able to use their own data.
 */
async function auditShoppingItems(fixture, attacker) {
  const { row } = fixture;

  // INSERT — claim a row on the victim's behalf. The generic loop never tries
  // this, and an INSERT policy without WITH CHECK would let it through.
  const insertResponse = await fetch(`${BASE}/rest/v1/shopping_items`, {
    method: 'POST',
    headers: attacker,
    body: JSON.stringify({ user_id: fixture.userId, ...FIXTURE, name: 'RLS監査用-偽装' }),
  });
  const insertBody = await insertResponse.json().catch(() => []);
  const inserted = Array.isArray(insertBody) && insertBody.length > 0;

  // Confirm against the database rather than trusting the status code.
  const victimRows = await (
    await fetch(
      `${BASE}/rest/v1/shopping_items?user_id=eq.${fixture.userId}&select=id`,
      { headers: admin },
    )
  ).json();
  const victimCount = Array.isArray(victimRows) ? victimRows.length : -1;
  record(
    'shopping_items: cross-user insert blocked',
    !inserted && victimCount === 1,
    inserted || victimCount !== 1
      ? `SPOOFED — victim now owns ${victimCount} rows`
      : `rejected (${insertResponse.status}), victim still owns 1 row`,
  );

  // UPDATE — then verify the stored values did not move.
  const updateResponse = await fetch(`${BASE}/rest/v1/shopping_items?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: attacker,
    body: JSON.stringify({ name: 'PWNED', checked: true, checked_at: new Date().toISOString() }),
  });
  const updateBody = await updateResponse.json().catch(() => []);
  const claimedChange = Array.isArray(updateBody) && updateBody.length > 0;

  const afterUpdate = await readFixture(row.id);
  const intact =
    afterUpdate !== null &&
    afterUpdate.name === FIXTURE.name &&
    afterUpdate.checked === FIXTURE.checked &&
    afterUpdate.checked_at === FIXTURE.checked_at;
  record(
    'shopping_items: cross-user update blocked',
    !claimedChange && intact,
    intact
      ? `no rows affected (${updateResponse.status}), values verified unchanged`
      : 'MODIFIED — stored values differ from the fixture',
  );

  // DELETE — then verify the row is still there.
  const deleteResponse = await fetch(`${BASE}/rest/v1/shopping_items?id=eq.${row.id}`, {
    method: 'DELETE',
    headers: attacker,
  });
  const deleteBody = await deleteResponse.json().catch(() => []);
  const claimedDelete = Array.isArray(deleteBody) && deleteBody.length > 0;

  const afterDelete = await readFixture(row.id);
  record(
    'shopping_items: cross-user delete blocked',
    !claimedDelete && afterDelete !== null,
    afterDelete
      ? `no rows affected (${deleteResponse.status}), row verified still present`
      : 'DELETED — the row is gone',
  );

  // The policies must not be so tight that the owner loses their own list.
  const owner = authHeaders(fixture.accessToken);
  const ownerRows = await (
    await fetch(`${BASE}/rest/v1/shopping_items?select=*`, { headers: owner })
  ).json();
  const ownerSees =
    Array.isArray(ownerRows) && ownerRows.length === 1 && ownerRows[0].id === row.id;
  record(
    'shopping_items: owner read allowed',
    ownerSees,
    ownerSees ? 'owner sees exactly their own row' : 'owner cannot read their own row',
  );

  // `checked_at` travels with `checked`; sending one without the other trips a
  // CHECK constraint rather than RLS.
  const ownerUpdate = await fetch(`${BASE}/rest/v1/shopping_items?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: owner,
    body: JSON.stringify({ checked: true, checked_at: new Date().toISOString() }),
  });
  const ownerUpdateBody = await ownerUpdate.json().catch(() => []);
  const ownerChanged = Array.isArray(ownerUpdateBody) && ownerUpdateBody.length === 1;
  const afterOwnerUpdate = await readFixture(row.id);
  record(
    'shopping_items: owner update allowed',
    ownerChanged && afterOwnerUpdate?.checked === true,
    ownerChanged ? 'owner ticked their own row, verified stored' : 'owner cannot update their own row',
  );
}

/** Removes everything this run created, whether or not the checks succeeded. */
async function cleanUp(fixture) {
  const notes = [];

  if (fixture) {
    await fetch(`${BASE}/rest/v1/shopping_items?user_id=eq.${fixture.userId}`, {
      method: 'DELETE',
      headers: admin,
    });
    const left = await (
      await fetch(
        `${BASE}/rest/v1/shopping_items?user_id=eq.${fixture.userId}&select=id`,
        { headers: admin },
      )
    ).json();
    const remaining = Array.isArray(left) ? left.length : -1;
    notes.push(`fixture rows remaining: ${remaining}`);
    notes.push(`victim user: ${await deleteUserByEmail(VICTIM_EMAIL)}`);
    record('shopping_items: cleanup completed', remaining === 0, notes.join(', '));
  }

  notes.push(`probe user: ${await deleteUserByEmail(TEST_EMAIL)}`);
  return notes;
}

async function main() {
  // Bring the shopping-list victim into existence before the survey below, so
  // the generic loop finds a row to attack instead of skipping the table.
  let fixture = null;

  try {
    fixture = await setUpShoppingFixture();

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
    // Never let the shopping checks drift onto someone's real row.
    if (fixture) owned.shopping_items = fixture.row.id;

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
    const session = await signIn(TEST_EMAIL);

    if (!session.access_token) {
      record('second user sign-in', false, 'could not mint an attacker session');
      return;
    }

    const other = authHeaders(session.access_token);

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

    if (fixture) await auditShoppingItems(fixture, other);
  } finally {
    // Runs even when a check throws, so a failed audit never leaves a synthetic
    // row or a probe account behind. `report()` exits the process, so it must
    // stay outside this block.
    await cleanUp(fixture);
  }
}

function report() {
  for (const { check, pass, detail } of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}  — ${detail}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
report();
