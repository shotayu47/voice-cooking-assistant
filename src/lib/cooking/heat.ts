/**
 * Heat-level standard (SPEC §10).
 *
 * Guidance, not physics. The assistant is told to prioritise observed cooking
 * state over these numbers; this table only exists so 「中火って10段階だと？」
 * has a consistent answer.
 */

export type HeatBand = {
  label: string;
  ihMin: number;
  ihMax: number;
};

export const IH_10_BANDS: HeatBand[] = [
  { label: 'とろ火', ihMin: 1, ihMax: 2 },
  { label: '弱火', ihMin: 2, ihMax: 3 },
  { label: '弱めの中火', ihMin: 3, ihMax: 4 },
  { label: '中火', ihMin: 5, ihMax: 5 },
  { label: '強めの中火', ihMin: 6, ihMax: 7 },
  { label: '強火', ihMin: 8, ihMax: 9 },
  { label: '最大 / 沸騰', ihMin: 10, ihMax: 10 },
];

export function ihRangeForLabel(label: string): HeatBand | null {
  return IH_10_BANDS.find((band) => band.label === label) ?? null;
}

/** Render a step's heat setting for display, e.g. 「中火（IH 5）」. */
export function formatHeat(heat: {
  type: 'ih_10' | 'low_medium_high';
  value?: number;
  label?: string;
} | undefined): string | null {
  if (!heat) return null;

  if (heat.type === 'ih_10') {
    if (typeof heat.value === 'number') {
      return heat.label ? `${heat.label}（IH ${heat.value}）` : `IH ${heat.value}`;
    }
    const band = heat.label ? ihRangeForLabel(heat.label) : null;
    if (band) {
      const range = band.ihMin === band.ihMax ? `${band.ihMin}` : `${band.ihMin}〜${band.ihMax}`;
      return `${band.label}（IH ${range}）`;
    }
  }

  return heat.label ?? null;
}
