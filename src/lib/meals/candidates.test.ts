import { describe, expect, it } from 'vitest';

import type { InventoryItem } from '@/types/domain';
import { normalizeIngredientName } from '@/lib/inventory/normalize';
import {
  cleanoutTargets,
  evaluateCandidate,
  evaluateCandidates,
  isSeasoning,
  pantryStatus,
  rankCandidates,
  summarize,
  type CandidateInput,
} from './candidates';

/**
 * PHASE 3 — 「今あるもので何作れる？」.
 *
 * The rule under test throughout: the model proposes, the server decides.
 * A dish is only 「作れる」 when every required ingredient resolves to a row
 * that is actually in stock and actually still safe to eat.
 */

const TODAY = '2026-08-10';

function item(name: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `id-${name}`,
    user_id: 'user',
    name,
    normalized_name: normalizeIngredientName(name),
    category: null,
    quantity: null,
    unit: null,
    quantity_state: 'available',
    storage_location: null,
    expiry_date: null,
    opened: false,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function dish(
  title: string,
  ingredients: CandidateInput['ingredients'],
  overrides: Partial<CandidateInput> = {},
): CandidateInput {
  return { title, ingredients, ...overrides };
}

function names(list: { name: string }[]): string[] {
  return list.map((entry) => entry.name);
}

describe('isSeasoning', () => {
  it('recognises the 基礎調味料 and their common variants', () => {
    expect(isSeasoning('醤油')).toBe(true);
    expect(isSeasoning('濃口醤油')).toBe(true);
    expect(isSeasoning('しょうゆ')).toBe(true);
    expect(isSeasoning('塩胡椒')).toBe(true);
    expect(isSeasoning('オイスターソース')).toBe(true);
  });

  it('does not swallow foods that merely contain a one-character staple', () => {
    // 「油」 and 「酢」 are single characters, so they only match exactly —
    // otherwise 油揚げ and 酢豚 would be treated as things you top up.
    expect(isSeasoning('油揚げ')).toBe(false);
    expect(isSeasoning('酢豚')).toBe(false);
    expect(isSeasoning('塩鮭')).toBe(false);
    expect(isSeasoning('鶏もも肉')).toBe(false);
  });

  it('trusts the inventory category when the name is unfamiliar', () => {
    expect(isSeasoning('自家製たれ')).toBe(false);
    expect(isSeasoning('自家製たれ', item('自家製たれ', { category: 'sauce' }))).toBe(true);
  });
});

describe('evaluateCandidate — classification', () => {
  const inventory = [
    item('鶏もも肉', { quantity: 300, unit: 'g' }),
    item('玉ねぎ', { quantity: 2, unit: '個' }),
    item('卵', { quantity: 4, unit: '個' }),
    item('醤油', { category: 'seasoning' }),
  ];

  it('reports ready when everything required is in stock', () => {
    const result = evaluateCandidate(
      dish('親子丼', [
        { name: '鶏もも肉', amount: 200, unit: 'g' },
        { name: '玉ねぎ', amount: 1, unit: '個' },
        { name: '卵', amount: 2, unit: '個' },
        { name: '醤油' },
      ]),
      inventory,
      TODAY,
    );

    expect(result.availability).toBe('ready');
    expect(result.missingRequired).toEqual([]);
    expect(names(result.have)).toEqual(['鶏もも肉', '玉ねぎ', '卵', '醤油']);
  });

  it('reports seasoning_only when the only gaps are pantry staples', () => {
    const result = evaluateCandidate(
      dish('照り焼きチキン', [
        { name: '鶏もも肉', amount: 200, unit: 'g' },
        { name: 'みりん' },
        { name: '砂糖' },
      ]),
      inventory,
      TODAY,
    );

    expect(result.availability).toBe('seasoning_only');
    expect(names(result.missingRequired)).toEqual(['みりん', '砂糖']);
    expect(result.missingRequired.every((missing) => missing.seasoning)).toBe(true);
  });

  it('reports one_short when a single real ingredient is missing', () => {
    const result = evaluateCandidate(
      dish('肉じゃが', [
        { name: '鶏もも肉', amount: 200, unit: 'g' },
        { name: '玉ねぎ', amount: 1, unit: '個' },
        { name: 'じゃが芋', amount: 2, unit: '個' },
      ]),
      inventory,
      TODAY,
    );

    expect(result.availability).toBe('one_short');
    expect(names(result.missingRequired)).toEqual(['じゃが芋']);
  });

  it('reports few_short at two or three gaps and not_feasible beyond that', () => {
    const few = evaluateCandidate(
      dish('カレー', [
        { name: '鶏もも肉' },
        { name: 'じゃが芋' },
        { name: '人参' },
      ]),
      inventory,
      TODAY,
    );
    expect(few.availability).toBe('few_short');

    const many = evaluateCandidate(
      dish('ポトフ', [
        { name: 'じゃが芋' },
        { name: '人参' },
        { name: 'キャベツ' },
        { name: 'ベーコン' },
      ]),
      inventory,
      TODAY,
    );
    expect(many.availability).toBe('not_feasible');
  });

  it('does not count optional ingredients against the verdict', () => {
    const result = evaluateCandidate(
      dish('卵かけご飯', [
        { name: '卵', amount: 1, unit: '個' },
        { name: '海苔', required: false },
      ]),
      inventory,
      TODAY,
    );

    expect(result.availability).toBe('ready');
    expect(names(result.missingOptional)).toEqual(['海苔']);
  });

  it('counts a repeated ingredient once', () => {
    // 「醤油」 listed for the marinade and again for the sauce must not turn
    // one shopping item into two.
    const result = evaluateCandidate(
      dish('唐揚げ', [
        { name: '鶏もも肉', amount: 200, unit: 'g' },
        { name: 'にんにく' },
        { name: 'ニンニク' },
      ]),
      inventory,
      TODAY,
    );

    expect(names(result.missingRequired)).toEqual(['にんにく']);
    expect(result.availability).toBe('one_short');
  });
});

describe('evaluateCandidate — what "missing" actually means', () => {
  it('distinguishes 在庫に無い from 切らしている', () => {
    const inventory = [item('醤油', { quantity: 0, quantity_state: 'empty' })];

    const result = evaluateCandidate(
      dish('煮物', [{ name: '醤油' }, { name: '大根' }]),
      inventory,
      TODAY,
    );

    expect(result.missingRequired).toMatchObject([
      { name: '醤油', reason: 'out_of_stock' },
      { name: '大根', reason: 'absent' },
    ]);
  });

  it('reports a shortfall when the same unit says there is not enough', () => {
    const inventory = [item('卵', { quantity: 1, unit: '個' })];

    const result = evaluateCandidate(
      dish('オムレツ', [{ name: '卵', amount: 3, unit: '個' }]),
      inventory,
      TODAY,
    );

    expect(result.missingRequired[0]).toMatchObject({
      name: '卵',
      reason: 'not_enough',
      short: { amount: 2, unit: '個' },
    });
  });

  it('does not invent a shortfall across mismatched or unknown units', () => {
    const mismatched = evaluateCandidate(
      dish('スープ', [{ name: '牛乳', amount: 200, unit: 'ml' }]),
      [item('牛乳', { quantity: 1, unit: '本' })],
      TODAY,
    );
    expect(mismatched.availability).toBe('ready');

    const unknown = evaluateCandidate(
      dish('スープ', [{ name: '牛乳', amount: 200, unit: 'ml' }]),
      [item('牛乳')],
      TODAY,
    );
    expect(unknown.availability).toBe('ready');
  });

  it('treats a passed 消費期限 as unusable rather than merely urgent', () => {
    const inventory = [
      item('鶏もも肉', {
        quantity: 300,
        unit: 'g',
        expiry_date: '2026-08-08',
        expiry_kind: 'use_by',
        expiry_source: 'user',
      }),
    ];

    const result = evaluateCandidate(dish('唐揚げ', [{ name: '鶏もも肉' }]), inventory, TODAY);

    expect(result.availability).toBe('one_short');
    expect(result.missingRequired[0]).toMatchObject({ name: '鶏もも肉', reason: 'unsafe' });
    expect(result.have).toEqual([]);
  });

  it('says so when the passed 消費期限 is only the app’s estimate', () => {
    const inventory = [
      item('鶏もも肉', {
        expiry_date: '2026-08-08',
        expiry_kind: 'use_by',
        expiry_source: 'estimated',
      }),
    ];

    const result = evaluateCandidate(dish('唐揚げ', [{ name: '鶏もも肉' }]), inventory, TODAY);

    expect(result.missingRequired[0].note).toContain('推定');
  });

  it('keeps a passed 賞味期限 usable but flags it for a look', () => {
    const inventory = [
      item('牛乳', {
        expiry_date: '2026-08-08',
        expiry_kind: 'best_before',
        expiry_source: 'user',
      }),
    ];

    const result = evaluateCandidate(dish('シチュー', [{ name: '牛乳' }]), inventory, TODAY);

    expect(result.availability).toBe('ready');
    expect(names(result.checkFirst.map((matched) => ({ name: matched.itemName })))).toEqual(['牛乳']);
  });
});

describe('evaluateCandidate — expiry priority', () => {
  it('lists the ingredients that are running out of time', () => {
    const inventory = [
      item('ほうれん草', {
        expiry_date: '2026-08-11',
        expiry_kind: 'best_before',
        expiry_source: 'estimated',
      }),
      item('玉ねぎ', { expiry_date: '2026-09-01', expiry_kind: 'best_before' }),
    ];

    const result = evaluateCandidate(
      dish('おひたし', [{ name: 'ほうれん草' }, { name: '玉ねぎ' }]),
      inventory,
      TODAY,
    );

    expect(result.usesExpiring).toHaveLength(1);
    expect(result.usesExpiring[0]).toMatchObject({
      itemName: 'ほうれん草',
      daysLeft: 1,
      urgency: '推定あと1日',
      estimated: true,
    });
  });

  it('prefers the most urgent row when a name matches several', () => {
    const inventory = [
      item('鶏もも肉', { expiry_date: '2026-08-20', expiry_kind: 'use_by' }),
      item('鶏むね肉', { expiry_date: '2026-08-11', expiry_kind: 'use_by' }),
    ];

    const result = evaluateCandidate(dish('チキンソテー', [{ name: '鶏肉' }]), inventory, TODAY);

    expect(result.have[0]).toMatchObject({ itemName: '鶏むね肉', ambiguous: true });
  });

  it('falls back to a safe row when the most urgent one is past its 消費期限', () => {
    const inventory = [
      item('鶏むね肉', {
        expiry_date: '2026-08-08',
        expiry_kind: 'use_by',
        expiry_source: 'user',
      }),
      item('鶏もも肉', { expiry_date: '2026-08-20', expiry_kind: 'use_by' }),
    ];

    const result = evaluateCandidate(dish('チキンソテー', [{ name: '鶏肉' }]), inventory, TODAY);

    expect(result.availability).toBe('ready');
    expect(result.have[0]).toMatchObject({ itemName: '鶏もも肉' });
  });
});

describe('rankCandidates', () => {
  const inventory = [
    item('鶏もも肉', { expiry_date: '2026-08-11', expiry_kind: 'use_by', expiry_source: 'user' }),
    item('卵', { quantity: 4, unit: '個' }),
    item('玉ねぎ', { quantity: 2, unit: '個' }),
  ];

  const proposals = [
    dish('目玉焼き', [{ name: '卵', amount: 1, unit: '個' }], { estimatedMinutes: 5 }),
    dish('チキンソテー', [{ name: '鶏もも肉' }], { estimatedMinutes: 20 }),
    dish('肉じゃが', [{ name: '鶏もも肉' }, { name: 'じゃが芋' }], { estimatedMinutes: 40 }),
  ];

  it('puts feasibility first in normal mode, expiry as the tie-break', () => {
    const ranked = evaluateCandidates(proposals, inventory, { mode: 'normal', today: TODAY });

    expect(ranked.map((candidate) => candidate.title)).toEqual([
      'チキンソテー', // ready, and rescues the chicken
      '目玉焼き', // ready, nothing urgent
      '肉じゃが', // one_short
    ]);
  });

  it('puts the rescue first in cleanout mode, even when something else is easier', () => {
    const ranked = evaluateCandidates(proposals, inventory, { mode: 'cleanout', today: TODAY });

    expect(ranked.map((candidate) => candidate.title)).toEqual([
      'チキンソテー',
      '肉じゃが', // uses the expiring chicken too, despite needing a shop
      '目玉焼き',
    ]);
  });

  it('is a total order: equal candidates fall back to time, then title', () => {
    const evaluated = evaluateCandidates(
      [
        dish('ゆで卵', [{ name: '卵' }], { estimatedMinutes: 12 }),
        dish('スクランブルエッグ', [{ name: '卵' }], { estimatedMinutes: 5 }),
        dish('温泉卵', [{ name: '卵' }], { estimatedMinutes: 12 }),
      ],
      inventory,
      { today: TODAY },
    );

    expect(evaluated.map((candidate) => candidate.title)).toEqual([
      'スクランブルエッグ',
      'ゆで卵',
      '温泉卵',
    ]);
    // Re-ranking an already-ranked list must not shuffle it.
    expect(rankCandidates(evaluated).map((candidate) => candidate.title)).toEqual(
      evaluated.map((candidate) => candidate.title),
    );
  });
});

describe('pantryStatus', () => {
  it('separates the 基礎調味料 on hand from the ones to buy', () => {
    const status = pantryStatus(
      [
        item('醤油', { category: 'seasoning' }),
        item('塩'),
        item('サラダ油'), // alias for 油
        item('味噌', { quantity: 0, quantity_state: 'empty' }),
      ],
      TODAY,
    );

    expect(status.onHand).toEqual(expect.arrayContaining(['醤油', '塩', '油']));
    expect(status.missing).toEqual(expect.arrayContaining(['味噌', '砂糖', 'みりん']));
    expect(status.onHand).not.toContain('味噌');
  });
});

describe('cleanoutTargets', () => {
  it('collects what is running out of time and what is nearly gone', () => {
    const targets = cleanoutTargets(
      [
        item('もやし', {
          expiry_date: '2026-08-11',
          expiry_kind: 'use_by',
          expiry_source: 'estimated',
        }),
        item('ベーコン', { quantity_state: 'low' }),
        item('米', { quantity: 5, unit: 'kg', quantity_state: 'plenty' }),
        item('玉ねぎ', { expiry_date: '2026-09-10', expiry_kind: 'best_before' }),
      ],
      TODAY,
    );

    expect(targets.map((target) => target.name)).toEqual(['もやし', 'ベーコン']);
    expect(targets[0]).toMatchObject({ reason: 'expiring', daysLeft: 1, estimated: true });
    expect(targets[1]).toMatchObject({ reason: 'leftover', daysLeft: null });
  });

  it('leaves out what has to be thrown away rather than cooked', () => {
    const targets = cleanoutTargets(
      [
        item('鶏もも肉', {
          expiry_date: '2026-08-05',
          expiry_kind: 'use_by',
          expiry_source: 'user',
        }),
      ],
      TODAY,
    );

    expect(targets).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts every bucket, including the empty ones', () => {
    const evaluated = evaluateCandidates(
      [
        dish('目玉焼き', [{ name: '卵' }]),
        dish('肉じゃが', [{ name: 'じゃが芋' }]),
      ],
      [item('卵', { quantity: 4, unit: '個' })],
      { today: TODAY },
    );

    expect(summarize(evaluated)).toEqual({
      ready: 1,
      seasoning_only: 0,
      one_short: 1,
      few_short: 0,
      not_feasible: 0,
    });
  });
});
