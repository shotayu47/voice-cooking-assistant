import { describe, expect, it } from 'vitest';

import { selectExecutableCalls, type RealtimeFunctionCall } from './select-calls';

function call(name: string, callId: string, args = '{}'): RealtimeFunctionCall {
  return { type: 'function_call', name, call_id: callId, arguments: args };
}

describe('selectExecutableCalls', () => {
  it('passes through a normal single call', () => {
    const selected = selectExecutableCalls([call('get_inventory', 'c1')], new Set());
    expect(selected).toEqual([{ name: 'get_inventory', callId: 'c1', arguments: '{}' }]);
  });

  it('ignores a call_id that was already relayed', () => {
    const selected = selectExecutableCalls(
      [call('consume_inventory_item', 'c1')],
      new Set(['c1']),
    );
    expect(selected).toEqual([]);
  });

  it('runs the same call_id only once when it is listed twice in one turn', () => {
    const selected = selectExecutableCalls(
      [call('consume_inventory_item', 'c1'), call('consume_inventory_item', 'c1')],
      new Set(),
    );
    expect(selected).toHaveLength(1);
  });

  // The behaviour the audit is about: 「次」 must never skip two steps.
  it('allows at most one step move per turn', () => {
    const selected = selectExecutableCalls(
      [call('advance_cooking_step', 'c1'), call('advance_cooking_step', 'c2')],
      new Set(),
    );

    expect(selected).toEqual([
      { name: 'advance_cooking_step', callId: 'c1', arguments: '{}' },
    ]);
  });

  it('counts forward and backward moves against the same budget', () => {
    const selected = selectExecutableCalls(
      [call('advance_cooking_step', 'c1'), call('previous_cooking_step', 'c2')],
      new Set(),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].name).toBe('advance_cooking_step');
  });

  it('does not let the step cap block other tools in the same turn', () => {
    const selected = selectExecutableCalls(
      [
        call('advance_cooking_step', 'c1'),
        call('advance_cooking_step', 'c2'),
        call('get_inventory', 'c3'),
      ],
      new Set(),
    );

    expect(selected.map((item) => item.name)).toEqual([
      'advance_cooking_step',
      'get_inventory',
    ]);
  });

  it('permits distinct inventory mutations in one turn', () => {
    // 「玉ねぎ使い切って、卵2個使った」 is legitimately two changes.
    const selected = selectExecutableCalls(
      [
        call('consume_inventory_item', 'c1', '{"item_id":"onion","consume_all":true}'),
        call('consume_inventory_item', 'c2', '{"item_id":"egg","amount":2}'),
      ],
      new Set(),
    );
    expect(selected).toHaveLength(2);
  });

  it('skips non-function output and malformed entries', () => {
    const selected = selectExecutableCalls(
      [
        { type: 'message', name: 'nope', call_id: 'c0' },
        { type: 'function_call', call_id: 'c1' },
        { type: 'function_call', name: 'get_inventory' },
        call('get_inventory', 'c2'),
      ],
      new Set(),
    );
    expect(selected).toEqual([{ name: 'get_inventory', callId: 'c2', arguments: '{}' }]);
  });

  it('handles an empty or missing output list', () => {
    expect(selectExecutableCalls([], new Set())).toEqual([]);
    expect(selectExecutableCalls(undefined, new Set())).toEqual([]);
  });
});
