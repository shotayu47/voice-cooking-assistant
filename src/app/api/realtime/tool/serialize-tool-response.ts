import type { ToolOutcome } from '@/lib/ai/tools';

export type ToolResponseBody = {
  result: unknown;
  effect: NonNullable<ToolOutcome['effect']> | null;
  session_id: string | null;
  duplicate: boolean;
};

/**
 * Pure serializer for the POST /api/realtime/tool response body.
 *
 * A replayed call_id must not re-trigger the UI refresh that its original
 * already caused, so a duplicate always serializes effect: null even though
 * the stored result (and its own effect, if any) is still returned.
 */
export function serializeToolResponse(value: ToolOutcome, duplicate: boolean): ToolResponseBody {
  return {
    result: value.result,
    effect: duplicate ? null : (value.effect ?? null),
    session_id: value.sessionId ?? null,
    duplicate,
  };
}
