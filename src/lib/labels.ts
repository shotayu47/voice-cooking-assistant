/** Japanese display labels for the enums in the schema. UI-only. */

import type { Category, Difficulty, QuantityState, StorageLocation } from '@/types/domain';

export const CATEGORY_LABELS: Record<Category, string> = {
  meat: '肉',
  fish: '魚',
  vegetable: '野菜',
  egg_dairy: '卵・乳製品',
  frozen: '冷凍食品',
  rice_noodle: '米・麺',
  seasoning: '調味料',
  sauce: 'ソース',
  oil: '油',
  spice: 'スパイス',
  other: 'その他',
};

/** Order categories appear in on the inventory screen. */
export const CATEGORY_ORDER: Category[] = [
  'meat',
  'fish',
  'vegetable',
  'egg_dairy',
  'frozen',
  'rice_noodle',
  'seasoning',
  'sauce',
  'oil',
  'spice',
  'other',
];

export const QUANTITY_STATE_LABELS: Record<QuantityState, string> = {
  unknown: '不明',
  low: '少ない',
  available: 'あり',
  plenty: '十分',
  empty: 'なし',
};

export const STORAGE_LABELS: Record<StorageLocation, string> = {
  fridge: '冷蔵',
  freezer: '冷凍',
  pantry: '常備棚',
  room_temperature: '常温',
  other: 'その他',
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'かんたん',
  medium: 'ふつう',
  hard: 'むずかしい',
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return CATEGORY_LABELS.other;
  return CATEGORY_LABELS[category as Category] ?? category;
}
