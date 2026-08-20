import { NextResponse } from 'next/server';
import { z } from 'zod';

import { UnauthorizedError, getServiceContext } from '@/lib/supabase/server';
import { executeTool, type ToolOutcome } from '@/lib/ai/tools';
import { runOnce } from '@/lib/ai/idempotency';
import { serializeToolResponse } from './serialize-tool-response';

/** A hung tool call would leave the voice assistant waiting silently. */
export const maxDuration = 30;

const bodySchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z.string().max(20_000),
  /**
   * The Realtime function-call id. Makes the execution idempotent: a retried
   * relay returns the stored result instead of running the tool again.
   */
  call_id: z.string().min(1).max(200).nullable().optional(),
});

/**
 * Executes one Realtime function call (SPEC §21.2: voice uses the same
 * backend tools as text).
 *
 * The Realtime model calls functions on the client over the data channel, but
 * the execution happens here: authenticated, RLS-scoped, and audited with
 * source 'ai_voice'. The browser never touches the database directly.
 */
export async function POST(request: Request) {
  let ctx;
  try {
    ({ ctx } = await getServiceContext());
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const { name, arguments: args, call_id: callId } = parsed.data;

  const { value, duplicate } = await runOnce<ToolOutcome>(ctx, callId, name, () =>
    executeTool(ctx, name, args, 'ai_voice'),
  );

  return NextResponse.json(serializeToolResponse(value, duplicate));
}
