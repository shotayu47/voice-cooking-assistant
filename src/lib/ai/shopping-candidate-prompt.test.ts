import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from './prompt';
import * as promptModule from './prompt';

const base = {
  profile: null,
  session: null,
  today: '2026-08-08',
};

describe('shopping candidate rules in the system prompt', () => {
  it('states shopping_candidates are suggestions only and presenting them is not a write', () => {
    const prompt = buildSystemPrompt({ ...base, mode: 'text' });
    expect(prompt).toContain('shopping_candidates');
    expect(prompt).toContain('提案にすぎません');
    expect(prompt).toContain('何も書き込まれません');
  });

  it('forbids calling the add tool merely because missing ingredients/candidates exist', () => {
    const prompt = buildSystemPrompt({ ...base, mode: 'text' });
    expect(prompt).toContain(
      '不足食材や候補が存在するというだけの理由で add_selected_shopping_candidates を呼ばないでください',
    );
  });

  it('requires an explicit subset or an unambiguous "all" request, and a clarification question otherwise', () => {
    const prompt = buildSystemPrompt({ ...base, mode: 'text' });
    expect(prompt).toContain('候補の一部を明示的に選んだとき');
    expect(prompt).toContain('候補すべてを買うと明確に言ったとき');
    expect(prompt).toContain('確認の質問をしてください');
    expect(prompt).toContain('曖昧なまま書き込まないでください');
  });

  it('requires selected candidates to be a subset of the server-provided list with fields preserved verbatim', () => {
    const prompt = buildSystemPrompt({ ...base, mode: 'text' });
    expect(prompt).toContain('直前にサーバーが返した shopping_candidates の部分集合');
    expect(prompt).toContain('name・reason・is_staple はその候補にあった値をそのまま使い');
    expect(prompt).toContain('新しい候補をでっち上げたり');
  });

  it('forbids calling the add tool when zero candidates are selected', () => {
    const prompt = buildSystemPrompt({ ...base, mode: 'text' });
    expect(prompt).toContain(
      'ユーザーが選んだ候補が0件の場合は add_selected_shopping_candidates を呼ばないでください',
    );
  });

  it('requires the result to be described factually, including duplicates and errors', () => {
    const prompt = buildSystemPrompt({ ...base, mode: 'text' });
    expect(prompt).toContain('実際のツール結果で「追加された」と返った項目についてだけ「追加しました」と伝えてください');
    expect(prompt).toContain('duplicates が返った項目は重複として事実どおり説明してください');
    expect(prompt).toContain('成功したと言わないでください');
  });

  it('carries the same rules into voice mode alongside the existing voice-style rules', () => {
    const prompt = buildSystemPrompt({ ...base, mode: 'voice' });
    expect(prompt).toContain('提案にすぎません');
    expect(prompt).toContain('不足食材や候補が存在するというだけの理由で add_selected_shopping_candidates を呼ばないでください');
    expect(prompt).toContain('ユーザーが選んだ候補が0件の場合は add_selected_shopping_candidates を呼ばないでください');
    // Voice-only brevity rules from PHASE 21.4 must still be present.
    expect(prompt).toContain('【音声応答スタイル】');
    expect(prompt).toContain('1〜2文で答えてください');
  });

  it('is present even with no active cooking session and no mode set', () => {
    // Shopping candidates can surface on any meal-planning turn, not only
    // while a session is open — unlike TROUBLE_RULES this must not be gated.
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('【買い物候補の提案と追加】');
  });

  it('does not introduce an alternate prompt builder', () => {
    // Text and voice must resolve instructions through this single shared
    // path; no other exported builder should exist to diverge from it.
    const functionExports = Object.entries(promptModule).filter(
      ([, value]) => typeof value === 'function',
    );
    expect(functionExports).toEqual([['buildSystemPrompt', promptModule.buildSystemPrompt]]);
  });
});
