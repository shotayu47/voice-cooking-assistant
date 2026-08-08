/**
 * Dev helper: get a six-digit login code without sending an email.
 *
 * `signInWithOtp` costs an email every time, and Supabase's built-in SMTP is
 * rate limited hard enough that a normal afternoon of UI work exhausts it. The
 * admin `generate_link` endpoint mints the same code the email would have
 * carried and sends nothing, so local testing never touches the mail quota.
 *
 * Usage:
 *   node scripts/dev-otp.mjs <email>                  print a code for an existing user
 *   node scripts/dev-otp.mjs <email> --signup         create the user first, then print a code
 *   node scripts/dev-otp.mjs <email> --verify 123456  redeem a code, print the user id
 *
 * The `--verify` mode is how the "same user id after re-login" regression gets
 * checked without a browser: run it twice and compare the ids.
 *
 * Safety:
 *   - reads .env.local only, which is gitignored — nothing lands in the repo
 *   - the service-role key is used for one server-to-server call and is never
 *     printed, written to disk, or exposed to anything that reaches a browser
 *   - the code goes to stdout and nowhere else
 *   - refuses to run in production-like environments (see assertDevEnvironment)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Aborts with a message.
 *
 * Throws rather than calling `process.exit`: exiting while `fetch` still holds
 * a keep-alive socket trips a libuv assertion on Windows, which turns a clean
 * error message into a crash dump. `main` catches this and sets the exit code,
 * letting Node close its handles on its own.
 */
class Abort extends Error {}

function fail(message) {
  throw new Abort(message);
}

/**
 * Refuses to run anywhere that looks like a deployed environment.
 *
 * This script mints a working credential for an arbitrary address, so the cost
 * of it being reachable in production is an account takeover. The guards are
 * deliberately blunt and have no override flag: there is no legitimate reason
 * to mint a login code for someone else on a production project.
 */
function assertDevEnvironment() {
  if (process.env.NODE_ENV === 'production') {
    fail('refusing to run with NODE_ENV=production — this mints a working login code');
  }
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    fail('refusing to run on Vercel — this is a local development helper');
  }
  if (process.env.CI) {
    fail('refusing to run in CI — this mints a working login code');
  }
}

/**
 * Loads .env.local, and only .env.local.
 *
 * Naming the file explicitly is itself a guard: `.env.production` is never
 * read, so pointing this at a production project takes a deliberate edit of a
 * developer's own machine rather than a stray environment variable.
 */
function loadEnv() {
  let text;
  try {
    text = readFileSync(join(root, '.env.local'), 'utf8');
  } catch {
    fail('.env.local not found — copy .env.example and fill it in');
  }

  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

async function post(url, apikey, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey,
      authorization: `Bearer ${apikey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return { ok: response.ok, status: response.status, body: await response.json() };
}

/** Supabase reports failures under several keys depending on the endpoint. */
function reason(body) {
  return body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? '';
}

async function main() {
  assertDevEnvironment();

  const env = loadEnv();
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey =
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

  const [email, ...flags] = process.argv.slice(2);
  const wantsSignup = flags.includes('--signup');
  const verifyIndex = flags.indexOf('--verify');
  const codeToVerify = verifyIndex === -1 ? null : flags[verifyIndex + 1];

  if (!email) {
    fail(
      [
        'usage:',
        '  node scripts/dev-otp.mjs <email>',
        '  node scripts/dev-otp.mjs <email> --signup',
        '  node scripts/dev-otp.mjs <email> --verify <code>',
      ].join('\n'),
    );
  }
  if (!supabaseUrl) fail('NEXT_PUBLIC_SUPABASE_URL missing from .env.local');

  if (codeToVerify !== null) {
    // Deliberately wider than the app's six digits: Supabase's OTP length is a
    // dashboard setting, and this tool needs to be able to *show* a mismatch
    // rather than reject the evidence of one.
    if (!/^\d{6,10}$/.test(codeToVerify ?? '')) {
      fail('--verify needs a numeric code (6-10 digits)');
    }
    if (!anonKey) {
      fail('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or ANON_KEY) missing from .env.local');
    }

    // The anon key on purpose: this exercises the same path the app takes, so a
    // pass here means the browser flow works too.
    const result = await post(`${supabaseUrl}/auth/v1/verify`, anonKey, {
      type: 'email',
      email,
      token: codeToVerify,
    });

    if (!result.ok) fail(`verify failed: ${result.status} ${reason(result.body)}`);

    // Only the id — the session tokens in this response stay out of the terminal.
    console.log(`ok  user.id = ${result.body.user?.id ?? '(missing)'}`);
    return;
  }

  if (!serviceKey) fail('SUPABASE_SERVICE_ROLE_KEY missing from .env.local');

  // `magiclink` for an address that already has an account, `signup` for one
  // that does not. Both carry an `email_otp`; asking for the wrong one is an
  // error rather than a silent no-op, so the flag has to be explicit.
  const payload = wantsSignup
    ? {
        type: 'signup',
        email,
        // generate_link requires a password for signup. Nothing uses it — this
        // app authenticates by OTP only — so it is thrown away unprinted.
        password: `dev-${crypto.randomUUID()}`,
      }
    : { type: 'magiclink', email };

  const result = await post(`${supabaseUrl}/auth/v1/admin/generate_link`, serviceKey, payload);

  if (!result.ok) {
    const detail = reason(result.body);
    if (!wantsSignup && /user not found/i.test(detail)) {
      fail(`no account for ${email} — rerun with --signup to create one`);
    }
    fail(`generate_link failed: ${result.status} ${detail}`);
  }

  // Flat on the REST endpoint, nested when it comes back through supabase-js.
  const otp = result.body.email_otp ?? result.body.properties?.email_otp;
  if (!otp) fail(`no email_otp in response; keys: ${Object.keys(result.body).join(', ')}`);

  // stdout is the code alone, so `CODE=$(npm run dev:otp ...)` stays usable.
  console.log(otp);
  console.error(`(no email sent — code for ${email}; length ${String(otp).length})`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Abort ? error.message : error);
  process.exitCode = 1;
}
