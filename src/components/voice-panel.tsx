'use client';

import { useState, useSyncExternalStore } from 'react';

import { cn } from '@/lib/cn';
import { isVoiceDebugEnabled } from '@/lib/voice/debug-flag';
import {
  useRealtimeVoice,
  type ToolEffect,
  type VoiceSuggestions,
} from '@/lib/voice/use-realtime-voice';

/** The flag is fixed once the page loads, so there is nothing to listen to. */
const subscribeToNothing = () => () => {};
const readDebugFlag = () => isVoiceDebugEnabled(window.location.search);

/**
 * Hands-free voice mode for cooking (SPEC §21).
 *
 * One large toggle: tap to start, tap to stop. While live it shows a status
 * dot and the two most useful lines — what was heard and what the assistant
 * said — so the screen can be glanced at with wet hands, not operated.
 */
export function VoicePanel({
  onToolEffect,
  onSuggestions,
}: {
  onToolEffect: (effect: ToolEffect) => void;
  /** Structured candidates from a voice tool call, for the page to draw. */
  onSuggestions?: (payload: VoiceSuggestions) => void;
}) {
  const { state, connect, disconnect, retry, eventTrace, resetTrace } = useRealtimeVoice({
    onToolEffect,
    onSuggestions,
  });

  const live = state.status === 'live';
  const connecting = state.status === 'connecting';

  /*
   * The query string is browser state, not React state. Reading it through
   * this is what lets the server render "off" and the client render the real
   * answer without the two disagreeing — the flag never changes for the life
   * of the page, so there is nothing to subscribe to.
   */
  const debug = useSyncExternalStore(subscribeToNothing, readDebugFlag, () => false);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => (live || connecting ? disconnect() : void connect())}
        aria-pressed={live}
        className={cn(
          'flex min-h-14 w-full items-center justify-center gap-3 rounded-xl border text-base font-medium transition-colors',
          live
            ? 'border-accent bg-accent/15 text-accent'
            : connecting
              ? 'border-line bg-surface-2 text-muted'
              : 'border-line text-fg active:bg-surface-2',
        )}
      >
        <MicIcon muted={!live && !connecting} />
        {live ? '音声で操作中 — タップで終了' : connecting ? '接続中…' : '音声で操作'}
        {live ? (
          <span className="relative flex size-2" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-accent" />
          </span>
        ) : null}
      </button>

      {live &&
      (state.userTranscript || state.assistantTranscript || state.activeTool || state.notice) ? (
        <div
          className="space-y-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm"
          aria-live="polite"
        >
          {state.userTranscript ? (
            <p className="text-faint">
              <span aria-hidden>🗣 </span>
              {state.userTranscript}
            </p>
          ) : null}
          {state.assistantTranscript ? (
            <p className="text-fg">{state.assistantTranscript}</p>
          ) : null}
          {state.activeTool ? (
            <p className="text-xs text-accent">実行中: {toolLabel(state.activeTool)}</p>
          ) : null}
          {state.notice ? <p className="text-xs text-warn">{state.notice}</p> : null}
        </div>
      ) : null}

      {live && state.rateLimited ? (
        /*
         * Deliberately not the same box as a stall. A rate limit is not a
         * broken turn — waiting fixes it, and retrying immediately does not,
         * since refused requests count against the allowance too.
         */
        <div
          className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm text-fg">{state.rateLimited.message}</p>
          <div className="flex gap-2">
            {state.rateLimited.exhausted ? null : (
              <button
                type="button"
                onClick={retry}
                disabled={state.rateLimited.secondsLeft > 0}
                className="min-h-11 flex-1 rounded-lg border border-accent/50 px-3 text-sm text-accent disabled:opacity-40"
              >
                {state.rateLimited.secondsLeft > 0
                  ? `再試行できるまで ${state.rateLimited.secondsLeft}秒`
                  : 'もう一度応答を試す'}
              </button>
            )}
            <button
              type="button"
              onClick={disconnect}
              className="min-h-11 flex-1 rounded-lg border border-line px-3 text-sm text-fg active:bg-surface-2"
            >
              音声を終了してテキストで続ける
            </button>
          </div>
        </div>
      ) : null}

      {live && state.stalled ? (
        /*
         * A committed turn that stopped producing an answer. The call is still
         * up, so the mic indicator alone would say "listening" over a turn that
         * is never going to be answered — the user is left talking to nothing,
         * which is what "お願いします" into silence was.
         */
        <div
          className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm text-fg">{state.stalled}</p>
          <div className="flex gap-2">
            {state.canRetry ? (
              <button
                type="button"
                onClick={retry}
                className="min-h-11 flex-1 rounded-lg border border-accent/50 px-3 text-sm text-accent active:bg-surface-2"
              >
                もう一度応答を試す
              </button>
            ) : null}
            <button
              type="button"
              onClick={disconnect}
              className="min-h-11 flex-1 rounded-lg border border-line px-3 text-sm text-fg active:bg-surface-2"
            >
              音声を終了してテキストで続ける
            </button>
          </div>
        </div>
      ) : null}

      {state.status === 'error' && state.error ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}

      {debug ? <VoiceDiagnostics trace={eventTrace} reset={resetTrace} /> : null}
    </div>
  );
}

/**
 * The redacted trace, on a phone.
 *
 * Only rendered under `?voiceDebug=1`. It reads the log and nothing else — no
 * handler here touches the call — so a diagnostic control cannot be the reason
 * a cooking session misbehaves.
 */
function VoiceDiagnostics({ trace, reset }: { trace: () => string; reset: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    // Must be called inside the tap: iOS Safari refuses clipboard writes that
    // are not tied to a user gesture, and awaiting anything first loses it.
    const contents = trace();
    setCopied(false);

    try {
      await navigator.clipboard.writeText(contents);
      setCopied(true);
      setText(null);
    } catch {
      // Refused — show it instead so it can be selected by hand. Failing to
      // copy must not mean failing to get the trace off the device.
      setText(contents);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-dashed border-line px-3 py-2">
      <p className="text-xs text-faint">音声診断（?voiceDebug=1）</p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="min-h-11 flex-1 rounded-lg border border-line px-3 text-sm text-fg active:bg-surface-2"
        >
          {copied ? 'コピーしました' : '音声診断をコピー'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setText(null);
            setCopied(false);
          }}
          className="min-h-11 rounded-lg border border-line px-3 text-sm text-muted active:bg-surface-2"
        >
          リセット
        </button>
      </div>

      {text !== null ? (
        <>
          <p className="text-xs text-warn">
            コピーできませんでした。下のテキストを選択してコピーしてください。
          </p>
          <textarea
            readOnly
            value={text}
            onFocus={(event) => event.currentTarget.select()}
            rows={10}
            className="w-full rounded-lg border border-line bg-surface px-2 py-1 font-mono text-[11px] text-fg"
          />
        </>
      ) : null}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  get_inventory: '在庫を確認',
  find_inventory_item: '食材を特定',
  add_inventory_item: '在庫に追加',
  update_inventory_item: '在庫を更新',
  consume_inventory_item: '在庫を減らす',
  search_meal_candidates: '献立を検討',
  create_recipe: 'レシピを作成',
  adjust_recipe_amounts: '分量を調整',
  suggest_shopping_items: '買い物候補を検討',
  start_cooking_session: '調理を開始',
  get_current_cooking_step: '工程を確認',
  advance_cooking_step: '次の工程へ',
  previous_cooking_step: '前の工程へ',
  finish_cooking_session: '調理を終了',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={muted ? 'opacity-70' : undefined}
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}
