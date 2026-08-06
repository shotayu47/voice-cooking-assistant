/**
 * Shelf-life estimation and freshness reporting (PHASE 1).
 *
 * The app needs to answer "what should I use first?" even though people
 * almost never type an expiry date. So when none is given we estimate one
 * from the ingredient and how it is stored — and record that it *is* an
 * estimate, because a guess must never be shown as if it were printed on the
 * package.
 *
 * Pure functions only: the estimate is computed here and the resulting date is
 * stored on the row, which keeps the "expiring soon" query a plain indexed
 * range scan instead of something that has to be recomputed in SQL.
 */

import type { InventoryItem, StorageLocation } from '@/types/domain';
import { foldName, normalizeIngredientName } from './normalize';

/** 消費期限 = eat by this date for safety. 賞味期限 = quality date. */
export const EXPIRY_KINDS = ['use_by', 'best_before'] as const;
export type ExpiryKind = (typeof EXPIRY_KINDS)[number];

/** Where the date came from. `estimated` must be labelled as such in the UI. */
export const EXPIRY_SOURCES = ['user', 'estimated', 'unknown'] as const;
export type ExpirySource = (typeof EXPIRY_SOURCES)[number];

type ShelfLife = {
  /** Days from purchase, per storage location. */
  days: Partial<Record<StorageLocation, number>>;
  /** Days from opening, once opened. Overrides `days` when shorter. */
  openedDays?: number;
  kind: ExpiryKind;
};

/**
 * Hand-written shelf lives for common Japanese household ingredients.
 * Conservative on purpose: under-estimating prompts an unnecessary look in the
 * fridge, over-estimating risks someone eating something they shouldn't.
 */
const SHELF_LIVES: Record<string, ShelfLife> = {
  // 肉 — 消費期限
  鶏もも肉: { days: { fridge: 2, freezer: 30 }, kind: 'use_by' },
  鶏むね肉: { days: { fridge: 2, freezer: 30 }, kind: 'use_by' },
  鶏肉: { days: { fridge: 2, freezer: 30 }, kind: 'use_by' },
  豚肉: { days: { fridge: 3, freezer: 30 }, kind: 'use_by' },
  牛肉: { days: { fridge: 3, freezer: 30 }, kind: 'use_by' },
  ひき肉: { days: { fridge: 1, freezer: 21 }, kind: 'use_by' },
  ベーコン: { days: { fridge: 14, freezer: 30 }, openedDays: 4, kind: 'best_before' },
  ウインナー: { days: { fridge: 14, freezer: 30 }, openedDays: 4, kind: 'best_before' },

  // 魚 — 消費期限
  鮭: { days: { fridge: 2, freezer: 30 }, kind: 'use_by' },
  鯖: { days: { fridge: 2, freezer: 30 }, kind: 'use_by' },
  刺身: { days: { fridge: 1 }, kind: 'use_by' },

  // 卵・乳製品
  卵: { days: { fridge: 14 }, kind: 'best_before' },
  牛乳: { days: { fridge: 7 }, openedDays: 3, kind: 'best_before' },
  ヨーグルト: { days: { fridge: 14 }, openedDays: 3, kind: 'best_before' },
  チーズ: { days: { fridge: 30 }, openedDays: 7, kind: 'best_before' },
  バター: { days: { fridge: 60 }, openedDays: 14, kind: 'best_before' },
  豆腐: { days: { fridge: 4 }, openedDays: 1, kind: 'use_by' },
  納豆: { days: { fridge: 7 }, kind: 'best_before' },

  // 野菜
  もやし: { days: { fridge: 2 }, kind: 'use_by' },
  ほうれん草: { days: { fridge: 4 }, kind: 'best_before' },
  レタス: { days: { fridge: 7 }, kind: 'best_before' },
  キャベツ: { days: { fridge: 14 }, openedDays: 5, kind: 'best_before' },
  きゅうり: { days: { fridge: 7 }, kind: 'best_before' },
  トマト: { days: { fridge: 7, room_temperature: 3 }, kind: 'best_before' },
  人参: { days: { fridge: 14, room_temperature: 7 }, kind: 'best_before' },
  玉ねぎ: { days: { fridge: 30, room_temperature: 30, pantry: 30 }, kind: 'best_before' },
  じゃが芋: { days: { room_temperature: 30, pantry: 30, fridge: 21 }, kind: 'best_before' },
  にんにく: { days: { room_temperature: 60, pantry: 60, fridge: 60 }, kind: 'best_before' },
  生姜: { days: { fridge: 21, room_temperature: 10 }, kind: 'best_before' },
  ねぎ: { days: { fridge: 7 }, kind: 'best_before' },
  きのこ: { days: { fridge: 5 }, kind: 'best_before' },

  // 主食
  パン: { days: { room_temperature: 3, pantry: 3, freezer: 30 }, kind: 'best_before' },
  米: { days: { pantry: 180, room_temperature: 180 }, kind: 'best_before' },

  // 調味料 — 開封後が本番
  醤油: { days: { pantry: 365, fridge: 365, room_temperature: 365 }, openedDays: 60, kind: 'best_before' },
  味噌: { days: { fridge: 365, pantry: 365 }, openedDays: 90, kind: 'best_before' },
  みりん: { days: { pantry: 540, room_temperature: 540 }, openedDays: 90, kind: 'best_before' },
  料理酒: { days: { pantry: 540, room_temperature: 540 }, openedDays: 90, kind: 'best_before' },
  マヨネーズ: { days: { fridge: 300 }, openedDays: 30, kind: 'best_before' },
  ケチャップ: { days: { fridge: 365 }, openedDays: 60, kind: 'best_before' },
};

