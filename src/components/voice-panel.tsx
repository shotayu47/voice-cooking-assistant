'use client';

import { cn } from '@/lib/cn';
import { useRealtimeVoice, type ToolEffect } from '@/lib/voice/use-realtime-voice';

/**
 * Hands-free voice mode for cooking (SPEC §21).
 *
 * One large toggle: tap to start, tap to stop. While live it shows a status
 * dot and the two most useful lines — what was heard and what the assistant
 * said — so the screen can be glanced at with wet hands, not operated.
 */
export function VoicePanel({
  onToolEffect,
}: {
  onToolEffect: (effect: ToolEffect) => void;
}) {
  const { state, connect, disconnect } = useRealtimeVoice({ onToolEffect });

  const live = state.status === 'live';
  const connecting = state.status === 'connecting';

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

      {state.status === 'error' && state.error ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
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
