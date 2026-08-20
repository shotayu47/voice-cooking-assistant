import { describe, expect, it } from 'vitest';

import { resolveToolEffect } from './tool-effect';

describe('resolveToolEffect', () => {
  it('forwards a shopping_changed effect with sessionId: null', () => {
    expect(resolveToolEffect({ effect: 'shopping_changed', session_id: null })).toEqual({
      effect: 'shopping_changed',
      sessionId: null,
    });
  });

  it('forwards an inventory_changed effect', () => {
    expect(resolveToolEffect({ effect: 'inventory_changed', session_id: null })).toEqual({
      effect: 'inventory_changed',
      sessionId: null,
    });
  });

  it('forwards a session_changed effect together with its sessionId', () => {
    expect(resolveToolEffect({ effect: 'session_changed', session_id: 's1' })).toEqual({
      effect: 'session_changed',
      sessionId: 's1',
    });
  });

  it('returns null for a no-effect response', () => {
    expect(resolveToolEffect({ effect: null, session_id: null })).toBeNull();
  });
});
