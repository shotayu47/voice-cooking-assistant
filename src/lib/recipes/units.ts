/**
 * Units and amount formatting (PHASE 8).
 *
 * Two jobs, both pure:
 *   1. Compare two amounts written in different units — but only when the
 *      conversion is a definition, never when it needs a density. 200g of flour
 *      and 200ml of flour are not the same thing, so `g ↔ ml` returns null
 *      rather than a plausible number.
 *   2. Render an amount the way a person writes it: 「1と1/2」, not 「1.5」.
 */

import { foldName } from '@/lib/inventory/normalize';

export type Dimension = 'mass' | 'volume';

type UnitSpec = {
  dimension: Dimension;
  /** How many base units (g for mass, ml for volume) one of this unit is. */
  inBase: number;
};

/**
 * Only definitional conversions live here. 大さじ / 小さじ / カップ are the
 * Japanese standard measures (15ml / 5ml / 200ml) — fixed by definition, like
 * kg → g. Anything requiring a density is deliberately absent.
 */
const RAW_UNITS: Array<[string, UnitSpec]> = [
  ['g', { dimension: 'mass', inBase: 1 }],
  ['グラム', { dimension: 'mass', inBase: 1 }],
  ['kg', { dimension: 'mass', inBase: 1000 }],
  ['キロ', { dimension: 'mass', inBase: 1000 }],
  ['キログラム', { dimension: 'mass', inBase: 1000 }],
  ['ml', { dimension: 'volume', inBase: 1 }],
  ['cc', { dimension: 'volume', inBase: 1 }],
  ['ミリリットル', { dimension: 'volume', inBase: 1 }],
  ['l', { dimension: 'volume', inBase: 1000 }],
  ['リットル', { dimension: 'volume', inBase: 1000 }],
  ['大さじ', { dimension: 'volume', inBase: 15 }],
  ['小さじ', { dimension: 'volume', inBase: 5 }],
  ['カップ', { dimension: 'volume', inBase: 200 }],
];

const UNITS = new Map<string, UnitSpec>(
  RAW_UNITS.map(([unit, spec]) => [foldName(unit), spec]),
);

/**
 * Units written as decimals rather than fractions. 「375g」 reads naturally;
 * 「1と1/2g」 does not. Everything else — 個, 枚, 大さじ — gets fractions.
 */
const DECIMAL_UNITS = new Set(
  ['g', 'グラム', 'kg', 'キロ', 'キログラム', 'ml', 'cc', 'ミリリットル', 'l', 'リットル'].map(
    foldName,
  ),
);

export function unitSpec(unit: string | null | undefined): UnitSpec | null {
  if (!unit) return null;
  return UNITS.get(foldName(unit)) ?? null;
}

/** True when two unit strings are the same unit written differently. */
export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a ? foldName(a) : '';
  const right = b ? foldName(b) : '';
  return left !== '' && left === right;
}

/**
 * Convert `amount` from one unit to another.
 *
 * Returns null whenever the conversion is not a definition — a different
 * dimension, an unknown unit (個, 枚, 本 …) that is not literally the same
 * string, or a missing unit on either side. Null means "cannot compare",
 * and every caller must treat it as unknown rather than as zero.
 */
export function convertAmount(
  amount: number,
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  if (!Number.isFinite(amount)) return null;
  if (sameUnit(from, to)) return amount;

  // A missing unit on either side cannot be assumed to match the other.
  const fromSpec = unitSpec(from);
  const toSpec = unitSpec(to);
  if (!fromSpec || !toSpec) return null;
  if (fromSpec.dimension !== toSpec.dimension) return null;

  return (amount * fromSpec.inBase) / toSpec.inBase;
}

/** Denominators a cook actually uses. 1/5 of an onion is not an instruction. */
const DENOMINATORS = [2, 3, 4];
const TOLERANCE = 1e-6;

/**
 * Render a number the way a recipe writes it. Fractions are used only when the
 * value really is that fraction — 0.33 stays 0.33, because rounding it to 1/3
 * would quietly change a number the user gave us.
 */
export function formatNumber(value: number, unit?: string | null): string {
  if (!Number.isFinite(value)) return '';

  if (unit && DECIMAL_UNITS.has(foldName(unit))) {
    const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    return String(rounded);
  }

  const whole = Math.floor(value + TOLERANCE);
  const fraction = value - whole;

  if (fraction < TOLERANCE) return String(whole);

  for (const denominator of DENOMINATORS) {
    const numerator = Math.round(fraction * denominator);
    if (
      numerator > 0 &&
      numerator < denominator &&
      Math.abs(fraction - numerator / denominator) < TOLERANCE
    ) {
      return whole > 0
        ? `${whole}と${numerator}/${denominator}`
        : `${numerator}/${denominator}`;
    }
  }

  return String(Math.round(value * 100) / 100);
}

/**
 * Units Japanese recipes write before the number: 大さじ2, not 2大さじ.
 */
const PREFIX_UNITS = new Set(['大さじ', '小さじ', 'カップ'].map(foldName));

/**
 * An amount ready to be read out: 「1と1/2個」「375g」「大さじ2」. A null amount
 * has no number to show — 「適量」 stays 「適量」 and never acquires one.
 */
export function formatAmount(
  amount: number | null | undefined,
  unit: string | null | undefined,
): string {
  const label = unit?.trim() ?? '';
  if (amount === null || amount === undefined) return label;

  const formatted = formatNumber(amount, unit);
  if (!formatted) return label;

  return label && PREFIX_UNITS.has(foldName(label))
    ? `${label}${formatted}`
    : `${formatted}${label}`;
}
