import { describe, expect, it } from 'vitest';

import {
  findTroublePlay,
  renderTroublePlaybook,
  safetyCriticalPlays,
  TROUBLE_PLAYBOOK,
} from './trouble';

describe('TROUBLE_PLAYBOOK', () => {
  it('has a unique id per entry', () => {
    const ids = TROUBLE_PLAYBOOK.map((play) => play.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every entry something to do right now', () => {
    // The immediate action is the one field the reply must lead with, so an
    // empty one would produce advice that starts with an explanation.
    for (const play of TROUBLE_PLAYBOOK) {
      expect(play.immediate.trim(), play.id).not.toBe('');
      expect(play.cues.length, play.id).toBeGreaterThan(0);
      expect(play.avoid.length, play.id).toBeGreaterThan(0);
    }
  });

  it('tells the user to cut the heat first for the thermal failures', () => {
    for (const id of ['burning', 'oil-smoking', 'overcooked']) {
      const play = findTroublePlay(id);
      expect(play, id).not.toBeNull();
      expect(play!.immediate, id).toMatch(/火(を止|から下|を弱)/);
    }
  });

  it('resolves an unknown id to null rather than a default entry', () => {
    // Falling back to some other entry would answer a trouble we were not
    // asked about, with confident-sounding recovery steps.
    expect(findTroublePlay('nope')).toBeNull();
  });
});

describe('safety rules', () => {
  it('marks undercooked food and oil fires as safety critical', () => {
    const ids = safetyCriticalPlays().map((play) => play.id);
    expect(ids).toContain('undercooked');
    expect(ids).toContain('oil-smoking');
  });

  it('never resolves an oil fire with water', () => {
    const play = findTroublePlay('oil-smoking');
    expect(play!.safety).toContain('水をかけない');
    expect(play!.avoid.join(' ')).toContain('水を入れる');
  });

  it('refuses to let undercooked meat be judged by appearance', () => {
    const play = findTroublePlay('undercooked');
    expect(play!.safety).toContain('見た目だけ');
    expect(play!.reversibility).toBe('recoverable');
  });
});

describe('renderTroublePlaybook', () => {
  const rendered = renderTroublePlaybook();

  it('includes every entry', () => {
    for (const play of TROUBLE_PLAYBOOK) {
      expect(rendered, play.id).toContain(play.label);
      expect(rendered, play.id).toContain(play.immediate);
    }
  });

  it('carries the safety text through verbatim', () => {
    for (const play of safetyCriticalPlays()) {
      expect(rendered, play.id).toContain(play.safety!);
    }
    expect(rendered).toContain('安全（最優先・例外なし）');
  });

  it('states plainly when something cannot be undone', () => {
    expect(rendered).toContain('元に戻せない');
    expect(rendered).toContain('一部だけ救える');
  });
});
