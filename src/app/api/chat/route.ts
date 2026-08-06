import { NextResponse } from 'next/server';
import { z } from 'zod';

import { UnauthorizedError, getServiceContext } from '@/lib/supabase/server';
import { getOrCreateConversation, runTurn } from '@/lib/ai/service';

/** A tool loop can legitimately take a while; beyond this it is stuck. */
export const maxDuration = 120;

const bodySchema = z.object({
  message: z.string().trim().min(1).max(1000),
  cooking_session_id: z.uuid().nullable().optional(),
});

/**
 * One chat turn. Authentication is checked here, not just in the proxy —
 * SPEC §19「Tool endpoints verify authenticated user」.
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

  try {
    const conversationId = await getOrCreateConversation(
      ctx,
      parsed.data.cooking_session_id ?? null,
    );

    const result = await runTurn(ctx, {
      conversationId,
      userMessage: parsed.data.message,
      cookingSessionId: parsed.data.cooking_session_id ?? null,
    });

    return NextResponse.json(result);
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'unknown error';
    console.error('[api/chat] turn failed:', raw);

    // The raw message can name internal tables or the model. Return something
    // the person at the stove can act on instead.
    const timedOut = /timeout|abort|ETIMEDOUT/i.test(raw);
    return NextResponse.json(
      {
        error: 'chat_failed',
        message: timedOut
          ? '応答に時間がかかりすぎました。もう一度お試しください。'
          : '応答を取得できませんでした。少し待ってもう一度お試しください。',
      },
      { status: timedOut ? 504 : 500 },
    );
  }
}
