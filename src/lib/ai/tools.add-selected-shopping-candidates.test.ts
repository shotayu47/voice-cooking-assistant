import { describe, expect, it } from 'vitest';

import { createFakeSupabase } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';

import { executeTool, TOOL_DEFINITIONS } from './tools';

/**
 * PHASE 10.3b2: `add_selected_shopping_candidates` is the only AI tool that
 * writes to `shopping_items`, and it writes exactly `args.selected` — nothing
 * derived from a MissingIngredient[], nothing auto-called from
 * search_meal_candidates.
 */

const USER_ID = 'user-1';

function setup(): { ctx: ServiceContext; tables: ReturnType<typeof createFakeSupabase>['tables'] } {
  const { client, tables } = createFakeSupabase({ shopping_items: [] });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

const call = (ctx: ServiceContext, args: Record<string, unknown>) =>
  executeTool(ctx, 'add_selected_shopping_candidates', JSON.stringify(args));

describe('add_selected_shopping_candidates tool definition', () => {
  it('is defined exactly once, with 14 tools total', () => {
    const matches = TOOL_DEFINITIONS.filter(
      (tool) => tool.type === 'function' && tool.function.name === 'add_selected_shopping_candidates',
    );
    expect(matches).toHaveLength(1);
    expect(TOOL_DEFINITIONS).toHaveLength(14);
  });

  it('requires selected as a strict array of name/reason/is_staple', () => {
    const tool = TOOL_DEFINITIONS.find(
      (entry) => entry.type === 'function' && entry.function.name === 'add_selected_shopping_candidates',
    );
    if (!tool || tool.type !== 'function') throw new Error('tool not found');

    const params = tool.function.parameters as {
      required: string[];
      additionalProperties: boolean;
      properties: {
        selected: {
          items: {
            required: string[];
            additionalProperties: boolean;
            properties: { reason: { enum: string[] } };
          };
        };
      };
    };

    expect(params.required).toEqual(['selected']);
    expect(params.additionalProperties).toBe(false);

    const itemSchema = params.properties.selected.items;
    expect(itemSchema.required.sort()).toEqual(['is_staple', 'name', 'reason'].sort());
    expect(itemSchema.additionalProperties).toBe(false);
    expect(itemSchema.properties.reason.enum).toEqual(['absent', 'out_of_stock', 'expired']);
  });
});

describe('add_selected_shopping_candidates execution', () => {
  it('selected: [] is a successful no-op with an empty added result and no shopping row', async () => {
    const { ctx, tables } = setup();

    const { result, effect } = await call(ctx, { selected: [] });

    expect(result).toEqual({ added: [] });
    expect(tables.shopping_items).toEqual([]);
    expect(effect).toBeUndefined();
  });

  it('writes only the candidates supplied in selected', async () => {
    const { ctx, tables } = setup();

    await call(ctx, {
      selected: [
        { name: '卵', reason: 'absent', is_staple: false },
        { name: '砂糖', reason: 'out_of_stock', is_staple: true },
      ],
    });

    expect(tables.shopping_items).toHaveLength(2);
    expect((tables.shopping_items as { name: string }[]).map((row) => row.name).sort()).toEqual(
      ['卵', '砂糖'].sort(),
    );
  });

  it('retains each candidate paired with its written item and duplicates', async () => {
    const { ctx } = setup();

    const { result } = await call(ctx, {
      selected: [{ name: '牛乳', reason: 'absent', is_staple: false }],
    });

    const added = (result as { added: Array<Record<string, unknown>> }).added;
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: '牛乳',
      reason: 'absent',
      is_staple: false,
      duplicates: [],
    });
    expect(added[0].item).toMatchObject({ name: '牛乳' });
  });

  it('detects and reports a duplicate already on the list without blocking the write', async () => {
    const { ctx } = setup();
    await call(ctx, { selected: [{ name: '卵', reason: 'absent', is_staple: false }] });

    const { result } = await call(ctx, {
      selected: [{ name: '卵', reason: 'absent', is_staple: false }],
    });

    const added = (result as { added: Array<{ duplicates: unknown[] }> }).added;
    expect(added[0].duplicates).toHaveLength(1);
  });

  it('rejects a blank name with invalid_arguments and writes nothing', async () => {
    const { ctx, tables } = setup();

    const { result } = await call(ctx, {
      selected: [{ name: '   ', reason: 'absent', is_staple: false }],
    });

    expect(result).toMatchObject({ error: 'invalid_arguments' });
    expect(tables.shopping_items).toEqual([]);
  });

  it('rejects an unknown reason with invalid_arguments and writes nothing', async () => {
    const { ctx, tables } = setup();

    const { result } = await call(ctx, {
      selected: [{ name: '卵', reason: 'because', is_staple: false }],
    });

    expect(result).toMatchObject({ error: 'invalid_arguments' });
    expect(tables.shopping_items).toEqual([]);
  });

  it('rejects an extra key with invalid_arguments and writes nothing', async () => {
    const { ctx, tables } = setup();

    const { result } = await call(ctx, {
      selected: [{ name: '卵', reason: 'absent', is_staple: false, extra: 'nope' }],
    });

    expect(result).toMatchObject({ error: 'invalid_arguments' });
    expect(tables.shopping_items).toEqual([]);
  });

  it('rejects a non-array selected with invalid_arguments and writes nothing', async () => {
    const { ctx, tables } = setup();

    const { result } = await call(ctx, { selected: 'not an array' });

    expect(result).toMatchObject({ error: 'invalid_arguments' });
    expect(tables.shopping_items).toEqual([]);
  });
});
