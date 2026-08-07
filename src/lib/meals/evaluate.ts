/**
 * Server-side evaluation of meal candidates (PHASE 3).
 *
 * The model may invent and describe dishes — that is the creative part. But
 * whether a dish is actually makeable from what is in the fridge is a fact
 * about the user's inventory, so it is decided here and nowhere else. If the
 * model's own account of what is missing disagrees with this, this wins.
 *
 * Pure: takes candidates plus inventory rows and returns verdicts. No I/O, so
 * the rules are testable without a database.
 */

import { freshnessOf } from '@/lib/inventory/freshness';
import { resolveInventoryItem } from '@/lib/inventory/normalize';
import { isAvailable } from '@/lib/inventory/quantity';
import type { InventoryItem } from '@/types/domain';
import {
  classifyMealCandidate,
  isStapleSeasoning,
  usesExpiringIngredient,
  MEAL_CANDIDATE_BUCKET_LABELS,
  type MealCandidateBucket,
} from './classification';

export type CandidateInput = {
  title: string;
  /** Ingredients the dish cannot be made without. */
  requiredIngredients: string[];
  /** Nice-to-haves; never counted as missing. */
  optionalIngredients?: string[];
};

/** Why an ingredient counts as missing. */
export const MISSING_REASONS = ['absent', 'out_of_stock', 'expired'] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

export const MISSING_REASON_LABELS: Record<MissingReason, string> = {
  absent: '在庫にない',
  out_of_stock: '在庫切れ',
  expired: '消費期限切れ',
};

export type MissingIngredient = {
  name: string;
  reason: MissingReason;
  /** Staples are counted separately — being out of 醤油 is not the same as
   *  being out of the main ingredient. */
  isStaple: boolean;
};

export type EvaluatedCandidate = {
  title: string;
  bucket: MealCandidateBucket;
  bucketLabel: string;
  missing: MissingIngredient[];
  onHand: string[];
  usesExpiring: boolean;
  /** Names of near-expiry items this dish would use up. */
  expiringUsed: string[];
};

export type EvaluateOptions = {
  /** Items already known to be near expiry, from listExpiringSoon. */
  expiring: InventoryItem[];
  today?: string;
};

/**
 * An item past a 消費期限 is not stock. 賞味期限 is a quality date, so
 * something slightly past it still counts — refusing to cook with it would
 * be more wasteful than the user wants.
 */
function isSafeToUse(item: InventoryItem, today?: string): boolean {
  const freshness = freshnessOf(item, today);
  if (!freshness) return true;
  return !(freshness.kind === 'use_by' && freshness.level === 'expired');
}

type Resolution =
  | { kind: 'on_hand'; item: InventoryItem }
  | { kind: 'missing'; reason: MissingReason };

/**
 * Does the user have this ingredient? Resolution goes through the same
 * normalization the rest of the app uses, so 「鶏もも」 finds 鶏もも肉.
 */
function resolveIngredient(
  name: string,
  inventory: InventoryItem[],
  today?: string,
): Resolution {
  const result = resolveInventoryItem(name, inventory);

  // Ambiguity is not a problem here: "do I have chicken" is satisfied by any
  // chicken. It only matters when something is about to be *changed*.
  const matches =
    result.status === 'matched'
      ? [result.item]
      : result.status === 'ambiguous'
        ? result.candidates
        : [];

  if (matches.length === 0) return { kind: 'missing', reason: 'absent' };

  const usable = matches.find((item) => isAvailable(item) && isSafeToUse(item, today));
  if (usable) return { kind: 'on_hand', item: usable };

  // It is in the list, but not usable. Say which, so the reply can be honest.
  const expiredOnly = matches.every((item) => !isSafeToUse(item, today));
  return { kind: 'missing', reason: expiredOnly ? 'expired' : 'out_of_stock' };
}

export function evaluateCandidate(
  candidate: CandidateInput,
  inventory: InventoryItem[],
  options: EvaluateOptions,
): EvaluatedCandidate {
  const missing: MissingIngredient[] = [];
  const onHand: string[] = [];

  for (const rawName of candidate.requiredIngredients) {
    const name = rawName.trim();
    if (!name) continue;

    const resolved = resolveIngredient(name, inventory, options.today);
    if (resolved.kind === 'on_hand') {
      onHand.push(resolved.item.name);
    } else {
      missing.push({ name, reason: resolved.reason, isStaple: isStapleSeasoning(name) });
    }
  }

  const bucket = classifyMealCandidate(missing.map((entry) => entry.name));

  const allNames = [
    ...candidate.requiredIngredients,
    ...(candidate.optionalIngredients ?? []),
  ];
  const expiringNames = options.expiring.map((item) => item.name);
  const expiringUsed = options.expiring
    .filter((item) => usesExpiringIngredient(allNames, [item.name]))
    .map((item) => item.name);

  return {
    title: candidate.title,
    bucket,
    bucketLabel: MEAL_CANDIDATE_BUCKET_LABELS[bucket],
    missing,
    onHand,
    usesExpiring: usesExpiringIngredient(allNames, expiringNames),
    expiringUsed,
  };
}

/** Bucket order for presentation: most makeable first. */
const BUCKET_RANK: Record<MealCandidateBucket, number> = {
  fully_stocked: 0,
  staples_only: 1,
  one_missing: 2,
  few_missing: 3,
  not_feasible: 4,
};

export function evaluateCandidates(
  candidates: CandidateInput[],
  inventory: InventoryItem[],
  options: EvaluateOptions & { mode?: 'normal' | 'fridge_cleanup' },
): EvaluatedCandidate[] {
  const evaluated = candidates.map((candidate) =>
    evaluateCandidate(candidate, inventory, options),
  );

  const cleanup = options.mode === 'fridge_cleanup';

  return evaluated.sort((a, b) => {
    // Cleaning out the fridge means using up what is about to go off, even if
    // that dish needs one more thing from the shop.
    if (cleanup && a.usesExpiring !== b.usesExpiring) return a.usesExpiring ? -1 : 1;
    if (cleanup && a.expiringUsed.length !== b.expiringUsed.length) {
      return b.expiringUsed.length - a.expiringUsed.length;
    }

    if (BUCKET_RANK[a.bucket] !== BUCKET_RANK[b.bucket]) {
      return BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
    }
    if (a.usesExpiring !== b.usesExpiring) return a.usesExpiring ? -1 : 1;
    return a.missing.length - b.missing.length;
  });
}
