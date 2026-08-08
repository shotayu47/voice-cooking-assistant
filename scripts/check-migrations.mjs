/**
 * Reports which migrations are actually applied to the live database.
 *
 * `npm run audit:rls` only checks row-level security — it says nothing about
 * whether a migration's columns exist, which made it a misleading way to
 * verify a deploy. This checks the real thing: for each migration, probe a
 * column or table that migration introduces.
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

/** Each migration, and something it introduces that proves it ran. */
const MIGRATIONS = [
  { file: '0001_init.sql', probe: 'inventory_items?select=id&limit=1' },
  { file: '0002_tool_call_idempotency.sql', probe: 'ai_tool_calls?select=id&limit=1' },
  { file: '0003_expiry_tracking.sql', probe: 'inventory_items?select=expiry_source&limit=1' },
  { file: '0004_cooking_progress.sql', probe: 'cooking_sessions?select=completed_steps&limit=1' },
  { file: '0005_shopping_list.sql', probe: 'shopping_items?select=id&limit=1' },
];

const headers = { apikey: KEY, authorization: `Bearer ${KEY}` };
let missing = 0;

for (const migration of MIGRATIONS) {
  const response = await fetch(`${BASE}/rest/v1/${migration.probe}`, { headers });
  const applied = response.ok;
  if (!applied) missing += 1;
  console.log(`${applied ? '✅ APPLIED ' : '❌ MISSING '} ${migration.file}`);
}

console.log(
  missing === 0
    ? `\n${MIGRATIONS.length}/${MIGRATIONS.length} 適用済み`
    : `\n${missing} 件が未適用。Supabase SQL Editor で supabase/migrations/ の該当ファイルを実行してください。`,
);

process.exit(missing === 0 ? 0 : 1);
