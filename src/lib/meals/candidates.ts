/**
 * PHASE 3 — 「今あるもので何作れる？」.
 *
 * The model proposes dishes; this module decides what the user actually has.
 * Keeping those two jobs apart is the whole point: a language model asked to
 * both invent a recipe and check the fridge will cheerfully report that the
 * fridge contains whatever the recipe needs. Here every ingredient is resolved
 * against real inventory rows with the same deterministic matcher the
 * consumption path uses, and every gap is reported as a gap.
 *
 * Pure functions only — no database, no model, no dates beyond the `today`
 * that callers pass in.
 */

import type { Difficulty, InventoryItem } from '@/types/domain';
import { byUrgency, freshnessOf, todayIso } from '@/lib/inventory/freshness';
import { foldName, normalizeIngredientName, resolveInventoryItem } from '@/lib/inventory/normalize';
import { isAvailable } from '@/lib/inventory/quantity';

/**
 * How close a dish is to being cookable right now. Ordered from best to worst;
 * `rankCandidates` relies on that order.
 *
 * 「期限が近い食材を優先して消費できる」 is deliberately *not* one of these.
 * It is orthogonal — a ready-to-cook dish can also be the one that saves the
 * spinach — so it rides along as `usesExpiring` instead of overwriting the
 * feasibility answer.
 */
export const MEAL_AVAILABILITIES = [
  /** 今あるものだけで作れる */
  'ready',
  /** 調味料だけ追加すれば作れる */
  'seasoning_only',
  /** あと1品あれば作れる */
  'one_short',
  /** あと2〜3品買えば作れる */
  'few_short',
  /** それ以上足りない */
  'not_feasible',
] as const;
export type MealAvailability = (typeof MEAL_AVAILABILITIES)[number];

export const MEAL_AVAILABILITY_LABELS: Record<MealAvailability, string> = {
  ready: '今あるもので作れる',
  seasoning_only: '調味料を足せば作れる',
  one_short: 'あと1品',
  few_short: 'あと2〜3品',
  not_feasible: '不足が多い',
};

/** 基礎調味料 — さしすせそ + 油と胡椒. Reported as missing when absent. */
export const BASIC_SEASONINGS = [
  '塩',
  '砂糖',
  '醤油',
  '味噌',
  'みりん',
  '料理酒',
  '酢',
  '油',
  '胡椒',
] as const;

/**
 * Things a household is assumed to restock rather than plan a meal around.
 * Missing only these means 「調味料だけ買えば作れる」, which is a different
 * answer from 「鶏肉が要る」.
 */
const PANTRY_STAPLES: string[] = [
  ...BASIC_SEASONINGS,
  '塩胡椒',
  'ゴマ油',
  'オリーブオイル',
  'マヨネーズ',
  'ケチャップ',
  'ソース',
  'ウスターソース',
  'オイスターソース',
  'ポン酢',
  'めんつゆ',
  'だし',
  '和風だし',
  'コンソメ',
  '鶏がらスープの素',
  '片栗粉',
  '小麦粉',
  'パン粉',
  'カレー粉',
  '豆板醤',
  'コチュジャン',
  'はちみつ',
  'わさび',
  'からし',
  'ラー油',
  '七味唐辛子',
  '一味唐辛子',
];

/** Inventory categories that make an item a seasoning regardless of its name. */
const SEASONING_CATEGORIES = new Set(['seasoning', 'sauce', 'oil', 'spice']);

const STAPLE_KEYS = PANTRY_STAPLES.map((name) => foldName(normalizeIngredientName(name)));

/**
 * Whether an ingredient counts as a pantry staple.
 *
 * Containment is allowed only for keys of two characters or more. 「油」 as a
 * substring would swallow 油揚げ, and 「酢」 would swallow 酢豚 — both are real
 * foods, not something you top up from the cupboard.
 */
export function isSeasoning(name: string, item?: InventoryItem | null): boolean {
  if (item?.category && SEASONING_CATEGORIES.has(item.category)) return true;

  const key = foldName(normalizeIngredientName(name));
  if (!key) return false;

  return STAPLE_KEYS.some((staple) =>
    staple.length >= 2 ? key.includes(staple) : key === staple,
  );
}

export type CandidateIngredient = {
  name: string;
  amount?: number | null;
  unit?: string | null;
  /** Defaults to true: an unmarked ingredient is assumed to be needed. */
  required?: boolean | null;
};

