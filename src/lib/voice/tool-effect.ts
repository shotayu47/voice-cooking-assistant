/**
 * Whether a /api/realtime/tool response should be forwarded to the caller's
 * onToolEffect callback.
 *
 * Pure so it can be tested without a peer connection or DOM.
 */

export type ToolEffect = {
  effect: 'inventory_changed' | 'session_changed' | 'shopping_changed' | null;
  sessionId: string | null;
};

export function resolveToolEffect(body: {
  effect: ToolEffect['effect'];
  session_id: string | null;
}): ToolEffect | null {
  if (!body.effect) return null;
  return { effect: body.effect, sessionId: body.session_id };
}
