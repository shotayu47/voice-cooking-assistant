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
    expect(realtime).toHaveLength(13);
    expect(realtime.map((tool) => tool.name)).toContain('find_inventory_item');
    // PHASE 3 — voice must be able to check a proposal against the inventory
    // too, or the spoken answer and the typed answer disagree.
    expect(realtime.map((tool) => tool.name)).toContain('evaluate_meal_candidates');
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