export type CandidateInput = {
  title: string;
  estimatedMinutes?: number | null;
  difficulty?: Difficulty | null;
  reason?: string | null;
  ingredients: CandidateIngredient[];
};

export type MatchedIngredient = {
  /** The name the model used. */
  name: string;
  itemId: string;
  /** The name as it is stored in the inventory, which may differ. */
  itemName: string;
  daysLeft: number | null;
  /** Ready-to-render urgency, e.g.「推定あと2日」. Null when undated. */
  urgency: string | null;
  estimated: boolean;
  /** 賞味期限切れ — still edible, worth a look first. */
  pastBestBefore: boolean;
  /** Several inventory rows could be meant; the most urgent one was used. */
  ambiguous: boolean;
};

export type MissingReason =
  /** 在庫に無い */
  | 'absent'
  /** 在庫にはあるが使い切っている */
  | 'out_of_stock'
  /** あるが量が足りない */
  | 'not_enough'
  /** 消費期限切れ。安全側に倒して「無い」扱いにする */
  | 'unsafe';

export type MissingIngredient = {
  name: string;
  reason: MissingReason;
  seasoning: boolean;
  /** Only set when the shortfall can be stated without guessing. */
  short?: { amount: number; unit: string | null };
  note?: string;
};

export type EvaluatedCandidate = {
  title: string;
  estimatedMinutes: number | null;
  difficulty: Difficulty | null;
  reason: string | null;
  availability: MealAvailability;
  have: MatchedIngredient[];
  missingRequired: MissingIngredient[];
  missingOptional: MissingIngredient[];
  /** Matched items that should be eaten soon. Drives the cleanout ranking. */
  usesExpiring: MatchedIngredient[];
  /** Matched items past a 賞味期限 — usable, but tell the user to check. */
  checkFirst: MatchedIngredient[];
};

export type RankMode = 'normal' | 'cleanout';

/**
 * Match one ingredient against the inventory.
 *
 * `inventory` must include used-up rows: 「在庫に無い」 and 「在庫にはあるが
 * 空」 are different answers, and only the second one means the user knows
 * they need to buy it again.
 */
function matchIngredient(
  ingredient: CandidateIngredient,
  inventory: InventoryItem[],
  today: string,
): { matched: MatchedIngredient } | { missing: MissingIngredient } {
  const name = ingredient.name.trim();
  const resolution = resolveInventoryItem(name, inventory);

  if (resolution.status === 'not_found') {
    return { missing: { name, reason: 'absent', seasoning: isSeasoning(name) } };
  }

  const rows =
    resolution.status === 'matched' ? [resolution.item] : resolution.candidates;
  const ambiguous = resolution.status === 'ambiguous';

  const inStock = rows.filter(isAvailable);
  if (inStock.length === 0) {
    return {
      missing: {
        name,
        reason: 'out_of_stock',
        seasoning: isSeasoning(name, rows[0]),
        note: `${rows[0].name} は在庫を使い切っています。`,
      },
    };
  }

  // A 消費期限 that has passed makes the item unusable, not merely urgent.
  // Prefer a safe row when the name resolved to several.
  const safe = inStock.filter((item) => !isPastUseBy(item, today));
  if (safe.length === 0) {
    const item = [...inStock].sort(byUrgency)[0];
    const freshness = freshnessOf(item, today);
    return {
      missing: {
        name,
        reason: 'unsafe',
        seasoning: isSeasoning(name, item),
        note: freshness?.estimated
          ? `${item.name} は推定では消費期限が切れています。状態を確認してください。`
          : `${item.name} は消費期限が切れています。`,
      },
    };
  }

  // Soonest expiry first: proposing the dish that uses up the oldest one is
  // the whole point of tracking dates.
  const item = [...safe].sort(byUrgency)[0];
  const shortfall = quantityShortfall(item, ingredient);
  if (shortfall) {
    return {
      missing: {
        name,
        reason: 'not_enough',
        seasoning: isSeasoning(name, item),
        short: shortfall,
        note: `${item.name} は ${item.quantity}${item.unit ?? ''} しかありません。`,
      },
    };
  }

  const freshness = freshnessOf(item, today);
  return {
    matched: {
      name,
      itemId: item.id,
      itemName: item.name,
      daysLeft: freshness?.daysLeft ?? null,
      urgency: freshness?.label ?? null,
      estimated: freshness?.estimated ?? false,
      pastBestBefore: freshness?.level === 'expired',
      ambiguous,
    },
  };
}

