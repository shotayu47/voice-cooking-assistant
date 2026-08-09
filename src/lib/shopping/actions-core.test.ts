import { describe, expect, it, vi } from 'vitest';

import type { ShoppingItem } from '@/types/domain';

import {
  MAX_PICKED_SUGGESTIONS,
  SHOPPING_PATH,
  runAddSuggested,
  runClearChecked,
  runCreate,
  runDelete,
  runSetChecked,
  type ShoppingDeps,
  type ShoppingFormFields,
} from './actions-core';

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

function deps(overrides: Partial<ShoppingDeps> = {}) {
  const revalidate = vi.fn();
  const log = vi.fn();
  const base: ShoppingDeps = {
    create: vi.fn(async () => ({ item: item(), duplicates: [] })),
    setChecked: vi.fn(async () => item({ checked: true })),
    remove: vi.fn(async () => ({ deleted: 1 })),
    clearChecked: vi.fn(async () => ({ deleted: 2 })),
    revalidate,
    log,
    ...overrides,
  };
  return { deps: base, revalidate, log };
}

function fields(overrides: Partial<ShoppingFormFields> = {}): ShoppingFormFields {
  return { name: '卵', quantity: '', unit: '', ...overrides };
}

describe('runCreate — validation', () => {
  it('rejects a blank name without calling the service', async () => {
    const { deps: d, revalidate } = deps();

    const state = await runCreate(d, {}, fields({ name: '   ' }));

    expect(state.error).toBe('品名を入力してください');
    expect(d.create).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('rejects a name that folds away to nothing', async () => {
    const { deps: d } = deps();

    const state = await runCreate(d, {}, fields({ name: '・・・' }));

    expect(state.error).toBe('品名を入力してください');
    expect(d.create).not.toHaveBeenCalled();
  });

  it('rejects a unit with no quantity', async () => {
    const { deps: d, revalidate } = deps();

    const state = await runCreate(d, {}, fields({ quantity: '', unit: '個' }));

    expect(state.error).toBe('単位を使うときは数量も入力してください');
    expect(d.create).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('rejects a quantity that is not a number', async () => {
    const { deps: d } = deps();

    const state = await runCreate(d, {}, fields({ quantity: 'たくさん' }));

    expect(state.error).toBe('数量は数字で入力してください');
    expect(d.create).not.toHaveBeenCalled();
  });

  it('keeps what the user typed when it rejects', async () => {
    const { deps: d } = deps();
    const typed = fields({ name: '卵', quantity: '', unit: '個' });

    const state = await runCreate(d, {}, typed);

    expect(state.values).toEqual(typed);
    expect(state.added).toBe(0);
  });

  it('treats an empty quantity box as "no amount", not an error', async () => {
    const { deps: d } = deps();

    const state = await runCreate(d, {}, fields({ quantity: '  ' }));

    expect(state.error).toBeUndefined();
    expect(d.create).toHaveBeenCalledWith({ name: '卵', quantity: null, unit: null });
  });
});

describe('runCreate — success', () => {
  it('passes the trimmed values through to the service', async () => {
    const { deps: d } = deps();

    await runCreate(d, {}, fields({ name: '  牛乳 ', quantity: '2', unit: ' 本 ' }));

    expect(d.create).toHaveBeenCalledWith({ name: '牛乳', quantity: 2, unit: '本' });
  });

  it('revalidates /shopping and nothing else', async () => {
    const { deps: d, revalidate } = deps();

    await runCreate(d, {}, fields());

    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith(SHOPPING_PATH);
    expect(SHOPPING_PATH).toBe('/shopping');
  });

  it('signals success by bumping the counter and dropping the kept values', async () => {
    const { deps: d } = deps();

    const state = await runCreate(d, { added: 3 }, fields());

    expect(state.added).toBe(4);
    expect(state.values).toBeUndefined();
    expect(state.error).toBeUndefined();
  });

  it('warns about a duplicate but still reports success', async () => {
    const { deps: d } = deps({
      create: vi.fn(async () => ({ item: item(), duplicates: [item({ id: 'other' })] })),
    });

    const state = await runCreate(d, {}, fields({ name: '卵' }));

    expect(state.warning).toBe('「卵」はすでにあります。別項目として追加しました');
    expect(state.error).toBeUndefined();
    expect(state.added).toBe(1);
  });

  it('says nothing when there is no duplicate', async () => {
    const { deps: d } = deps();

    expect((await runCreate(d, {}, fields())).warning).toBeUndefined();
  });
});

describe('runCreate — failure', () => {
  it('shows a safe message and logs the original', async () => {
    const raw = new Error('violates check constraint "shopping_items_unit_needs_quantity"');
    const { deps: d, log, revalidate } = deps({ create: vi.fn(async () => { throw raw; }) });

    const state = await runCreate(d, {}, fields());

    expect(state.error).toBe('うまくいきませんでした。もう一度お試しください。');
    expect(state.error).not.toContain('constraint');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('shopping_items_unit_needs_quantity'));
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('keeps the typed values so a failed submit is not retyped', async () => {
    const { deps: d } = deps({ create: vi.fn(async () => { throw new Error('boom'); }) });
    const typed = fields({ name: '卵', quantity: '6', unit: '個' });

    expect((await runCreate(d, { added: 2 }, typed)).values).toEqual(typed);
  });
});

describe('runSetChecked', () => {
  it('ticks a line and revalidates', async () => {
    const { deps: d, revalidate } = deps();

    expect(await runSetChecked(d, 'id-1', true)).toEqual({ status: 'ok' });
    expect(d.setChecked).toHaveBeenCalledWith('id-1', true);
    expect(revalidate).toHaveBeenCalledWith(SHOPPING_PATH);
  });

  it('unticks a line', async () => {
    const { deps: d } = deps();

    await runSetChecked(d, 'id-1', false);

    expect(d.setChecked).toHaveBeenCalledWith('id-1', false);
  });

  it('returns a safe message on failure and does not revalidate', async () => {
    const { deps: d, revalidate, log } = deps({
      setChecked: vi.fn(async () => { throw new Error('42703: column checked'); }),
    });

    const result = await runSetChecked(d, 'id-1', true);

    expect(result).toEqual({ status: 'error', message: 'うまくいきませんでした。もう一度お試しください。' });
    expect(revalidate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});

describe('runDelete', () => {
  it('removes a line and revalidates', async () => {
    const { deps: d, revalidate } = deps();

    expect(await runDelete(d, 'id-1')).toEqual({ status: 'ok' });
    expect(d.remove).toHaveBeenCalledWith('id-1');
    expect(revalidate).toHaveBeenCalledWith(SHOPPING_PATH);
  });

  it('treats an already-deleted row as success', async () => {
    const { deps: d } = deps({ remove: vi.fn(async () => ({ deleted: 0 })) });

    expect(await runDelete(d, 'id-1')).toEqual({ status: 'ok' });
  });

  it('returns a safe message on failure', async () => {
    const { deps: d } = deps({ remove: vi.fn(async () => { throw new Error('boom'); }) });

    expect(await runDelete(d, 'id-1')).toEqual({
      status: 'error',
      message: 'うまくいきませんでした。もう一度お試しください。',
    });
  });
});

describe('runClearChecked', () => {
  it('clears the bought lines through the service and revalidates', async () => {
    const { deps: d, revalidate } = deps();

    expect(await runClearChecked(d)).toEqual({ status: 'ok' });
    // No id is passed: which rows qualify is the service's rule (checked +
    // owner), not something the UI gets to choose.
    expect(d.clearChecked).toHaveBeenCalledWith();
    expect(revalidate).toHaveBeenCalledWith(SHOPPING_PATH);
  });

  it('never touches the single-row delete path', async () => {
    const { deps: d } = deps();

    await runClearChecked(d);

    expect(d.remove).not.toHaveBeenCalled();
    expect(d.setChecked).not.toHaveBeenCalled();
  });

  it('returns a safe message on failure', async () => {
    const { deps: d, revalidate } = deps({
      clearChecked: vi.fn(async () => { throw new Error('permission denied for table shopping_items'); }),
    });

    const result = await runClearChecked(d);

    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('permission denied');
    expect(revalidate).not.toHaveBeenCalled();
  });
});

describe('runAddSuggested', () => {
  const pick = (name: string, quantity: number | null = null, unit: string | null = null) => ({
    name,
    quantity,
    unit,
  });

  it('adds every line the user ticked', async () => {
    const { deps: d } = deps();

    const result = await runAddSuggested(d, [pick('玉ねぎ'), pick('じゃが芋', 3, '個')]);

    expect(result.added).toEqual(['玉ねぎ', 'じゃが芋']);
    expect(result.failed).toEqual([]);
    expect(d.create).toHaveBeenNthCalledWith(1, { name: '玉ねぎ', quantity: null, unit: null });
    expect(d.create).toHaveBeenNthCalledWith(2, { name: 'じゃが芋', quantity: 3, unit: '個' });
  });

  it('revalidates /shopping once, after the batch', async () => {
    const { deps: d, revalidate } = deps();

    await runAddSuggested(d, [pick('玉ねぎ'), pick('人参')]);

    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith(SHOPPING_PATH);
  });

  it('adds nothing when the selection is empty', async () => {
    const { deps: d, revalidate } = deps();

    const result = await runAddSuggested(d, []);

    expect(result.error).toBe('追加するものを選んでください');
    expect(d.create).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('refuses an implausibly large batch without adding any of it', async () => {
    const { deps: d } = deps();
    const many = Array.from({ length: MAX_PICKED_SUGGESTIONS + 1 }, (_, i) => pick(`品${i}`));

    const result = await runAddSuggested(d, many);

    expect(result.error).toBeDefined();
    expect(d.create).not.toHaveBeenCalled();
  });

  it('re-validates the values instead of trusting the card', async () => {
    // The payload round-tripped through the browser, so it is client input.
    const { deps: d } = deps();

    await runAddSuggested(d, [pick('卵', 0, '個'), pick('牛乳', null, '本')]);

    // A non-positive quantity and a unit with no quantity are both dropped
    // rather than sent to a database that would reject them.
    expect(d.create).toHaveBeenNthCalledWith(1, { name: '卵', quantity: null, unit: null });
    expect(d.create).toHaveBeenNthCalledWith(2, { name: '牛乳', quantity: null, unit: null });
  });

  it('rejects a blank name as a failed line, not a crash', async () => {
    const { deps: d } = deps();

    const result = await runAddSuggested(d, [pick('   '), pick('玉ねぎ')]);

    expect(result.added).toEqual(['玉ねぎ']);
    expect(result.failed).toEqual([{ name: '   ', message: '品名が正しくありません' }]);
  });

  it('passes on the PHASE 9 duplicate notice', async () => {
    const { deps: d } = deps({
      create: vi.fn(async () => ({ item: item(), duplicates: [item({ id: 'other' })] })),
    });

    const result = await runAddSuggested(d, [pick('卵')]);

    expect(result.added).toEqual(['卵']);
    expect(result.notices).toEqual(['「卵」はすでにあります。別項目として追加しました']);
  });

  describe('when one line fails', () => {
    function failingOnSecond() {
      let call = 0;
      return deps({
        create: vi.fn(async () => {
          call += 1;
          if (call === 2) throw new Error('violates check constraint "x"');
          return { item: item(), duplicates: [] };
        }),
      });
    }

    it('keeps the lines that succeeded', async () => {
      const { deps: d } = failingOnSecond();

      const result = await runAddSuggested(d, [pick('A'), pick('B'), pick('C')]);

      expect(result.added).toEqual(['A', 'C']);
      expect(result.failed.map((entry) => entry.name)).toEqual(['B']);
    });

    it('never throws, so the idempotency claim is not released', async () => {
      // Releasing it would let a retry re-create the lines that worked.
      const { deps: d } = failingOnSecond();

      await expect(runAddSuggested(d, [pick('A'), pick('B')])).resolves.toBeDefined();
    });

    it('does not leak the database message', async () => {
      const { deps: d } = failingOnSecond();

      const result = await runAddSuggested(d, [pick('A'), pick('B')]);

      expect(JSON.stringify(result)).not.toContain('constraint');
      expect(result.failed[0].message).toBe('うまくいきませんでした。もう一度お試しください。');
    });

    it('still revalidates, because the list did change', async () => {
      const { deps: d, revalidate } = failingOnSecond();

      await runAddSuggested(d, [pick('A'), pick('B')]);

      expect(revalidate).toHaveBeenCalledWith(SHOPPING_PATH);
    });
  });

  it('does not revalidate when nothing was written', async () => {
    const { deps: d, revalidate } = deps({
      create: vi.fn(async () => { throw new Error('boom'); }),
    });

    await runAddSuggested(d, [pick('A')]);

    expect(revalidate).not.toHaveBeenCalled();
  });
});
