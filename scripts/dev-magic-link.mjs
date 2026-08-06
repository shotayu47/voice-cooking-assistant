/**
 * Dev helper: mint a magic-link token for local testing without the email
 * round-trip. Uses the service-role key from .env.local, server-side only.
 *
 * Prints ONLY a local callback URL (token_hash), never the keys.
 *
 * Usage: node scripts/dev-magic-link.mjs <email>
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.argv[2];

if (!url || !serviceKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local');
  process.exit(1);
}
if (!email) {
  console.error('usage: node scripts/dev-magic-link.mjs <email>');
  process.exit(1);
}

const response = await fetch(`${url}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ type: 'magiclink', email }),
});

const body = await response.json();

if (!response.ok) {
  console.error('generate_link failed:', response.status, body.msg ?? body.message ?? '');
  process.exit(1);
}

const tokenHash = body.hashed_token ?? body.properties?.hashed_token;
if (!tokenHash) {
  console.error('no hashed_token in response; keys:', Object.keys(body).join(', '));
  process.exit(1);
}

console.log(
  `http://localhost:3000/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=/`,
);
