import { describe, expect, it } from 'vitest';

import { createFakeSupabase, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';

import { executeTool, realtimeToolDefinitions, TOOL_DEFINITIONS } from './tools';

/**
 * PHASE 10.3b2-R: the independent tool that writes only the candidates the
 * caller names in `selected`, via the existing strict parser and the
 * PHASE 10.2 write boundary. No derivation from `MissingIngredient[]`, no
 * automatic call from `search_meal_candidates`.
 */

const USER_ID = 'user-1';

function setup(): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({ shopping_items: [] });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

function rows(tables: Tables) {
  return tables.shopping_items ?? [];
}

const call = (ctx: ServiceContext, args: unknown) =>
  executeTool(ctx, 'add_selected_shopping_candidates', JSON.stringify(args));

const definition = TOOL_DEFINITIONS.find(
  (entry) => entry.type === 'function' && entry.function.name === 'add_selected_shopping_candidates',
);

describe('add_selected_shopping_candidates — definition', () => {
  it('exists exactly once', () => {
    const matches = TOOL_DEFINITIONS.filter(
      (entry) =>
        entry.type === 'function' && entry.function.name === 'add_selected_shopping_candidates',
    );
    expect(matches).toHaveLength(1);
  });

  it('requires selected as a strict array of name/reason/is_staple', () => {
    expect(definition?.type).toBe('function');
    if (definition?.type !== 'function') return;

    const params = definition.function.parameters as {
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
    expect(itemSchema.required).toEqual(['name', 'reason', 'is_staple']);
    expect(itemSchema.additionalProperties).toBe(false);
    expect(itemSchema.properties.reason.enum).toEqual(['absent', 'out_of_stock', 'expired']);
  });

  it('instructs not calling the tool on zero selection, matching the shared prompt contract, in both text and Realtime definitions', () => {
    expect(definition?.type).toBe('function');
    if (definition?.type !== 'function') return;

    const realtimeDescription = realtimeToolDefinitions().find(
      (tool) => tool.name === 'add_selected_shopping_candidates',
    )?.description;

    for (const description of [definition.function.description, realtimeDescription]) {
      expect(description).toContain('1件も選ばれていない場合はこのツールを呼ばないこと');
      expect(description).not.toContain('空配列にして呼ぶ');
    }
  });
});

describe('add_selected_shopping_candidates — execution', () => {
  it('selected: [] is a successful no-op with zero shopping rows', async () => {
    const { ctx, tables } = setup();

    const { result, effect } = await call(ctx, { selected: [] });

    expect(result).toEqual({ added: [] });
    expect(effect).toBeUndefined();
    expect(rows(tables)).toHaveLength(0);
  });

  it('writes only the candidates present in selected', async () => {
    const { ctx, tables } = setup();

    const { result, effect } = await call(ctx, {
      selected: [
        { name: '卵', reason: 'absent', is_staple: false },
        { name: '醤油', reason: 'out_of_stock', is_staple: true },
      ],
    });

    expect(rows(tables).map((r) => r.name)).toEqual(['卵', '醤油']);
    expect((result as { added: unknown[] }).added).toHaveLength(2);
    expect(effect).toBe('shopping_changed');
  });

  it('retains candidate fields, public item, and public duplicates on each entry', async () => {
    const { ctx } = setup();

    const { result } = await call(ctx, {
      selected: [{ name: '卵', reason: 'absent', is_staple: false }],
    });

    const [entry] = (
      result as {
        added: Array<{
          name: string;
          reason: string;
          reason_label: string;
          is_staple: boolean;
          item: { id: string; name: string };
          duplicates: unknown[];
        }>;
      }
    ).added;

    expect(entry).toMatchObject({
      name: '卵',
      reason: 'absent',
      reason_label: expect.any(String),
      is_staple: false,
      duplicates: [],
    });
    expect(entry.item).toMatchObject({ id: expect.any(String), name: '卵' });
  });

  it('reports duplicates against an existing unpurchased line', async () => {
    const { ctx } = setup();
    await call(ctx, { selected: [{ name: 'たまご', reason: 'absent', is_staple: false }] });

    const { result } = await call(ctx, {
      selected: [{ name: '卵', reason: 'absent', is_staple: false }],
    });

    const [entry] = (result as { added: Array<{ duplicates: unknown[] }> }).added;
    expect(entry.duplicates).toHaveLength(1);
  });

  it('rejects a blank name and writes nothing', async () => {
    const { ctx, tables } = setup();

    const { result } = await call(ctx, {
      selected: [{ name: '   ', reason: 'absent', is_staple: false }],
    });

    expect((result as { error: string }).error).toBe('invalid_arguments');
    expect(rows(tables)).toHaveLength(0);
  });

  it('rejects an invalid reason and writes nothing', async () => {
    const { ctx, tables } = setup();

    const { result } = await call(ctx, {
      selected: [{ name: '卵', reason: 'because_i_said_so', is_staple: false }],
    });

    expect((result as { error: string }).error).toBe('invalid_arguments');
    expect(rows(tables)).toHaveLength(0);
  });

  it('rejects an extra key on a candidate and writes nothing', async () => {
    const { ctx, tables } = setup();

    const { result } = await call(ctx, {
      selected: [{ name: '卵', reason: 'absent', is_staple: false, extra: 'nope' }],
    });

    expect((result as { error: string }).error).toBe('invalid_arguments');
    expect(rows(tables)).toHaveLength(0);
  });

  it('rejects a non-array selected and writes nothing', async () => {
    const { ctx, tables } = setup();

    const { result } = await call(ctx, { selected: 'not an array' });

    expect((result as { error: string }).error).toBe('invalid_arguments');
    expect(rows(tables)).toHaveLength(0);
  });
});

describe('shared text/Realtime definitions (SPEC §21.1)', () => {
  it('are identical, total 14, and include the new tool', () => {
    const realtime = realtimeToolDefinitions();
    const textNames = TOOL_DEFINITIONS.flatMap((tool) =>
      tool.type === 'function' ? [tool.function.name] : [],
    );

    expect(textNames).toHaveLength(14);
    expect(realtime.map((tool) => tool.name)).toEqual(textNames);
    expect(textNames).toContain('add_selected_shopping_candidates');
  });
});