/**
 * How much more is needed, or null when we cannot say without guessing.
 * Units must match exactly — the same rule the consumption path applies,
 * for the same reason: 200ml and 個 do not subtract.
 */
function quantityShortfall(
  item: InventoryItem,
  ingredient: CandidateIngredient,
): { amount: number; unit: string | null } | null {
  const needed = ingredient.amount;
  if (typeof needed !== 'number' || !Number.isFinite(needed) || needed <= 0) return null;
  if (item.quantity === null) return null;

  const neededUnit = ingredient.unit?.trim() || null;
  const stockUnit = item.unit?.trim() || null;
  if (neededUnit && stockUnit && neededUnit !== stockUnit) return null;

  if (item.quantity >= needed) return null;
  return {
    amount: Math.round((needed - item.quantity) * 1000) / 1000,
    unit: stockUnit ?? neededUnit,
  };
}

function isPastUseBy(item: InventoryItem, today: string): boolean {
  const freshness = freshnessOf(item, today);
  return freshness?.level === 'expired' && item.expiry_kind === 'use_by';
}

/** 期限が近い、または賞味期限を過ぎた — the ones worth building a meal around. */
function isUrgent(matched: MatchedIngredient): boolean {
  return matched.daysLeft !== null && matched.daysLeft <= 3;
}

function classify(missingRequired: MissingIngredient[]): MealAvailability {
  if (missingRequired.length === 0) return 'ready';
  if (missingRequired.every((missing) => missing.seasoning)) return 'seasoning_only';
  if (missingRequired.length === 1) return 'one_short';
  if (missingRequired.length <= 3) return 'few_short';
  return 'not_feasible';
}

/** Evaluate one proposed dish against the inventory. */
export function evaluateCandidate(
  candidate: CandidateInput,
  inventory: InventoryItem[],
  today: string = todayIso(),
): EvaluatedCandidate {
  const have: MatchedIngredient[] = [];
  const missingRequired: MissingIngredient[] = [];
  const missingOptional: MissingIngredient[] = [];

  const seen = new Set<string>();

  for (const ingredient of candidate.ingredients) {
    const name = ingredient.name.trim();
    if (!name) continue;

    // The model sometimes lists 「醤油」 twice (marinade and sauce). Counting
    // it as two missing items would turn 「あと1品」 into 「あと2〜3品」.
    const key = foldName(normalizeIngredientName(name));
    if (seen.has(key)) continue;
    seen.add(key);

    const result = matchIngredient(ingredient, inventory, today);
    if ('matched' in result) {
      have.push(result.matched);
    } else if (ingredient.required === false) {
      missingOptional.push(result.missing);
    } else {
      missingRequired.push(result.missing);
    }
  }

  return {
    title: candidate.title.trim(),
    estimatedMinutes: candidate.estimatedMinutes ?? null,
    difficulty: candidate.difficulty ?? null,
    reason: candidate.reason?.trim() || null,
    availability: classify(missingRequired),
    have,
    missingRequired,
    missingOptional,
    usesExpiring: have.filter(isUrgent),
    checkFirst: have.filter((matched) => matched.pastBestBefore),
  };
}

const AVAILABILITY_RANK: Record<MealAvailability, number> = {
  ready: 0,
  seasoning_only: 1,
  one_short: 2,
  few_short: 3,
  not_feasible: 4,
};

/** Days left on the most urgent ingredient, or Infinity when none is dated. */
function urgencyKey(candidate: EvaluatedCandidate): number {
  const days = candidate.usesExpiring
    .map((matched) => matched.daysLeft)
    .filter((value): value is number => value !== null);
  return days.length > 0 ? Math.min(...days) : Number.POSITIVE_INFINITY;
}

function minutesKey(candidate: EvaluatedCandidate): number {
  return candidate.estimatedMinutes ?? Number.POSITIVE_INFINITY;
}

/**
 * Subtraction is not safe here: two undated candidates both key to Infinity,
 * and `Infinity - Infinity` is NaN, which makes the comparator non-total and
 * leaves the order up to the sort implementation.
 */
