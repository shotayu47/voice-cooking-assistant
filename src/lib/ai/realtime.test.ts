import { describe, expect, it } from 'vitest';

import { TOOL_DEFINITIONS, realtimeToolDefinitions } from './tools';
import { buildSystemPrompt } from './prompt';

describe('realtimeToolDefinitions', () => {
  const realtime = realtimeToolDefinitions();

  it('exposes exactly the same tools as text mode (SPEC §21.1)', () => {
    const textNames = TOOL_DEFINITIONS.flatMap((tool) =>
      tool.type === 'function' ? [tool.function.name] : [],
    );
    expect(realtime.map((tool) => tool.name)).toEqual(textNames);
  });

  it('uses the flat Realtime shape with identical parameters', () => {
    for (const [index, tool] of realtime.entries()) {
      const source = TOOL_DEFINITIONS[index];
      if (source.type !== 'function') continue;

      expect(tool.type).toBe('function');
      expect(tool.description).toBe(source.function.description ?? '');
      expect(tool.parameters).toEqual(source.function.parameters);
      // The flat shape must not carry the nested `function` wrapper.
      expect('function' in tool).toBe(false);
    }
  });

  it('covers the SPEC §8 tools plus the §14 name resolver', () => {
    // 12 through PHASE 7, plus adjust_recipe_amounts (PHASE 8) and
    // suggest_shopping_items (PHASE 10).
    expect(realtime).toHaveLength(15);
    expect(realtime.map((tool) => tool.name)).toContain('find_inventory_item');
  });

  it('keeps the shopping suggestion tool read-only in voice too', () => {
    // Parity with text mode is the SPEC §21.1 rule, so the tool is offered
    // here as well. That is safe because it writes nothing in either mode —
    // what voice cannot do is render the pickable card, so the candidates are
    // spoken and the user adds them from the shopping screen later.
    const suggest = realtime.find((tool) => tool.name === 'suggest_shopping_items');

    expect(suggest).toBeDefined();
    expect(suggest?.description).toContain('買い物リストに何も追加しない');
  });
});

describe('buildSystemPrompt voice mode', () => {
  const base = {
    profile: null,
    session: null,
    today: '2026-08-03',
  };

  it('appends the §21.4 brevity rules only in voice mode', () => {
    const voice = buildSystemPrompt({ ...base, mode: 'voice' });
    const text = buildSystemPrompt({ ...base, mode: 'text' });
    const unspecified = buildSystemPrompt(base);

    expect(voice).toContain('【音声応答スタイル】');
    expect(text).not.toContain('【音声応答スタイル】');
    expect(unspecified).not.toContain('【音声応答スタイル】');
  });

  it('keeps the core rules in both modes', () => {
    const voice = buildSystemPrompt({ ...base, mode: 'voice' });
    expect(voice).toContain('最重要原則');
    expect(voice).toContain('【ツールの使い方】');
  });
});
