import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How a voice turn is allowed to end.
 *
 * Left unset, `turn_detection` resolves server-side to `server_vad` with
 * `silence_duration_ms: 200` — measured against `gpt-realtime` by minting a
 * client secret and reading the session back, not taken from the docs, which
 * say 500. Either way it is a stopwatch on silence, and 200ms is shorter than
 * the pause someone takes mid-sentence while deciding what they want. Turns
 * ended early and the model answered half a request.
 *
 * These pin what the app asks for. The resolved value is recorded in
 * `docs/phase10-ai-shopping-suggestions.md` §14.6.
 */

const getServiceContext = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  getServiceContext,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/cooking/service', () => ({ getOpenSession: vi.fn(async () => null) }));
vi.mock('@/lib/inventory/service', () => ({ listInventory: vi.fn(async () => []) }));

/** Just enough of the profile query the session route makes. */
function fakeSupabase() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: null }),
  };
  return { from: () => chain };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  process.env.OPENAI_API_KEY = 'sk-test';
  getServiceContext.mockResolvedValue({
    ctx: { supabase: fakeSupabase(), userId: 'user-1' },
    user: { userId: 'user-1' },
  });
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ value: 'ek_test', expires_at: 1 }),
  });
});

async function sentSession() {
  const { POST } = await import('./session/route');
  await POST();
  return JSON.parse(fetchMock.mock.calls[0][1].body).session;
}

describe('POST /api/realtime/session — how a turn ends', () => {
  it('asks for semantic turn detection rather than a silence stopwatch', async () => {
    const session = await sentSession();

    expect(session.audio.input.turn_detection.type).toBe('semantic_vad');
  });

  it('uses the least eager setting, so a pause is not treated as an ending', async () => {
    const session = await sentSession();

    expect(session.audio.input.turn_detection.eagerness).toBe('low');
  });

  it('keeps the call conversational — the model still answers on its own', async () => {
    // The panel is a continuous call ("タップで終了" ends the session, not the
    // utterance). Turning create_response off would be the one-shot design,
    // and would leave every utterance unanswered until something committed it.
    const session = await sentSession();

    expect(session.audio.input.turn_detection.create_response).toBe(true);
    expect(session.audio.input.turn_detection.interrupt_response).toBe(true);
  });

  it('never sends a silence_duration_ms, which semantic_vad does not use', async () => {
    const session = await sentSession();

    expect(session.audio.input.turn_detection.silence_duration_ms).toBeUndefined();
  });

  it('leaves transcription in place while changing turn detection', async () => {
    const session = await sentSession();

    expect(session.audio.input.transcription.language).toBe('ja');
  });

  it('still exposes all 15 tools to voice', async () => {
    const session = await sentSession();

    expect(session.tools).toHaveLength(15);
    expect(session.tools.map((t: { name: string }) => t.name)).toContain('suggest_shopping_items');
  });
});
