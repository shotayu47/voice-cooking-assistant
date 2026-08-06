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
};

const IN_FLIGHT_RESULT = {
  status: 'duplicate_in_flight',
  message: '同じ操作を処理中です。結果を待ってから次の指示をしてください。',
};

export async function runOnce<T>(
  ctx: ServiceContext,
  callId: string | null | undefined,
  toolName: string,
  run: () => Promise<T>,
): Promise<RunOnceResult<T>> {
  // No key supplied (e.g. the text loop, which guards per turn instead).
  if (!callId) return { value: await run(), duplicate: false };

  const claim = await ctx.supabase
    .from('ai_tool_calls')
    .upsert(
      { user_id: ctx.userId, call_id: callId, tool_name: toolName, status: 'in_flight' },
      { onConflict: 'user_id,call_id', ignoreDuplicates: true },
    )
    .select('id');

  if (claim.error) {
    // Never fail a user action because bookkeeping failed — but say so loudly.
    console.error('[idempotency] claim failed, executing unguarded:', claim.error.message);
    return { value: await run(), duplicate: false };
  }

  const won = (claim.data ?? []).length > 0;

  if (!won) {
    const { data } = await ctx.supabase
      .from('ai_tool_calls')
      .select('status, result')
      .eq('user_id', ctx.userId)
      .eq('call_id', callId)
      .maybeSingle();

    if (data?.status === 'done') {
      return { value: data.result as T, duplicate: true };
    }
    return { value: IN_FLIGHT_RESULT as T, duplicate: true };
  }

  let value: T;
  try {
    value = await run();
  } catch (error) {
    // Release the claim so a genuine retry can run rather than being told
    // "already in flight" forever.
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

  return { value, duplicate: false };
}
