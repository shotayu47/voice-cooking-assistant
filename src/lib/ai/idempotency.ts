import 'server-only';

import type { ServiceContext } from '@/lib/inventory/service';

/**
 * Run a tool exactly once per `callId`.
 *
 * A retried relay must not decrement inventory twice. The claim is an insert
 * against a unique index, so of two concurrent relays exactly one wins and
 * executes; the loser reads the winner's stored result instead of running.
 */

export type RunOnceResult<T> = {
  value: T;
  /** True when this call had already been executed (or is executing). */
  duplicate: boolean;
  /**
   * False when the outcome could not be written back to the ledger.
   *
   * The work still happened; what is missing is the record of it. A retry of
   * the same key will be refused rather than re-run, so a write caller should
   * treat this as "cannot confirm" and send the user to check, not retry.
   */
  stored: boolean;
};

/**
 * Raised by `runOnceStrict` when the ledger itself is unusable.
 *
 * The default `runOnce` executes anyway if the claim fails — for a read, an
 * unavailable ledger is not worth failing the user's request over. A write is
 * the opposite: executing without a claim is exactly the double-submit the
 * ledger exists to prevent, so the operation must not start at all.
 */
export class IdempotencyUnavailableError extends Error {
  constructor() {
    super('Idempotency ledger unavailable');
    this.name = 'IdempotencyUnavailableError';
  }
}

/**
 * Raised when a guarded write started but its outcome cannot be established.
 *
 * Distinct from {@link IdempotencyUnavailableError}, which means nothing ran.
 * Here the callback was entered, so rows may exist. The claim is kept so the
 * same key cannot re-run, and the caller must send the user to look at the
 * result rather than offer a retry.
 *
 * This is why the design is not described as exactly-once: it is
 * at-most-once, and an unresolved outcome stops rather than guesses.
 */
export class IdempotentWriteUnresolvedError extends Error {
  constructor() {
    super('Guarded write outcome could not be established');
    this.name = 'IdempotentWriteUnresolvedError';
  }
}

const IN_FLIGHT_RESULT = {
  status: 'duplicate_in_flight',
  message: '同じ操作を処理中です。結果を待ってから次の指示をしてください。',
};

export async function runOnce<T>(
  ctx: ServiceContext,
  callId: string | null | undefined,
  toolName: string,
  run: () => Promise<T>,
  options: { failClosed?: boolean } = {},
): Promise<RunOnceResult<T>> {
  // No key supplied (e.g. the text loop, which guards per turn instead).
  if (!callId) {
    if (options.failClosed) throw new IdempotencyUnavailableError();
    return { value: await run(), duplicate: false, stored: false };
  }

  const claim = await ctx.supabase
    .from('ai_tool_calls')
    .upsert(
      { user_id: ctx.userId, call_id: callId, tool_name: toolName, status: 'in_flight' },
      { onConflict: 'user_id,call_id', ignoreDuplicates: true },
    )
    .select('id');

  if (claim.error) {
    console.error('[idempotency] claim failed:', claim.error.message);
    // A write must not proceed unguarded: without a claim, a retry would
    // apply it a second time, which is the whole thing the ledger prevents.
    if (options.failClosed) throw new IdempotencyUnavailableError();
    // Reads keep the old behaviour — never fail a user action because
    // bookkeeping failed, but say so loudly.
    return { value: await run(), duplicate: false, stored: false };
  }

  const won = (claim.data ?? []).length > 0;

  if (!won) {
    const { data, error } = await ctx.supabase
      .from('ai_tool_calls')
      .select('status, result')
      .eq('user_id', ctx.userId)
      .eq('call_id', callId)
      .maybeSingle();

    // Someone else holds the claim but we cannot read what they got. Guessing
    // "still running" is safe for a read and wrong for a write, where the
    // caller needs to know it must not try again on its own.
    if (error && options.failClosed) {
      console.error('[idempotency] result read failed:', error.message);
      throw new IdempotencyUnavailableError();
    }

    if (data?.status === 'done') {
      return { value: data.result as T, duplicate: true, stored: true };
    }
    return { value: IN_FLIGHT_RESULT as T, duplicate: true, stored: true };
  }

  let value: T;
  try {
    value = await run();
  } catch (error) {
    if (options.failClosed) {
      // Do NOT release the claim. The callback may have written some of its
      // work before failing, and a retry that re-ran it would add those rows a
      // second time — the exact thing this ledger exists to stop. The claim
      // stays, so the retry is refused, and the caller has to tell the user to
      // go and look rather than press the button again.
      console.error('[idempotency] write failed after claiming; claim kept:', error);
      throw new IdempotentWriteUnresolvedError();
    }

    // Reads: release the claim so a genuine retry can run rather than being
    // told "already in flight" forever. Nothing was written to undo.
    await ctx.supabase
      .from('ai_tool_calls')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('call_id', callId);
    throw error;
  }

  const { error } = await ctx.supabase
    .from('ai_tool_calls')
    .update({ status: 'done', result: value })
    .eq('user_id', ctx.userId)
    .eq('call_id', callId);

  if (error) console.error('[idempotency] result store failed:', error.message);

  // The claim is deliberately left in place when the result could not be
  // stored. It stays `in_flight`, so a retry of the same key is refused rather
  // than re-run — the work happened, we just cannot prove what it did.
  return { value, duplicate: false, stored: !error };
}
