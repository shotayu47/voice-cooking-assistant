/**
 * Reports which migrations are actually applied to the live database.
 *
 * `npm run audit:rls` only checks row-level security — it says nothing about
 * whether a migration's columns exist, which made it a misleading way to
 * verify a deploy. This checks the real thing: for each migration, probe a
 * column or table that migration introduces.
 *
 * Three outcomes, not two. Some migrations leave nothing PostgREST can see —
 * an index lives in `pg_catalog`, which is not exposed — and for those the
 * honest answer is MANUAL VERIFICATION REQUIRED rather than a guess in either
 * direction. Only APPLIED exits 0.
 *
 * Reads .env.local directly, so it works from any shell without exporting
 * anything first. Never prints a key.
 *
 * Usage: npm run check:migrations
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let env;
try {
  env = Object.fromEntries(
    readFileSync(join(root, '.env.local'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
} catch {
  console.error('.env.local が読めません。プロジェクト直下で実行してください。');
  process.exit(1);
}

const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!BASE || !KEY) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を .env.local に設定してください。',
  );
  process.exit(1);
}

const ONE_ACTIVE_INDEX = 'conversation_sessions_one_active_per_user_idx';

/**
 * The catalogue rendered readable. `pg_get_indexdef` puts uniqueness, the
 * indexed column and the partial predicate into one string, so one match
 * answers all three questions the index has to satisfy.
 */
function indexDefinitionMatches(definition) {
  const text = String(definition ?? '').toLowerCase();
  return (
    text.includes('unique index') &&
    /on\s+(public\.)?conversation_sessions\b/.test(text) &&
    /\(\s*user_id\s*\)/.test(text) &&
    /where\s+\(?\s*status\s*=\s*'active'/.test(text)
  );
}

/**
 * Does the partial unique index exist?
 *
 * PostgREST exposes application schemas, not `pg_catalog`, so on a stock
 * Supabase project there is no route to `pg_index` at all. That is a third
 * answer, not a "no": returns true / false when the catalogue can be read, and
 * null when it cannot be reached. Callers must not collapse null into either.
 */
async function probeOneActiveIndex(headers) {
  const routes = [
    `${BASE}/rest/v1/pg_indexes?schemaname=eq.public&indexname=eq.${ONE_ACTIVE_INDEX}&select=indexdef`,
    `${BASE}/rest/v1/pg_index?select=indexdef&indexname=eq.${ONE_ACTIVE_INDEX}`,
  ];

  for (const route of routes) {
    let rows;
    try {
      const response = await fetch(route, { headers });
      if (!response.ok) continue;
      rows = await response.json();
    } catch {
      continue;
    }
    // A reachable catalogue that returns nothing is evidence of absence.
    if (Array.isArray(rows)) return rows.some((row) => indexDefinitionMatches(row.indexdef));
  }

  return null;
}

const APPLIED = 'applied';
const MISSING = 'missing';
const UNVERIFIED = 'unverified';

/** Each migration, and something it introduces that proves it ran. */
const MIGRATIONS = [
  { file: '0001_init.sql', probe: 'inventory_items?select=id&limit=1' },
  { file: '0002_tool_call_idempotency.sql', probe: 'ai_tool_calls?select=id&limit=1' },
  { file: '0003_expiry_tracking.sql', probe: 'inventory_items?select=expiry_source&limit=1' },
  { file: '0004_cooking_progress.sql', probe: 'cooking_sessions?select=completed_steps&limit=1' },
  { file: '0005_shopping_list.sql', probe: 'shopping_items?select=id&limit=1' },
  {
    file: '0006_one_active_conversation.sql',
    // This one adds an index and normalises rows, so there is no new column to
    // select — and the two halves can be told apart, which matters. "No user
    // has two active conversations" is a *consequence* of the index, not proof
    // of it: an operator who ran only the UPDATE half, or who tidied the rows
    // by hand, produces exactly that reading with nothing stopping the next
    // race. Absent duplicates therefore only rules the index out; it never
    // rules it in.
    verify: async (headers) => {
      const response = await fetch(
        `${BASE}/rest/v1/conversation_sessions?status=eq.active&select=user_id`,
        { headers },
      );
      if (!response.ok) {
        return { status: UNVERIFIED, note: `conversation_sessions を読めません (${response.status})` };
      }

      const seen = new Set();
      for (const row of await response.json()) {
        if (seen.has(row.user_id)) {
          return { status: MISSING, note: 'active な会話が重複しています（index は存在し得ません）' };
        }
        seen.add(row.user_id);
      }

      const indexed = await probeOneActiveIndex(headers);
      if (indexed === true) return { status: APPLIED };
      if (indexed === false) {
        return { status: MISSING, note: `${ONE_ACTIVE_INDEX} がありません（行の整理だけが適用された状態）` };
      }

      return {
        status: UNVERIFIED,
        note:
          'active の重複は 0 件。ただし PostgREST から pg_index を読めないため、' +
          'index の有無は確認できていません',
      };
    },
  },
];

const headers = { apikey: KEY, authorization: `Bearer ${KEY}` };
const LABELS = {
  [APPLIED]: '✅ APPLIED                     ',
  [MISSING]: '❌ MISSING                     ',
  [UNVERIFIED]: '⚠️  MANUAL VERIFICATION REQUIRED',
};

let missing = 0;
let unverified = 0;

for (const migration of MIGRATIONS) {
  const result = migration.verify
    ? await migration.verify(headers)
    : {
        status: (await fetch(`${BASE}/rest/v1/${migration.probe}`, { headers })).ok
          ? APPLIED
          : MISSING,
      };

  if (result.status === MISSING) missing += 1;
  if (result.status === UNVERIFIED) unverified += 1;

  console.log(`${LABELS[result.status]} ${migration.file}`);
  if (result.note) console.log(`   ${result.note}`);
}

if (missing > 0) {
  console.log(
    `\n${missing} 件が未適用。Supabase SQL Editor で supabase/migrations/ の該当ファイルを実行してください。`,
  );
}

if (unverified > 0) {
  console.log(
    `\n${unverified} 件は自動では確認できませんでした。` +
      '\ndocs/phase10-ai-shopping-suggestions.md §12 の読み取り専用 SQL を' +
      '\nSupabase SQL Editor で実行して確認してください。',
  );
}

if (missing === 0 && unverified === 0) {
  console.log(`\n${MIGRATIONS.length}/${MIGRATIONS.length} 適用済み`);
}

// Unverified is not a pass. Exiting 0 here would let a half-applied 0006 —
// rows tidied, index absent — read as green in CI.
process.exit(missing === 0 && unverified === 0 ? 0 : 1);
