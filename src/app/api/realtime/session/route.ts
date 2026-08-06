import { NextResponse } from 'next/server';

import { UnauthorizedError, getServiceContext } from '@/lib/supabase/server';
import { getOpenSession } from '@/lib/cooking/service';
import { buildSystemPrompt } from '@/lib/ai/prompt';
import { realtimeToolDefinitions } from '@/lib/ai/tools';
import type { Profile } from '@/types/domain';

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';

export const maxDuration = 30;

/**
 * Mints a short-lived Realtime client secret (SPEC §21.2).
 *
 * The permanent OPENAI_API_KEY stays on this server; the browser only ever
 * receives the ephemeral `ek_...` value. Instructions and tools are fixed
 * server-side at mint time, so the client cannot rewrite the assistant's rules.
 */
export async function POST() {
  let ctx;
  let userId: string;
  try {
    const context = await getServiceContext();
    ctx = context.ctx;
    userId = context.user.id;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'openai_not_configured' }, { status: 500 });
  }

  const [session, profileResult] = await Promise.all([
    getOpenSession(ctx),
    ctx.supabase
      .from('profiles')
      .select('preferred_heat_scale, cooking_skill_level')
      .eq('id', ctx.userId)
      .maybeSingle(),
  ]);

  const instructions = buildSystemPrompt({
    profile: profileResult.data as Pick<
      Profile,
      'preferred_heat_scale' | 'cooking_skill_level'
    > | null,
    session,
    today: new Date().toISOString().slice(0, 10),
    mode: 'voice',
  });

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'openai-safety-identifier': userId,
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        instructions,
        tools: realtimeToolDefinitions(),
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'ja' },
          },
          output: { voice: 'marin' },
        },
      },
    }),
  });

  const body = await response.json();

  if (!response.ok) {
    console.error('[realtime] client_secrets failed:', response.status, JSON.stringify(body).slice(0, 300));
    return NextResponse.json(
      { error: 'session_mint_failed', message: body?.error?.message ?? `status ${response.status}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    client_secret: body.value,
    expires_at: body.expires_at ?? null,
    model: REALTIME_MODEL,
    cooking_session_id: session?.id ?? null,
  });
}