function compare(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Order the candidates.
 *
 * Normal mode answers 「何作れる？」 — feasibility first, and among equally
 * feasible dishes the one that rescues something. Cleanout mode answers
 * 「冷蔵庫を整理したい」, where the point *is* the rescue, so a dish that uses
 * two expiring items beats a dish that needs nothing but saves nothing.
 *
 * Sorting is total and deterministic (title breaks the last tie) so the same
 * inventory always produces the same order.
 */
export function rankCandidates(
  candidates: EvaluatedCandidate[],
  mode: RankMode = 'normal',
): EvaluatedCandidate[] {
  return [...candidates].sort((a, b) => {
    const byAvailability = compare(
      AVAILABILITY_RANK[a.availability],
      AVAILABILITY_RANK[b.availability],
    );
    const byExpiringCount = compare(b.usesExpiring.length, a.usesExpiring.length);
    const byMostUrgent = compare(urgencyKey(a), urgencyKey(b));

    const ordered =
      mode === 'cleanout'
        ? [byExpiringCount, byMostUrgent, byAvailability]
        : [byAvailability, byExpiringCount, byMostUrgent];

    for (const comparison of ordered) {
      if (comparison !== 0) return comparison;
    }

    const byMinutes = compare(minutesKey(a), minutesKey(b));
    if (byMinutes !== 0) return byMinutes;
    return a.title.localeCompare(b.title, 'ja');
  });
}

export function evaluateCandidates(
  candidates: CandidateInput[],
  inventory: InventoryItem[],
  options: { mode?: RankMode; today?: string } = {},
): EvaluatedCandidate[] {
  const today = options.today ?? todayIso();
  return rankCandidates(
    candidates.map((candidate) => evaluateCandidate(candidate, inventory, today)),
    options.mode ?? 'normal',
  );
}

export type PantryStatus = {
  /** 基礎調味料 the user has. The model may assume these are available. */
  onHand: string[];
  /** 基礎調味料 with no usable stock. Proposing 醤油 dishes needs a caveat. */
  missing: string[];
};

/** Which of the 基礎調味料 are actually in the kitchen. */
export function pantryStatus(
  inventory: InventoryItem[],
  today: string = todayIso(),
): PantryStatus {
  const onHand: string[] = [];
  const missing: string[] = [];

  for (const seasoning of BASIC_SEASONINGS) {
    const resolution = resolveInventoryItem(seasoning, inventory);
    const rows =
      resolution.status === 'matched'
        ? [resolution.item]
        : resolution.status === 'ambiguous'
          ? resolution.candidates
          : [];

    const usable = rows.filter((item) => isAvailable(item) && !isPastUseBy(item, today));
    (usable.length > 0 ? onHand : missing).push(seasoning);
  }

  return { onHand, missing };
}

export type CleanoutTarget = {
  name: string;
  quantity: number | null;
  unit: string | null;
  quantityState: string;
  daysLeft: number | null;
  urgency: string | null;
  estimated: boolean;
  /** Why it is on the list, so the model can explain the suggestion. */
  reason: 'expiring' | 'leftover';
};

/**
 * 冷蔵庫整理モード — what to build a meal around when the goal is emptying the
 * fridge rather than eating a particular thing. Two kinds of target: things
 * running out of time, and things sitting at a low level that will otherwise
 * be forgotten.
 */
export function cleanoutTargets(
  inventory: InventoryItem[],
  today: string = todayIso(),
  limit = 12,
): CleanoutTarget[] {
  const targets: CleanoutTarget[] = [];

  for (const item of inventory) {
    if (!isAvailable(item)) continue;
    // Nothing to rescue from something that has to be thrown out.
    if (isPastUseBy(item, today)) continue;

    const freshness = freshnessOf(item, today);
    const expiring = freshness !== null && freshness.daysLeft <= 3;
    const leftover = item.quantity_state === 'low';
    if (!expiring && !leftover) continue;

    targets.push({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      quantityState: item.quantity_state,
      daysLeft: freshness?.daysLeft ?? null,
      urgency: freshness?.label ?? null,
      estimated: freshness?.estimated ?? false,
      reason: expiring ? 'expiring' : 'leftover',
    });
  }

  return targets
    .sort((a, b) => {
      const byDays = compare(
        a.daysLeft ?? Number.POSITIVE_INFINITY,
        b.daysLeft ?? Number.POSITIVE_INFINITY,
      );
      if (byDays !== 0) return byDays;
      return a.name.localeCompare(b.name, 'ja');
    })
    .slice(0, limit);
}

/** Counts per bucket, so the model can lead with 「3品すぐ作れます」. */
export function summarize(candidates: EvaluatedCandidate[]): Record<MealAvailability, number> {
  const summary = Object.fromEntries(
    MEAL_AVAILABILITIES.map((availability) => [availability, 0]),
  ) as Record<MealAvailability, number>;

  for (const candidate of candidates) summary[candidate.availability] += 1;
  return summary;
}
