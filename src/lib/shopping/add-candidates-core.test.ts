import { describe, expect, it, vi } from 'vitest';

import type { ShoppingItem } from '@/types/domain';

import { addSelectedShoppingCandidates, type AddCandidatesDeps } from './add-candidates-core';
import type { SelectedShoppingCandidate } from './selected-candidates';

function item(overrides: Partial<ShoppingItem> = {}): ShoppingItem {
  return {
    id: 'id-1',
    user_id: 'user-1',
    name: '卵',
    normalized_name: '卵',
    quantity: null,
    unit: null,
    checked: false,
    checked_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function candidate(
  name: string,
  overrides: Partial<SelectedShoppingCandidate> = {},
): SelectedShoppingCandidate {
  return { name, reason: 'absent', isStaple: false, ...overrides };
}

describe('addSelectedShoppingCandidates', () => {
  it('calls create zero times when nothing is selected', async () => {
    const create = vi.fn();
    const deps: AddCandidatesDeps = { create };

    const result = await addSelectedShoppingCandidates(deps, []);

    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('passes only the selected candidates to create, one call each', async () => {
    const create = vi.fn(async ({ name }: { name: string }) => ({
      item: item({ name }),
      duplicates: [],
    }));
    const selected = [candidate('卵'), candidate('牛乳')];

    await addSelectedShoppingCandidates({ create }, selected);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, { name: '卵' });
    expect(create).toHaveBeenNthCalledWith(2, { name: '牛乳' });
  });

  it('passes through only the quantity and unit the user supplied', async () => {
    const create = vi.fn(async ({ name }: { name: string }) => ({
      item: item({ name }),
      duplicates: [],
    }));

    await addSelectedShoppingCandidates(
      { create },
      [candidate('味噌', { quantity: 1, unit: '個' }), candidate('酢')],
    );

    expect(create).toHaveBeenNthCalledWith(1, { name: '味噌', quantity: 1, unit: '個' });
    expect(create).toHaveBeenNthCalledWith(2, { name: '酢' });
  });

  it('does not write a candidate that was not selected', async () => {
    const create = vi.fn(async ({ name }: { name: string }) => ({
      item: item({ name }),
      duplicates: [],
    }));
    const all = [candidate('卵'), candidate('牛乳'), candidate('人参')];
    const selected = [all[0], all[2]];

    await addSelectedShoppingCandidates({ create }, selected);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalledWith({ name: '牛乳' });
  });

  it('keeps the item and duplicates create returned, paired with the candidate', async () => {
    const eggDuplicate = item({ id: 'dup-1', name: '卵' });
    const create = vi.fn(async ({ name }: { name: string }) =>
      name === '卵'
        ? { item: item({ id: 'new-1', name: '卵' }), duplicates: [eggDuplicate] }
        : { item: item({ id: 'new-2', name }), duplicates: [] },
    );
    const egg = candidate('卵');
    const milk = candidate('牛乳');

    const result = await addSelectedShoppingCandidates({ create }, [egg, milk]);

    expect(result).toEqual([
      { candidate: egg, item: item({ id: 'new-1', name: '卵' }), duplicates: [eggDuplicate] },
      { candidate: milk, item: item({ id: 'new-2', name: '牛乳' }), duplicates: [] },
    ]);
  });

  it('does not resolve with a fabricated success when create fails', async () => {
    const failure = new Error('boom');
    const create = vi.fn(async ({ name }: { name: string }) => {
      if (name === '卵') return { item: item({ name: '卵' }), duplicates: [] };
      throw failure;
    });

    await expect(
      addSelectedShoppingCandidates({ create }, [candidate('卵'), candidate('牛乳')]),
    ).rejects.toThrow(failure);
  });

  it('stops adding further candidates once one call fails', async () => {
    const failure = new Error('boom');
    const create = vi.fn(async ({ name }: { name: string }) => {
      if (name === '卵') throw failure;
      return { item: item({ name }), duplicates: [] };
    });

    await expect(
      addSelectedShoppingCandidates({ create }, [candidate('卵'), candidate('牛乳')]),
    ).rejects.toThrow(failure);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
