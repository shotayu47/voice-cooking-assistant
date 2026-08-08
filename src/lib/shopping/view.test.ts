import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ShoppingItem } from '@/types/domain';

import {
  deleteLabel,
  describeShoppingError,
  duplicateNotice,
  errorDetail,
  shoppingAmountLabel,
  splitShoppingItems,
} from './view';

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

describe('splitShoppingItems', () => {
  it('separates bought from to-buy', () => {
    const items = [
      item({ id: 'a' }),
      item({ id: 'b', checked: true, checked_at: '2026-01-02T00:00:00Z' }),
      item({ id: 'c' }),
    ];

    const { todo, done } = splitShoppingItems(items);

    expect(todo.map((i) => i.id)).toEqual(['a', 'c']);
    expect(done.map((i) => i.id)).toEqual(['b']);
  });

  it('keeps the order the service returned rather than re-sorting', () => {
    // Already ordered `checked asc, created_at asc` by the query.
    const items = [
      item({ id: 'older', created_at: '2026-01-01T00:00:00Z' }),
      item({ id: 'newer', created_at: '2026-01-09T00:00:00Z' }),
    ];

    expect(splitShoppingItems(items).todo.map((i) => i.id)).toEqual(['older', 'newer']);
  });

  it('handles an empty list', () => {
    expect(splitShoppingItems([])).toEqual({ todo: [], done: [] });
  });

  it('handles a list where everything is bought', () => {
    const items = [item({ id: 'a', checked: true, checked_at: '2026-01-02T00:00:00Z' })];

    const { todo, done } = splitShoppingItems(items);

    expect(todo).toEqual([]);
    expect(done).toHaveLength(1);
  });
});

describe('shoppingAmountLabel', () => {
  it('is empty when there is no amount and no unit', () => {
    expect(shoppingAmountLabel({ quantity: null, unit: null })).toBe('');
  });

  it('renders a quantity with its unit', () => {
    expect(shoppingAmountLabel({ quantity: 6, unit: '個' })).toBe('6個');
  });

  it('renders a bare quantity when no unit was given', () => {
    expect(shoppingAmountLabel({ quantity: 2, unit: null })).toBe('2');
  });

  it('puts prefix units before the number, as recipes write them', () => {
    expect(shoppingAmountLabel({ quantity: 2, unit: '大さじ' })).toBe('大さじ2');
  });

  it('renders fractions the way PHASE 8 formats them', () => {
    expect(shoppingAmountLabel({ quantity: 1.5, unit: '個' })).toBe('1と1/2個');
  });
});

describe('duplicateNotice', () => {
  it('names the item and says what was done', () => {
    expect(duplicateNotice('卵', 1)).toBe('「卵」はすでにあります。別項目として追加しました');
  });

  it('counts when there is more than one', () => {
    expect(duplicateNotice('卵', 2)).toBe('「卵」はすでに2件あります。別項目として追加しました');
  });

  it('says nothing when there is no duplicate', () => {
    expect(duplicateNotice('卵', 0)).toBeUndefined();
  });

  it('says nothing for a blank name', () => {
    expect(duplicateNotice('   ', 1)).toBeUndefined();
  });

  it('trims the name it quotes', () => {
    expect(duplicateNotice('  卵  ', 1)).toBe('「卵」はすでにあります。別項目として追加しました');
  });
});

describe('deleteLabel', () => {
  it('says which row it removes', () => {
    expect(deleteLabel('卵')).toBe('卵を削除');
    expect(deleteLabel('  牛乳 ')).toBe('牛乳を削除');
  });
});

describe('describeShoppingError', () => {
  it('passes through our own validation wording', () => {
    const schema = z.object({ name: z.string().min(1, '品名を入力してください') });
    const parsed = schema.safeParse({ name: '' });

    expect(describeShoppingError(parsed.error)).toBe('品名を入力してください');
  });

  it('never shows a raw database message', () => {
    const raw = new Error(
      'new row for relation "shopping_items" violates check constraint "shopping_items_unit_needs_quantity"',
    );

    const shown = describeShoppingError(raw);

    expect(shown).not.toContain('shopping_items');
    expect(shown).not.toContain('constraint');
    expect(shown).toBe('うまくいきませんでした。もう一度お試しください。');
  });

  it('never shows a Postgres error code or a stack', () => {
    expect(describeShoppingError(new Error('42703: column does not exist'))).not.toContain('42703');
    expect(describeShoppingError('PGRST301')).not.toContain('PGRST');
  });

  it('handles a thrown non-Error', () => {
    expect(describeShoppingError(undefined)).toBe('うまくいきませんでした。もう一度お試しください。');
  });
});

describe('errorDetail', () => {
  it('keeps the original text for the log', () => {
    expect(errorDetail(new Error('violates check constraint'))).toBe('violates check constraint');
  });

  it('joins every validation issue', () => {
    const schema = z.object({ name: z.string().min(1, '品名を入力してください') });
    const parsed = schema.safeParse({ name: '' });

    expect(errorDetail(parsed.error)).toContain('品名を入力してください');
  });
});
