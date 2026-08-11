import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShoppingSuggestion } from '@/lib/shopping/suggest';
import type { ToolOutcome } from '@/lib/ai/tools';

/**
 * The two Realtime routes, at the contract the browser actually depends on.
 *
 * Voice QA 9 failed here and nowhere else: `suggest_shopping_items` ran, the
 * ledger stored its candidates, and this route serialised a response without
 * them — so the card had nothing to draw. There was no test on the shape of
 * this response, which is why a missing field was invisible.
 */

const getServiceContext = vi.fn();
const runOnce = vi.fn();
const executeTool = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  getServiceContext,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/ai/idempotency', () => ({ runOnce }));
vi.mock('@/lib/ai/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tools')>();
  return { ...actual, executeTool };
});
vi.mock('@/lib/cooking/service', () => ({ getOpenSession: vi.fn(async () => null) }));
vi.mock('@/lib/inventory/service', () => ({ listInventory: vi.fn(async () => []) }));

function suggestion(name: string): ShoppingSuggestion {
  return {
    name,
    reason: 'absent',
    reasonLabel: '在庫にない',
    quantity: 2,
    unit: '個',
    isStaple: false,
    alreadyOnList: false,
    sourceRecipes: [{ recipeId: 'r1', title: '肉じゃが' }],
  };
}

function toolRequest(name = 'suggest_shopping_items') {
  return new Request('http://localhost/api/realtime/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: '{}', call_id: 'call_QX77ghwDvzWrJyA8' }),
  });
}

/** What `runOnce` hands back for a given tool outcome. */
function stored(value: ToolOutcome, duplicate = false) {
  runOnce.mockResolvedValue({ value, duplicate, stored: true });
}

/** Just enough of the profile query the session route makes. */
function fakeSupabase() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: null }),
  };
  return { from: () => chain };
}

beforeEach(() => {
  vi.clearAllMocks();
  getServiceContext.mockResolvedValue({
    ctx: { supabase: fakeSupabase(), userId: 'user-1' },
    user: { userId: 'user-1' },
  });
});

describe('POST /api/realtime/tool — the card transport', () => {
  it('returns the structured candidates to the browser', async () => {
    const { POST } = await import('./tool/route');
    stored({
      result: { added: false, note: 'まだ何も追加していません。' },
      suggestions: [suggestion('じゃがいも'), suggestion('にんじん')],
    });

    const body = await (await POST(toolRequest())).json();

    // The exact regression: this field was absent entirely.
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions[0].name).toBe('じゃがいも');
  });

  it('sends them as plain JSON the client can use as-is', async () => {
    const { POST } = await import('./tool/route');
    stored({ result: {}, suggestions: [suggestion('だし汁')] });

    const body = await (await POST(toolRequest())).json();

    expect(body.suggestions[0]).toEqual({
      name: 'だし汁',
      reason: 'absent',
      reasonLabel: '在庫にない',
      quantity: 2,
      unit: '個',
      isStaple: false,
      alreadyOnList: false,
      sourceRecipes: [{ recipeId: 'r1', title: '肉じゃが' }],
    });
  });

  it('sends null when the tool produced no candidates', async () => {
    const { POST } = await import('./tool/route');
    stored({ result: { ok: true } });

    const body = await (await POST(toolRequest('get_inventory'))).json();

    expect(body.suggestions).toBeNull();
  });

  it('still sends candidates on a replayed call, unlike effect', async () => {
    // `effect` fires an action and must not fire twice; candidates are data
    // the card redraws, and the client keys them by call id.
    const { POST } = await import('./tool/route');
    stored({ result: {}, suggestions: [suggestion('じゃがいも')], effect: 'inventory_changed' }, true);

    const body = await (await POST(toolRequest())).json();

    expect(body.duplicate).toBe(true);
    expect(body.effect).toBeNull();
    expect(body.suggestions).toHaveLength(1);
  });

  it('does not write anything itself — the card is how items get added', async () => {
    const { POST } = await import('./tool/route');
    stored({ result: { added: false }, suggestions: [suggestion('じゃがいも')] });

    const body = await (await POST(toolRequest())).json();

    // `added: false` is the tool's own statement that nothing was written.
    expect(body.result.added).toBe(false);
    // Only one tool ran; no add_suggested_shopping_items anywhere near it.
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce.mock.calls[0][2]).toBe('suggest_shopping_items');
  });
});

