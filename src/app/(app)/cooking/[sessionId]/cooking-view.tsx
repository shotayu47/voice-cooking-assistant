'use client';

import { useRef, useState, useTransition } from 'react';

import { cn } from '@/lib/cn';
import { formatHeat } from '@/lib/cooking/heat';
import { ingredientsForStep, stepAt } from '@/lib/cooking/steps';
import type { Recipe } from '@/types/domain';

import { finishSessionAction, getStepStateAction, moveStepAction } from '../actions';
import { AskSheet } from './ask-sheet';
import { StepTimer } from './step-timer';
import { VoicePanel } from '@/components/voice-panel';

/**
 * Cooking mode (SPEC §5.6).
 *
 * One step fills the screen. Controls sit at the bottom within thumb reach and
 * are 72px tall so they can be hit without looking. The step number always
 * comes from the server — local state is only ever a mirror of it.
 */
export function CookingView({
  sessionId,
  recipe,
  initialStep,
  totalSteps,
  initialCompleted,
  initialSkipped,
}: {
  sessionId: string;
  recipe: Recipe;
  initialStep: number;
  totalSteps: number;
  initialCompleted: number[];
  initialSkipped: number[];
}) {
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [completed, setCompleted] = useState(initialCompleted);
  const [skipped, setSkipped] = useState(initialSkipped);
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastTapRef = useRef(0);

  // A server re-render (revalidatePath, back navigation) wins over local state.
  // Adjusted during render rather than in an effect so there is no frame
  // showing the stale step.
  const [syncedStep, setSyncedStep] = useState(initialStep);
  if (syncedStep !== initialStep) {
    setSyncedStep(initialStep);
    setCurrentStep(initialStep);
  }

  const step = stepAt(recipe, currentStep);
  const stepIngredients = ingredientsForStep(recipe, currentStep);
  const heat = formatHeat(step?.heat ?? undefined);
  const isFirst = currentStep === 0;
  const isLast = currentStep >= totalSteps - 1;

  function move(direction: 'next' | 'previous', intent: 'done' | 'skip' = 'done') {
    // Two taps inside 600ms is a bounce, not an intent to skip two steps.
    const now = Date.now();
    if (pending || now - lastTapRef.current < 600) return;
    lastTapRef.current = now;

    const expected = currentStep;
    setError(null);
    startTransition(async () => {
      try {
        const state = await moveStepAction(sessionId, direction, expected, intent);
        setCurrentStep(state.currentStep);
        setCompleted(state.completedSteps);
        setSkipped(state.skippedSteps);
      } catch {
        // The step lives in the database; a failed move means the screen may
        // now disagree with it. Say so rather than implying it worked.
        setError('工程を移動できませんでした。通信を確認して、もう一度タップしてください。');
      }
    });
  }

  function finish(status: 'completed' | 'cancelled') {
    startTransition(async () => {
      await finishSessionAction(sessionId, status);
    });
  }

  /** The voice assistant moved state through a tool — mirror the DB. */
  function syncFromServer() {
    startTransition(async () => {
      try {
        const state = await getStepStateAction(sessionId);
        if (state.status === 'completed' || state.status === 'cancelled') {
          // The user said 「終了」 by voice; leave via the normal path.
          window.location.href = '/history';
          return;
        }
        setCurrentStep(state.currentStep);
        setCompleted(state.completedSteps);
        setSkipped(state.skippedSteps);
      } catch {
        // Re-render on next interaction; nothing to surface mid-cook.
      }
    });
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col">
      <header
        className="flex min-h-14 items-center gap-3 px-4"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <h1 className="min-w-0 flex-1 truncate text-sm text-muted">{recipe.title}</h1>
        <button
          type="button"
          onClick={() => finish('cancelled')}
          className="min-h-11 px-2 text-sm text-faint active:text-danger"
        >
          終了
        </button>
      </header>

      <div className="px-4">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold tabular-nums text-accent">
            {currentStep + 1}
          </span>
          <span className="text-sm text-faint">/ {totalSteps}</span>
          {skipped.length > 0 ? (
            <span className="ml-auto text-xs text-muted">{skipped.length}工程スキップ</span>
          ) : null}
        </div>

        {/*
          One segment per step rather than a single bar: with skipping, how far
          along you are is no longer the same as which step is on screen.
        */}
        <div
          className="mt-2 flex gap-0.5"
          role="progressbar"
          aria-valuenow={completed.length}
          aria-valuemin={0}
          aria-valuemax={totalSteps}
          aria-label={`${totalSteps}工程中${completed.length}工程完了`}
        >
          {Array.from({ length: totalSteps }, (_, index) => (
            <span
              key={index}
              className={cn(
                'h-1 flex-1 rounded-full',
                index === currentStep
                  ? 'bg-accent'
                  : completed.includes(index)
                    ? 'bg-accent/50'
                    : skipped.includes(index)
                      ? 'bg-muted/40'
                      : 'bg-surface-2',
              )}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-1 flex-col justify-center gap-5 px-4 py-8">
        <p className="text-[26px] leading-relaxed font-medium">
          {step?.instruction ?? '手順が読み込めませんでした'}
        </p>

        {stepIngredients.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {stepIngredients.map((ingredient) => (
              <li
                key={ingredient}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm"
              >
                {ingredient}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {heat ? (
            <span className="rounded-lg bg-accent/15 px-3 py-1.5 text-sm text-accent">
              火力 {heat}
            </span>
          ) : null}
          {step?.durationSeconds ? (
            <StepTimer key={currentStep} seconds={step.durationSeconds} />
          ) : null}
        </div>

        {step?.safetyNote ? (
          <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
            {step.safetyNote}
          </p>
        ) : null}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>

      <div
        className="sticky bottom-0 space-y-2 border-t border-line bg-bg/95 px-4 pt-3 backdrop-blur"
        style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}
      >
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => move('previous')}
            disabled={isFirst || pending}
            className="min-h-[72px] w-[30%] rounded-xl border border-line text-base text-fg active:bg-surface-2 disabled:opacity-30"
          >
            戻る
          </button>
          <button
            type="button"
            onClick={() => (isLast ? finish('completed') : move('next', 'done'))}
            disabled={pending}
            className={cn(
              'min-h-[72px] flex-1 rounded-xl text-xl font-bold active:bg-accent-strong disabled:opacity-50',
              isLast ? 'bg-ok text-on-accent' : 'bg-accent text-on-accent',
            )}
          >
            {isLast ? '完成！' : 'できた / 次へ'}
          </button>
        </div>

        {/*
          Deliberately small and secondary: skipping is a real need — the step
          is already done, or does not apply — but it must not be the button
          someone hits by accident instead of 「できた」.
        */}
        {!isLast ? (
          <button
            type="button"
            onClick={() => move('next', 'skip')}
            disabled={pending}
            className="min-h-11 w-full rounded-xl text-sm text-faint active:bg-surface-2 disabled:opacity-40"
          >
            この工程は飛ばす
          </button>
        ) : null}

        <VoicePanel
          onToolEffect={(effect) => {
            if (effect.effect === 'session_changed') syncFromServer();
          }}
        />

        <button
          type="button"
          onClick={() => setAsking(true)}
          className="min-h-12 w-full rounded-xl border border-line text-sm text-muted active:bg-surface-2"
        >
          AIに質問する
        </button>
      </div>

      {asking ? (
        <AskSheet
          sessionId={sessionId}
          onClose={() => setAsking(false)}
          onTurnComplete={() => {
            // The assistant may have advanced the step itself.
            startTransition(async () => {
              const state = await getStepStateAction(sessionId);
              setCurrentStep(state.currentStep);
            });
          }}
        />
      ) : null}
    </div>
  );
}
