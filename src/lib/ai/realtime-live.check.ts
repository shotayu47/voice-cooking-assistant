import { describe, expect, it } from 'vitest';

import { realtimeToolDefinitions } from './tools';

/**
 * Live check (not part of `npm test`): confirms the Realtime API accepts every
 * tool definition verbatim rather than silently dropping any.
 * Run with: npx vitest run --config vitest.live.config.mts
 */
describe('realtime session accepts the real tool set', () => {
  it('echoes back all 11 tools', async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    expect(apiKey, 'OPENAI_API_KEY must be set').toBeTruthy();

    const tools = realtimeToolDefinitions();

    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
          instructions: 'live check',
          tools,
        },
      }),
    });

    const body = await response.json();
    expect(response.status, JSON.stringify(body).slice(0, 400)).toBe(200);

    const echoed = (body.session?.tools ?? []) as Array<{ name: string }>;
    expect(echoed.map((tool) => tool.name).sort()).toEqual(
      tools.map((tool) => tool.name).sort(),
    );
  }, 30_000);
});
