import { Chip } from '@/components/ui/surfaces';
import type { Freshness } from '@/lib/inventory/freshness';

const TONE = {
  expired: 'danger',
  today: 'danger',
  soon: 'warn',
  ok: 'neutral',
} as const;

/**
 * 「あと1日」/「推定あと3日」.
 *
 * An estimated date is deliberately shown in a quieter style and always
 * carries the 推定 prefix — someone must never throw food away, or eat it,
 * because the app's guess looked like the printed date.
 */
export function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  const kindLabel =
    freshness.kind === 'use_by' ? '消費期限' : freshness.kind === 'best_before' ? '賞味期限' : '期限';

  return (
    <Chip
      tone={TONE[freshness.level]}
      className={freshness.estimated ? 'border-dashed opacity-90' : undefined}
    >
      <span title={freshness.estimated ? `${kindLabel}（アプリの推定）` : kindLabel}>
        {freshness.label}
      </span>
    </Chip>
  );
}

/** Inline text variant for dense rows where a chip would crowd the layout. */
export function FreshnessText({ freshness }: { freshness: Freshness }) {
  const className =
    freshness.level === 'expired' || freshness.level === 'today'
      ? 'text-danger'
      : freshness.level === 'soon'
        ? 'text-warn'
        : 'text-faint';

  return <span className={className}>{freshness.label}</span>;
}
