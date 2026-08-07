import { describe, expect, it } from 'vitest';

import { redactStaleReads, type StoredMessage } from './service';

/**
 * PHASE 4 — an inventory reading is true at a moment, not forever.
 *
 * Found by testing: after 砂糖 was added, the assistant kept reporting it
 * missing because a `not_found` from two turns earlier was still being
 * replayed as though it were current.
 */

let seq = 0;

function assistantCall(name: string, callId: string): StoredMessage {
  return {
    id: `a-${(seq += 1)}`,
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: callId, type: 'function', function: { name, arguments: '{}' } },
    ] as StoredMessage['tool_calls'],
    tool_call_id: null,
    created_at: '2026-08-08T00:00:00Z',
  };
}

function toolResult(callId: string, content: string): StoredMessage {
  return {
    id: `t-${(seq += 1)}`,
    role: 'tool',
    content,
    tool_calls: null,
    tool_call_id: callId,
    created_at: '2026-08-08T00:00:00Z',
  };
}

const contentFor = (rows: StoredMessage[], callId: string) =>
  rows.find((row) => row.role === 'tool' && row.tool_call_id === callId)?.content;

describe('redactStaleReads', () => {
  it('blanks an old inventory listing', () => {
    const rows = redactStaleReads([
      assistantCall('get_inventory', 'c1'),
      toolResult('c1', '{"items":[{"name":"卵"}]}'),
    ]);

    expect(contentFor(rows, 'c1')).not.toContain('卵');
    expect(contentFor(rows, 'c1')).toContain('システムプロンプト');
  });

  it('blanks a stale not_found, which is what caused the wrong answer', () => {
    const rows = redactStaleReads([
      assistantCall('find_inventory_item', 'c1'),
      toolResult('c1', '{"results":[{"name":"砂糖","status":"not_found"}]}'),
    ]);

    expect(contentFor(rows, 'c1')).not.toContain('not_found');
  });

  it('blanks an old meal-candidate evaluation', () => {
    const rows = redactStaleReads([
      assistantCall('search_meal_candidates', 'c1'),
      toolResult('c1', '{"evaluated_candidates":[]}'),
    ]);

    expect(contentFor(rows, 'c1')).toContain('過去の時点');
  });

  // Records of what happened do not expire — only readings do.
  it('keeps a created recipe id', () => {
    const rows = redactStaleReads([
      assistantCall('create_recipe', 'c1'),
      toolResult('c1', '{"recipe_id":"abc","total_steps":8}'),
    ]);

    expect(contentFor(rows, 'c1')).toContain('abc');
  });

  it('keeps a cooking session id and an inventory mutation result', () => {
    const rows = redactStaleReads([
      assistantCall('start_cooking_session', 'c1'),
      toolResult('c1', '{"session_id":"s1"}'),
      assistantCall('consume_inventory_item', 'c2'),
      toolResult('c2', '{"status":"applied","item":{"quantity":4}}'),
    ]);

    expect(contentFor(rows, 'c1')).toContain('s1');
    expect(contentFor(rows, 'c2')).toContain('applied');
  });

  it('redacts only the reading when a turn mixes both', () => {
    const rows = redactStaleReads([
      assistantCall('get_inventory', 'c1'),
      toolResult('c1', '{"items":[]}'),
      assistantCall('create_recipe', 'c2'),
      toolResult('c2', '{"recipe_id":"keep-me"}'),
    ]);

    expect(contentFor(rows, 'c1')).toContain('過去の時点');
    expect(contentFor(rows, 'c2')).toContain('keep-me');
  });

  it('leaves user and assistant text untouched', () => {
    const original: StoredMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '卵ある？',
        tool_calls: null,
        tool_call_id: null,
        created_at: '2026-08-08T00:00:00Z',
      },
    ];

    expect(redactStaleReads(original)).toEqual(original);
  });

  it('keeps the message structure so the tool protocol stays valid', () => {
    const input = [assistantCall('get_inventory', 'c1'), toolResult('c1', '{}')];
    const rows = redactStaleReads(input);

    expect(rows).toHaveLength(2);
    expect(rows[0].tool_calls).toHaveLength(1);
    expect(rows[1].tool_call_id).toBe('c1');
  });
});
