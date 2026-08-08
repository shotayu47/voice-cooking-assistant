import { describe, expect, it, vi } from 'vitest';

import type { ShoppingItem } from '@/types/domain';

import {
  SHOPPING_PATH,
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
