import { describe, expect, it } from 'vitest';

import type { ToolOutcome } from '@/lib/ai/tools';
import { serializeToolResponse } from './serialize-tool-response';

/**
 * PHASE 10.5b: pins the route rule `duplicate ? null : value.effect` so a
 * shopping-list write over Realtime is exposed exactly once per call_id.
 */
describe('serializeToolResponse', () => {
  it('serializes a first successful shopping_changed outcome with that effect', () => {
    const value: ToolOutcome = { result: { added: [{ name: '卵' }] }, effect: 'shopping_changed' };

    expect(serializeToolResponse(value, false)).toEqual({
      result: { added: [{ name: '卵' }] },
      effect: 'shopping_changed',
      session_id: null,
      duplicate: false,
    });
  });

  it('suppresses the effect on a replay of the same call_id while keeping the stored result', () => {
    const value: ToolOutcome = { result: { added: [{ name: '卵' }] }, effect: 'shopping_changed' };

    expect(serializeToolResponse(value, true)).toEqual({
      result: { added: [{ name: '卵' }] },
      effect: null,
      session_id: null,
      duplicate: true,
    });
  });

  it('serializes an outcome with no effect as effect: null, not a write', () => {
    const value: ToolOutcome = { result: { shopping_candidates: [{ name: '卵' }] } };

    expect(serializeToolResponse(value, false)).toEqual({
      result: { shopping_candidates: [{ name: '卵' }] },
      effect: null,
      session_id: null,
      duplicate: false,
    });
  });

  it('carries sessionId through to session_id when present', () => {
    const value: ToolOutcome = { result: { step: 1 }, effect: 'session_changed', sessionId: 's1' };

    expect(serializeToolResponse(value, false)).toMatchObject({
      effect: 'session_changed',
      session_id: 's1',
    });
  });
});
