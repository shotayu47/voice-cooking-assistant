import { describe, expect, it } from 'vitest';

import type { CookingSession } from '@/types/domain';

import { buildSystemPrompt } from './prompt';
import { realtimeToolDefinitions, TOOL_DEFINITIONS } from './tools';

const base = {
  profile: null,
  session: null,
  today: '2026-08-08',
};

function sessionWith(recipeSnapshot: Record<string, unknown>): CookingSession {
  return {
    id: 'session-1',
    user_id: 'user-1',
    recipe_id: 'recipe-1',
    recipe_snapshot: recipeSnapshot,
    current_step: 0,
    total_steps: 1,
    status: 'active',
    started_at: null,
    completed_at: null,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
  } as unknown as CookingSession;
}

const session = sessionWith({
  title: '鶏の照り焼き',
  servings: 2,
  ingredients: [{ name: '鶏もも肉', amount: 300, unit: 'g', required: true }],
  steps: [{ index: 0, instruction: '鶏肉を一口大に切る' }],
});

describe('amount rules in the system prompt', () => {
  it('are present even when nothing is cooking', () => {
    // Amounts are decided while writing the recipe too, not only at the stove.
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('【分量】');
    expect(prompt).toContain('adjust_recipe_amounts');
  });

  it('sends the arithmetic to the tool', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('分量を変える計算を自分でしないでください');
  });

  it('refuses to scale time or heat with the ingredients', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('加熱時間と火力は自動で倍率変更しません');
    expect(prompt).toContain('「2倍だから2倍の時間」とは言わないでください');
  });

  it('forbids stating a maximum that was not fully verified', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('capacity_status が exact でないときは');
    expect(prompt).toContain('unverified_constraints');
  });

  it('keeps 適量 and fractional amounts as they are', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('「適量」「少々」を数値に変えないでください');
    expect(prompt).toContain('勝手に2個に丸めず');
  });

  it('adds the mid-cook rules only once something is cooking', () => {
    expect(buildSystemPrompt(base)).not.toContain('【調理中に分量を変えられたら】');

    const prompt = buildSystemPrompt({ ...base, session });
    expect(prompt).toContain('【調理中に分量を変えられたら】');
    expect(prompt).toContain('already_added');
    expect(prompt).toContain('あと◯◯」という差分で伝えてください');
  });

  it('states the servings the session is actually cooking', () => {
    expect(buildSystemPrompt({ ...base, session })).toContain('分量: 2人分');

    const adjusted = sessionWith({
      title: '鶏の照り焼き',
      servings: 2,
      scaling: { baseServings: 2, targetServings: 4 },
      ingredients: [{ name: '鶏もも肉', amount: 300, unit: 'g', required: true }],
      steps: [{ index: 0, instruction: '鶏肉を一口大に切る' }],
    });
    expect(buildSystemPrompt({ ...base, session: adjusted })).toContain(
      '分量: 4人分（レシピの基準は2人分。調整済み）',
    );
  });

  it('reads a pre-PHASE 8 snapshot without scaling metadata', () => {
    // Every session started before this phase looks like this.
    const legacy = sessionWith({
      title: '肉じゃが',
      servings: 3,
      ingredients: [],
      steps: [{ index: 0, instruction: '切る' }],
    });
    expect(buildSystemPrompt({ ...base, session: legacy })).toContain('分量: 3人分');
  });

  it('reaches voice mode, where doing mental arithmetic aloud is worst', () => {
    const prompt = buildSystemPrompt({ ...base, session, mode: 'voice' });
    expect(prompt).toContain('【分量】');
    expect(prompt).toContain('【調理中に分量を変えられたら】');
  });
});

describe('adjust_recipe_amounts tool definition', () => {
  const tool = TOOL_DEFINITIONS.find(
    (entry) => entry.type === 'function' && entry.function.name === 'adjust_recipe_amounts',
  );

  it('exists', () => {
    expect(tool).toBeDefined();
  });

  it('makes the two uses explicit rather than overloading a null', () => {
    // A null target_servings meaning "tell me the maximum" is exactly the kind
    // of implicit contract a model gets wrong.
    const parameters = tool?.type === 'function' ? tool.function.parameters : undefined;
    const properties = (parameters as { properties?: Record<string, { enum?: string[] }> })
      ?.properties;

    expect(properties?.mode?.enum).toEqual(['scale', 'max_from_inventory']);
    expect((parameters as { required?: string[] })?.required).toContain('target_servings');
  });

  it('is offered to voice as well as text', () => {
    expect(realtimeToolDefinitions().map((entry) => entry.name)).toContain(
      'adjust_recipe_amounts',
    );
  });
});
