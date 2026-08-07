import { Chip } from '@/components/ui/surfaces';
import { MEAL_AVAILABILITY_LABELS, type EvaluatedCandidate, type MealAvailability } from '@/lib/meals/candidates';

/**
 * PHASE 3 — the meal proposals, rendered from the server's evaluation rather
 * than from the assistant's prose. The reply text and these cards come from
 * the same tool result, so the app cannot say 「作れます」 in one place and
 * list a missing ingredient in the other.
 */

const TONE: Record<MealAvailability, 'ok' | 'accent' | 'warn' | 'neutral'> = {
  ready: 'ok',
  seasoning_only: 'accent',
  one_short: 'warn',
  few_short: 'warn',
  not_feasible: 'neutral',
};

const MISSING_LABELS: Record<string, string> = {
  absent: '在庫なし',
  out_of_stock: '切らしている',
  not_enough: '量が足りない',
  unsafe: '期限切れ',
};

export function MealCandidateCards({ candidates }: { candidates: EvaluatedCandidate[] }) {
  if (candidates.length === 0) return null;

  return (
    <ul className="space-y-2">
      {candidates.map((candidate) => (
        <li
          key={candidate.title}
          className="rounded-card border border-line bg-surface p-3"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-fg">{candidate.title}</p>
            <Chip tone={TONE[candidate.availability]}>
              {MEAL_AVAILABILITY_LABELS[candidate.availability]}
            </Chip>
          </div>

          {candidate.estimatedMinutes ? (
            <p className="mt-0.5 text-xs text-faint">約{candidate.estimatedMinutes}分</p>
          ) : null}

          {candidate.reason ? (
            <p className="mt-1 text-sm text-muted">{candidate.reason}</p>
          ) : null}

          {candidate.usesExpiring.length > 0 ? (
            <p className="mt-2 text-xs text-warn">
              期限が近い:{' '}
              {candidate.usesExpiring
                .map((matched) => `${matched.itemName}（${matched.urgency}）`)
                .join('、')}
            </p>
          ) : null}

          {candidate.missingRequired.length > 0 ? (
            <p className="mt-2 text-xs text-danger">
              不足:{' '}
              {candidate.missingRequired
                .map(
                  (missing) =>
                    `${missing.name}（${MISSING_LABELS[missing.reason] ?? missing.reason}${
                      missing.short ? ` / あと${missing.short.amount}${missing.short.unit ?? ''}` : ''
                    }）`,
                )
                .join('、')}
            </p>
          ) : null}

          {candidate.checkFirst.length > 0 ? (
            <p className="mt-1 text-xs text-warn">
              要確認: {candidate.checkFirst.map((matched) => matched.itemName).join('、')}
              （賞味期限を過ぎています）
            </p>
          ) : null}

          {candidate.missingOptional.length > 0 ? (
            <p className="mt-1 text-xs text-faint">
              なくても可: {candidate.missingOptional.map((missing) => missing.name).join('、')}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