/** Fallbacks when the specific ingredient is unknown but the category is not. */
const CATEGORY_SHELF_LIVES: Record<string, ShelfLife> = {
  meat: { days: { fridge: 3, freezer: 30 }, kind: 'use_by' },
  fish: { days: { fridge: 2, freezer: 30 }, kind: 'use_by' },
  vegetable: { days: { fridge: 7, room_temperature: 5, pantry: 7 }, kind: 'best_before' },
  egg_dairy: { days: { fridge: 7 }, openedDays: 3, kind: 'best_before' },
  frozen: { days: { freezer: 60 }, kind: 'best_before' },
  rice_noodle: { days: { pantry: 180, room_temperature: 180 }, kind: 'best_before' },
  seasoning: { days: { pantry: 365, fridge: 365, room_temperature: 365 }, openedDays: 90, kind: 'best_before' },
  sauce: { days: { fridge: 180, pantry: 180 }, openedDays: 30, kind: 'best_before' },
  oil: { days: { pantry: 365, room_temperature: 365 }, openedDays: 60, kind: 'best_before' },
  spice: { days: { pantry: 730, room_temperature: 730 }, kind: 'best_before' },
};

function lookupShelfLife(name: string, category: string | null): ShelfLife | null {
  const canonical = foldName(normalizeIngredientName(name));

  for (const [key, life] of Object.entries(SHELF_LIVES)) {
    if (foldName(key) === canonical) return life;
  }
  // Partial match: 「鶏もも肉（冷凍）」 should still find 鶏もも肉.
  for (const [key, life] of Object.entries(SHELF_LIVES)) {
    if (canonical.includes(foldName(key))) return life;
  }

  return category ? (CATEGORY_SHELF_LIVES[category] ?? null) : null;
}

export type EstimateInput = {
  name: string;
  category: string | null;
  storageLocation: StorageLocation | null;
  /** Defaults to today when the user did not record a purchase date. */
  purchasedAt?: string | null;
  openedAt?: string | null;
  opened?: boolean | null;
};

export type ExpiryEstimate = {
  date: string;
  kind: ExpiryKind;
};

/**
 * Best guess at when this item stops being good, or null when we have no
 * basis for one. Never invents a date for an unknown ingredient in an unknown
 * category — "no idea" is more useful than a fabricated number.
 */
export function estimateExpiry(
  input: EstimateInput,
  today: string = todayIso(),
): ExpiryEstimate | null {
  const life = lookupShelfLife(input.name, input.category);
  if (!life) return null;

  // Unspecified storage falls back to the longest listed option: guessing
  // "fridge" for something sitting in a cupboard would under-report badly.
  const storage = input.storageLocation;
  const fromStorage = storage
    ? life.days[storage]
    : Math.max(...Object.values(life.days));

  const candidates: string[] = [];

  if (typeof fromStorage === 'number' && Number.isFinite(fromStorage)) {
    candidates.push(addDays(input.purchasedAt || today, fromStorage));
  }

  // Once opened the clock usually restarts and runs faster.
  if (life.openedDays !== undefined && (input.opened || input.openedAt)) {
    candidates.push(addDays(input.openedAt || today, life.openedDays));
  }

  if (candidates.length === 0) return null;

  // Whichever runs out first governs.
  candidates.sort();
  return { date: candidates[0], kind: life.kind };
}

export type FreshnessLevel = 'expired' | 'today' | 'soon' | 'ok';

export type Freshness = {
  daysLeft: number;
  level: FreshnessLevel;
  estimated: boolean;
  kind: ExpiryKind | null;
  /** Ready-to-render Japanese label, e.g.「あと1日」「推定あと3日」. */
  label: string;
};

/**
 * How urgent this item is. `null` when the item carries no date at all, so
 * callers can distinguish "fine" from "unknown".
 */
export function freshnessOf(
  item: Pick<InventoryItem, 'expiry_date'> & {
    expiry_kind?: ExpiryKind | null;
    expiry_source?: ExpirySource | null;
  },
  today: string = todayIso(),
): Freshness | null {
  if (!item.expiry_date) return null;

  const daysLeft = daysBetween(today, item.expiry_date);
  if (daysLeft === null) return null;

  const estimated = item.expiry_source === 'estimated';
  const level: FreshnessLevel =
    daysLeft < 0 ? 'expired' : daysLeft === 0 ? 'today' : daysLeft <= 3 ? 'soon' : 'ok';

  const base =
    level === 'expired'
      ? `${Math.abs(daysLeft)}日過ぎ`
      : level === 'today'
        ? '今日まで'
        : `あと${daysLeft}日`;

  return {
    daysLeft,
    level,
    estimated,
    kind: item.expiry_kind ?? null,
    label: estimated ? `推定${base}` : base,
  };
}

/** Sort key: soonest first, unknown dates last. */
export function byUrgency(
  a: Pick<InventoryItem, 'expiry_date'>,
  b: Pick<InventoryItem, 'expiry_date'>,
): number {
  if (!a.expiry_date && !b.expiry_date) return 0;
  if (!a.expiry_date) return 1;
  if (!b.expiry_date) return -1;
  return a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : 0;
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function daysBetween(fromIso: string, toIso: string): number | null {
  const from = new Date(`${fromIso}T00:00:00`);
  const to = new Date(`${toIso}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
