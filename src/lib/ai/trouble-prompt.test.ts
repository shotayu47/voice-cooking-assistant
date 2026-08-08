import { describe, expect, it } from 'vitest';

import { TROUBLE_PLAYBOOK } from '@/lib/cooking/trouble';
import type { CookingSession } from '@/types/domain';

import { buildSystemPrompt } from './prompt';

const base = {
  profile: null,
  session: null,
  today: '2026-08-08',
};

const session = {
  id: 'session-1',
  user_id: 'user-1',
  recipe_id: 'recipe-1',
  recipe_snapshot: {
    title: '鶏の照り焼き',
    steps: [{ instruction: '鶏肉を一口大に切る' }],
  },
  current_step: 0,
  total_steps: 1,
  status: 'active',
  started_at: null,
  completed_at: null,
  created_at: '2026-08-08T00:00:00Z',
  updated_at: '2026-08-08T00:00:00Z',
} as unknown as CookingSession;

describe('trouble handling in the system prompt', () => {
  it('is absent when nothing is cooking', () => {
    // Nothing can go wrong on the stove during an inventory turn, and the
    // playbook is long enough that carrying it everywhere is real cost.
    const prompt = buildSystemPrompt(base);
    expect(prompt).not.toContain('【トラブル対応表】');
    expect(prompt).not.toContain('【調理中のトラブル対応】');
  });

  it('is present once a cooking session is open', () => {
    const prompt = buildSystemPrompt({ ...base, session });
    expect(prompt).toContain('【調理中のトラブル対応】');
    expect(prompt).toContain('【トラブル対応表】');
  });

  it('carries every playbook entry into the prompt', () => {
    const prompt = buildSystemPrompt({ ...base, session });
    for (const play of TROUBLE_PLAYBOOK) {
      expect(prompt, play.id).toContain(play.label);
    }
  });

  it('forbids advancing the step while recovering', () => {
    // A trouble report is not progress. Advancing here would lose the step the
    // user still has to redo.
    const prompt = buildSystemPrompt({ ...base, session });
    expect(prompt).toContain('advance_cooking_step を呼ばないでください');
  });

  it('puts the immediate action ahead of the explanation', () => {
    const prompt = buildSystemPrompt({ ...base, session });
    expect(prompt).toContain('最初の1文は必ず「今すぐやる動作」');
  });

  it('reaches voice mode too, where the reply is even shorter', () => {
    const prompt = buildSystemPrompt({ ...base, session, mode: 'voice' });
    expect(prompt).toContain('【トラブル対応表】');
    expect(prompt).toContain('【音声応答スタイル】');
  });
});
