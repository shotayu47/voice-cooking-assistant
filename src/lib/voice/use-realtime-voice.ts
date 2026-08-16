'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ShoppingSuggestion } from '@/lib/shopping/suggest';

import { argumentSignature, compareSignature } from './arg-signature';
import { classifyErrorMessage } from './error-classify';
import { createEventLog, formatEventLog } from './event-log';
import {
  classifyUtterance,
  decideLivenessAction,
  livenessInstructions,
  type LivenessAction,
} from './liveness';
import { selectExecutableCalls, type RealtimeFunctionCall } from './select-calls';
import {
  canExecuteCall,
  canForceFinal,
  canRequestContinuation,
  canRetry,
  canSendToolOutput,
  describeFailure,
  INITIAL_TURN,
  isForcingFinal,
  isUnresolved,
  markOverdue,
  overdue,
  reduceTurn,
  retryShouldForceFinal,
  type TurnState,
  type VoiceEvent,
} from './turn-state';

/**
 * WebRTC client for the OpenAI Realtime API (SPEC §21.2).
 *
 * Flow: mint ephemeral secret at /api/realtime/session → getUserMedia →
 * SDP exchange with api.openai.com/v1/realtime/calls → events over the
 * "oai-events" data channel. Function calls are forwarded to
 * /api/realtime/tool so all state changes stay authenticated and audited;
 * the browser only relays them.
 *
 * The lifecycle handling here is deliberately defensive. This runs on a phone
 * propped against a cupboard while someone cooks: the mic can be revoked, the
 * network can drop between rooms, the screen can lock, and the session has a
 * server-side lifetime. Every one of those must end in a visible state and a
 * released microphone — never a silent dead call with the mic light on.
 */

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error';

export type VoiceState = {
  status: VoiceStatus;
  /** What the user last said (input transcription). */
  userTranscript: string;
  /** What the assistant is saying / last said. */
  assistantTranscript: string;
  /** Name of the tool currently executing, if any. */
  activeTool: string | null;
  /** Non-fatal problem worth showing without tearing the call down. */
  notice: string | null;
  error: string | null;
  /**
   * Set when a committed turn stopped producing an answer. The call is still
   * up — this is the difference between "still thinking" and "nothing is
   * coming", which the UI previously could not tell apart and so never said.
   */
  stalled: string | null;
  /** Whether re-asking for a response on the unfinished turn is safe. */
  canRetry: boolean;
};

export type ToolEffect = {
  effect: 'inventory_changed' | 'session_changed' | null;
  sessionId: string | null;
};

/**
 * Structured shopping candidates from one voice tool call.
 *
 * `callId` travels with them so the page can key the card by it: a relay that
 * is retried, or an event delivered twice, redraws the same card instead of
 * stacking a second copy.
 */
export type VoiceSuggestions = {
  callId: string;
  suggestions: ShoppingSuggestion[];
};

const INITIAL_STATE: VoiceState = {
  status: 'idle',
  userTranscript: '',
  assistantTranscript: '',
  activeTool: null,
  notice: null,
  error: null,
  stalled: null,
  canRetry: false,
};

type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  response?: {
    id?: string;
    /** `completed` | `cancelled` | `failed` | `incomplete`. */
    status?: string;
    /**
     * Why it did not complete. Declared before but never read, which is why a
     * `failed` response could only ever be reported as "failed".
     */
    status_details?: {
      type?: string;
      reason?: string;
      error?: { type?: string; code?: string; param?: string; message?: string };
    };
    output?: RealtimeFunctionCall[];
  };
  item?: { id?: string; type?: string };
  error?: {
    type?: string;
    code?: string;
    param?: string;
    message?: string;
    /** The client payload this rejects, when the server can attribute it. */
    event_id?: string;
  };
};

/**
 * Client events that carry an `event_id` so an error can name them.
 *
 * Exported so the set is pinned by a test: adding the id is the only change
 * this instrumentation makes to what goes on the wire, and it must stay
 * confined to payloads the server can reject.
 */
export const CORRELATED_EVENTS = new Set([
  'response.create',
  'response.cancel',
  'conversation.item.create',
]);

/** How often the watchdog asks whether the current wait has gone on too long. */
const WATCHDOG_INTERVAL_MS = 2_000;

/**
 * What the model is told when the guard has cut it off from further tools.
 *
 * It has results in hand; the only thing missing is the sentence. Saying so
 * explicitly beats leaving it to infer why its tools stopped working.
 */
const FORCED_FINAL_INSTRUCTIONS = [
  'すでに取得済みのツール結果だけを使って、ユーザーへの回答を今すぐ完成させてください。',
  'これ以上ツールを呼び出すことはできません。追加の情報取得を試みないでください。',
  '手元の結果で答えられない部分があれば、その旨を一言添えてください。',
].join('\n');

/**
 * Client-side id for one outbound payload.
 *
 * Only ever compared against `error.event_id` and aliased before it reaches
 * the trace, so the value itself is never recorded.
 */
let eventIdCounter = 0;
function newEventId(): string {
  eventIdCounter += 1;
  return `ce_${eventIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useRealtimeVoice(options: {
  /** Called after a tool call that changed persistent state. */
  onToolEffect?: (effect: ToolEffect) => void;
  /**
   * Called when a voice tool returned shopping candidates. Nothing has been
   * written at this point — the card is how the user picks, exactly as on the
   * text path.
   */
  onSuggestions?: (payload: VoiceSuggestions) => void;
}) {
  const [state, setState] = useState<VoiceState>(INITIAL_STATE);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  /**
   * Set synchronously so a double-tap cannot start two calls. `pcRef` is only
   * populated after two awaits, which is far too late to guard on.
   */
  const startingRef = useRef(false);
  /** call_ids already relayed, so a repeated event cannot run a tool twice. */
  const handledCallsRef = useRef<Set<string>>(new Set());

  /**
   * The turn's state machine. Held in a ref because the event handlers close
   * over it and must read the value as it is *now*, not as it was when the
   * handler was created.
   */
  const turnRef = useRef<TurnState>(INITIAL_TURN);
  const logRef = useRef(createEventLog());
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Trace-only bookkeeping. Neither of these changes what the client does —
   * they exist so the log can say what the code was *trying* to do, which is
   * the part that cannot be reconstructed from the events alone.
   *
   * The response a cancel was requested for. Currently always 'unspecified',
   * because `response.cancel` is sent without a target id; recording that is
   * the point.
   */
  const cancelWaitingRef = useRef<string | null>(null);
  /** Whether a liveness reply has been asked for and not yet seen arrive. */
  const livenessPendingRef = useRef(false);
  /** The liveness reply queued behind an outstanding cancel. */
  const pendingLivenessActionRef = useRef<LivenessAction | null>(null);
  /**
   * Set by `connect`, because the sender lives in its closure. Lets the retry
   * button reach the forced-final path instead of re-running tool selection.
   */
  const forceFinalRef = useRef<(() => void) | null>(null);
  /**
   * Last argument digest per tool name, for the SAME/DIFFERENT diagnostic.
   * Digests only — the arguments are never retained.
   */
  const lastSignatureRef = useRef<Map<string, string>>(new Map());

  const onToolEffectRef = useRef(options.onToolEffect);
  useEffect(() => {
    onToolEffectRef.current = options.onToolEffect;
  }, [options.onToolEffect]);

  const onSuggestionsRef = useRef(options.onSuggestions);
  useEffect(() => {
    onSuggestionsRef.current = options.onSuggestions;
  }, [options.onSuggestions]);

  const teardown = useCallback(() => {
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }

    channelRef.current?.close();
    channelRef.current = null;

    const pc = pcRef.current;
    if (pc) {
      // Drop handlers first: closing fires connectionstatechange, and a
      // handler that re-enters teardown would loop.
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      pc.close();
    }
    pcRef.current = null;

    for (const track of micRef.current?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    micRef.current = null;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }

    handledCallsRef.current.clear();
    turnRef.current = INITIAL_TURN;
    startingRef.current = false;
  }, []);

  const disconnect = useCallback(() => {
    teardown();
    setState(INITIAL_STATE);
  }, [teardown]);

  /** End the call but leave a reason on screen. */
  const failWith = useCallback(
    (message: string) => {
      teardown();
      setState({ ...INITIAL_STATE, status: 'error', error: message });
    },
    [teardown],
  );

  // Never leave the microphone open after unmount.
  useEffect(() => () => teardown(), [teardown]);

  const connect = useCallback(async () => {
    if (startingRef.current || pcRef.current) return;
    startingRef.current = true;
    // Marks the boundary without clearing: one buffer can hold the failed
    // call and the retry that followed it.
    logRef.current.add('internal', 'session.start');
    cancelWaitingRef.current = null;
    livenessPendingRef.current = false;
    setState({ ...INITIAL_STATE, status: 'connecting' });

    // iOS Safari only allows audio playback that begins in a user gesture.
    // The element must therefore be created and primed *before* the first
    // await, while we are still inside the click handler's call stack.
    const audio = new Audio();
    audio.autoplay = true;
    // Safari needs this for media elements it may treat as video-capable.
    audio.setAttribute('playsinline', '');
    audioRef.current = audio;

    try {
      // 1. Ephemeral credential from our server. The permanent key never
      //    reaches this code.
      const sessionResponse = await fetch('/api/realtime/session', {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
      });
      if (!sessionResponse.ok) {
        const body = await sessionResponse.json().catch(() => ({}));
        throw new Error(
          sessionResponse.status === 401
            ? 'ログインが切れました。画面を再読み込みしてください。'
            : (body.message ?? '音声セッションを開始できませんでした'),
        );
      }
      const { client_secret: clientSecret } = (await sessionResponse.json()) as {
        client_secret: string;
      };

      // 2. Microphone.
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRef.current = mic;

      // Permission revoked, device unplugged, or another app grabbed it.
      for (const track of mic.getTracks()) {
        track.onended = () => failWith('マイクが使えなくなりました。もう一度お試しください。');
      }

      // 3. Peer connection.
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        // Autoplay can still be refused; play() surfaces it as a rejection.
        void audio.play().catch(() => {
          setState((current) => ({
            ...current,
            notice: '音が出ない場合は、画面をタップするか消音スイッチを確認してください。',
          }));
        });
      };

      for (const track of mic.getTracks()) pc.addTrack(track, mic);

      const channel = pc.createDataChannel('oai-events');
      channelRef.current = channel;
      channel.onmessage = (event) => {
        void handleEvent(JSON.parse(event.data) as RealtimeEvent);
      };
      channel.onopen = () => {
        logRef.current.add('internal', 'channel_open');
        setState((current) => ({ ...current, status: 'live' }));

        /*
         * Nothing else notices a turn that simply stops. Every other path here
         * is driven by an event arriving; this is the one case defined by an
         * event *not* arriving, so it needs a clock.
         */
        watchdogRef.current = setInterval(() => {
          const failure = overdue(turnRef.current, Date.now());
          if (!failure) return;

          logRef.current.add('internal', 'watchdog.fire', {
            status: failure,
            from: turnRef.current.phase,
            active: turnRef.current.activeResponseId ?? undefined,
            pendingLiveness: livenessPendingRef.current,
          });
          turnRef.current = markOverdue(turnRef.current, failure, Date.now());
          const stalled = describeFailure(turnRef.current);
          setState((current) => ({
            ...current,
            stalled,
            canRetry: canRetry(turnRef.current),
            activeTool: null,
          }));
        }, WATCHDOG_INTERVAL_MS);
      };
      channel.onclose = () => {
        // The server ends the channel when the session's lifetime expires.
        setState((current) =>
          current.status === 'live'
            ? { ...current, status: 'error', error: '音声セッションが終了しました。もう一度開始してください。' }
            : current,
        );
        teardown();
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          failWith('接続が切れました。電波を確認してもう一度お試しください。');
        } else if (pc.connectionState === 'disconnected') {
          // Transient on mobile — WebRTC often recovers on its own. Say so
          // rather than killing a call that is about to come back.
          setState((current) =>
            current.status === 'live'
              ? { ...current, notice: '接続が不安定です…' }
              : current,
          );
        } else if (pc.connectionState === 'connected') {
          setState((current) => ({ ...current, notice: null }));
        }
      };

      // 4. SDP exchange, authorized by the ephemeral secret only.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${clientSecret}`,
          'content-type': 'application/sdp',
        },
        body: offer.sdp,
        signal: AbortSignal.timeout(20_000),
      });
      if (!sdpResponse.ok) {
        throw new Error(`音声接続に失敗しました (${sdpResponse.status})`);
      }

      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpResponse.text() });
      startingRef.current = false;
    } catch (error) {
      failWith(describeConnectError(error));
    }

    /**
     * Advance the turn machine and mirror the parts of it the UI shows.
     *
     * Every transition goes through here, so there is exactly one place where
     * "what state is this turn in" is decided.
     */
    function advance(event: VoiceEvent) {
      const before = turnRef.current;
      const after = reduceTurn(before, event);
      turnRef.current = after;

      if (after.phase !== before.phase || after.activeResponseId !== before.activeResponseId) {
        logRef.current.add('internal', 'turn.reduce', {
          reason: event.type,
          from: before.phase,
          to: after.phase,
          active: after.activeResponseId ?? undefined,
          status: after.failure ?? undefined,
          pendingLiveness: livenessPendingRef.current,
        });
      }

      /*
       * Whether the watchdog is watching anything is derived, not stored — so
       * it is logged by observation rather than by changing how it works. A
       * far-future `now` makes `overdue` answer "would this phase ever time
       * out", which is exactly the arm/disarm question.
       */
      const armedBefore = overdue(before, Number.MAX_SAFE_INTEGER) !== null;
      const armedAfter = overdue(after, Number.MAX_SAFE_INTEGER) !== null;
      if (armedBefore !== armedAfter) {
        logRef.current.add('internal', armedAfter ? 'watchdog.arm' : 'watchdog.clear', {
          reason: event.type,
          from: before.phase,
          to: after.phase,
        });
      }

      const stalled = describeFailure(after);
      setState((current) =>
        current.stalled === stalled && current.canRetry === canRetry(after)
          ? current
          : { ...current, stalled, canRetry: canRetry(after) },
      );
    }

    async function handleEvent(event: RealtimeEvent) {
      switch (event.type) {
        // ---- Turn lifecycle. Recorded for the trace, and for the machine. ----
        case 'input_audio_buffer.speech_started':
          logRef.current.add('in', 'input_audio_buffer.speech_started');
          advance({ type: 'speech_started', at: Date.now() });
          break;

        case 'input_audio_buffer.speech_stopped':
          logRef.current.add('in', 'input_audio_buffer.speech_stopped');
          advance({ type: 'speech_stopped', at: Date.now() });
          break;

        case 'input_audio_buffer.committed':
          logRef.current.add('in', 'input_audio_buffer.committed', { item: event.item_id });
          advance({ type: 'committed', at: Date.now() });
          break;

        case 'conversation.item.created':
          logRef.current.add('in', 'conversation.item.created', { item: event.item?.id, status: event.item?.type });
          break;

        case 'response.output_item.added':
          logRef.current.add('in', 'response.output_item.added', { resp: event.response?.id });
          break;

        case 'response.function_call_arguments.done':
          logRef.current.add('in', 'response.function_call_arguments.done', { call: event.call_id });
          break;

        case 'conversation.item.input_audio_transcription.failed':
          // The turn may still be answered, but the model heard nothing useful.
          logRef.current.add('in', 'transcription.failed');
          setState((current) => ({
            ...current,
            notice: '聞き取れませんでした。もう一度話しかけてください。',
          }));
          break;

        case 'response.output_audio.done':
          logRef.current.add('in', 'response.output_audio.done', { resp: event.response?.id });
          break;

        // Assistant speech transcript (streamed).
        case 'response.output_audio_transcript.delta':
          setState((current) => ({
            ...current,
            assistantTranscript: current.assistantTranscript + (event.delta ?? ''),
          }));
          break;

        case 'response.output_audio_transcript.done':
          if (event.transcript) {
            setState((current) => ({ ...current, assistantTranscript: event.transcript! }));
          }
          break;

        // A new assistant turn starts a fresh caption.
        case 'response.created':
          logRef.current.add('in', 'response.created', {
            resp: event.response?.id,
            pendingLiveness: livenessPendingRef.current,
          });
          // Whatever this response is, a liveness reply is no longer merely
          // pending — the trace can show whether it was the one asked for.
          livenessPendingRef.current = false;
          cancelWaitingRef.current = null;
          advance({
            type: 'response_created',
            at: Date.now(),
            responseId: event.response?.id ?? 'unknown',
          });
          setState((current) => ({ ...current, assistantTranscript: '', stalled: null }));
          break;

        // What the user said.
        case 'conversation.item.input_audio_transcription.completed':
          logRef.current.add('in', 'transcription.completed');
          if (event.transcript) {
            const transcript = event.transcript.trim();
            setState((current) => ({ ...current, userTranscript: transcript }));
            handleLivenessCheck(transcript);
          }
          break;

        // End of a model turn. Only a *completed* one may act.
        case 'response.done': {
          const status = event.response?.status ?? 'completed';
          // Read before the reducer moves the phase on.
          const wasForcingFinal = isForcingFinal(turnRef.current);
          const details = event.response?.status_details;
          logRef.current.add('in', 'response.done', {
            resp: event.response?.id,
            status,
            // The whole point of this pass: `failed` on its own says nothing.
            detailType: details?.type,
            detailReason: details?.reason,
            errType: details?.error?.type,
            code: details?.error?.code ?? classifyErrorMessage(details?.error?.message),
            errParam: details?.error?.param,
            // Which response the turn believed it was waiting for. If these
            // disagree, the turn is being rewritten by an unrelated response.
            active: turnRef.current.activeResponseId ?? undefined,
            cancelWaiting: cancelWaitingRef.current ?? undefined,
            pendingLiveness: livenessPendingRef.current,
          });

          advance({
            type: 'response_done',
            at: Date.now(),
            responseId: event.response?.id ?? 'unknown',
            status,
            // Read but never forwarded before, so the reducer could not tell a
            // barge-in from a genuine cancellation.
            reason: details?.reason,
          });

          // The cancel we were waiting on has reported. This is the only place
          // the queued liveness reply is created.
          if (turnRef.current.phase === 'awaiting_liveness_create') {
            cancelWaitingRef.current = null;
            sendLivenessCreate();
            break;
          }

          if (status !== 'completed') {
            /*
             * A cancelled or failed response still carries whatever output it
             * had produced, including whole function calls — and reading only
             * the event name made those indistinguishable from a finished
             * turn. Running them sends a `function_call_output` for a call the
             * server has already abandoned, which it rejects, leaving the turn
             * with no answer at all. That is the state the device reached.
             */
            logRef.current.add('internal', 'calls_skipped', { status, reason: 'response_not_completed' });
            setState((current) => ({ ...current, activeTool: null }));
            break;
          }

          const calls = selectExecutableCalls(event.response?.output, handledCallsRef.current);

          if (calls.length > 0 && wasForcingFinal) {
            /*
             * The tools-forbidden reply asked for a tool anyway. Running it
             * would start the loop again, and asking for another final would
             * recurse — so this is where the turn stops and says so.
             */
            logRef.current.add('internal', 'forced_final_looped', { resp: event.response?.id });
            advance({ type: 'forced_final_looped', at: Date.now() });
            setState((current) => ({ ...current, activeTool: null }));
            break;
          }

          for (const call of calls) {
            if (!canExecuteCall(turnRef.current, call.callId)) continue;
            handledCallsRef.current.add(call.callId);
            advance({ type: 'function_call_ready', at: Date.now(), callId: call.callId });
            await runTool(call.name, call.callId, call.arguments);
          }
          break;
        }

        case 'error': {
          const code = event.error?.code;
          // Never the message itself: it is free text and can quote the
          // conversation back. Classified into a token when there is no code.
          logRef.current.add('in', 'error', {
            errType: event.error?.type,
            code: code ?? classifyErrorMessage(event.error?.message),
            errParam: event.error?.param,
            // Names the payload this rejects, so a failed send is attributable
            // rather than merely adjacent in the log.
            eventId: event.error?.event_id,
            from: turnRef.current.phase,
            active: turnRef.current.activeResponseId ?? undefined,
            pendingLiveness: livenessPendingRef.current,
          });
          console.error('[voice] realtime error code:', code ?? 'unknown');
          advance({ type: 'api_error', at: Date.now() });
          setState((current) => ({
            ...current,
            notice: '聞き取りに問題がありました。もう一度話しかけてください。',
          }));
          break;
        }
      }
    }


    async function runTool(name: string, callId: string, args: string) {
      const startedAt = Date.now();

      /*
       * Whether this repeats the previous call to the same tool. Only the
       * verdict is kept — the digest is compared and discarded, and the
       * arguments themselves are never held anywhere.
       */
      const signature = argumentSignature(args);
      const argsMatch = compareSignature(lastSignatureRef.current.get(name), signature);
      if (signature !== null) lastSignatureRef.current.set(name, signature);

      logRef.current.add('internal', 'tool_start', { tool: name, call: callId, argsMatch });
      setState((current) => ({ ...current, activeTool: name, notice: null }));
      try {
        const response = await fetch('/api/realtime/tool', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // call_id makes this idempotent server-side: a retried relay
          // returns the stored result instead of running the tool again.
          body: JSON.stringify({ name, arguments: args, call_id: callId }),
          signal: AbortSignal.timeout(30_000),
        });

        const body = response.ok
          ? ((await response.json()) as {
              result: unknown;
              effect: ToolEffect['effect'];
              session_id: string | null;
              suggestions?: ShoppingSuggestion[] | null;
            })
          : {
              result: {
                error: 'tool_failed',
                message:
                  response.status === 401
                    ? 'ログインが切れました。画面を再読み込みしてください。'
                    : `操作に失敗しました (${response.status})`,
              },
              effect: null,
              session_id: null,
              suggestions: null,
            };

        logRef.current.add('internal', 'tool_done', {
          tool: name,
          call: callId,
          status: response.ok ? 'ok' : String(response.status),
          ms: Date.now() - startedAt,
        });

        if (!response.ok) {
          setState((current) => ({ ...current, notice: '操作に失敗しました' }));
        }

        /*
         * The card first, and unconditionally.
         *
         * It is built from structured output that has already arrived, so it
         * is valid whether or not the spoken half of the turn survives. Drawing
         * it after the sends meant a failure to deliver the output could take
         * the card with it — losing the one part that worked.
         */
        if (body.suggestions && body.suggestions.length > 0) {
          onSuggestionsRef.current?.({ callId, suggestions: body.suggestions });
          advance({ type: 'card_shown', at: Date.now() });
        }

        if (body.effect) {
          onToolEffectRef.current?.({ effect: body.effect, sessionId: body.session_id });
        }

        deliverToolOutput(callId, body.result);
      } catch {
        // Timed out or offline. Tell the model so it can say something rather
        // than waiting forever for an output that will never arrive.
        logRef.current.add('internal', 'tool_failed', { tool: name, call: callId, ms: Date.now() - startedAt });
        setState((current) => ({ ...current, notice: '操作がタイムアウトしました' }));
        deliverToolOutput(callId, {
          error: 'tool_unreachable',
          message: 'サーバーに接続できませんでした。ユーザーに再試行を促してください。',
        });
      } finally {
        setState((current) => ({ ...current, activeTool: null }));
      }
    }

    /**
     * Hand a tool's result back and ask for the reply that follows it.
     *
     * Both halves are guarded. The output goes at most once per call id, and
     * the continuation at most once per turn and never while a response is
     * still active — with `create_response: true` the server may already have
     * started one, and a second concurrent request is refused, which is how a
     * turn ended up with no reply rather than two.
     */
    function deliverToolOutput(callId: string, result: unknown) {
      if (!canSendToolOutput(turnRef.current, callId)) {
        logRef.current.add('internal', 'output_suppressed', { call: callId, reason: 'already_sent' });
        return;
      }

      const delivered = send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result),
        },
      });

      if (!delivered) {
        // Silently dropping this used to leave the model waiting forever for
        // an output that would never arrive — the turn simply went quiet.
        logRef.current.add('internal', 'output_undeliverable', { call: callId, reason: 'channel_closed' });
        advance({ type: 'channel_lost', at: Date.now() });
        return;
      }

      logRef.current.add('internal', 'output_sent', { call: callId });
      advance({ type: 'tool_output_sent', at: Date.now(), callId });

      if (!canRequestContinuation(turnRef.current)) {
        /*
         * Which half of the guard fired, and in what state. The guard allows
         * one continuation per turn and none while a response is active, so a
         * turn that calls two tools cannot ask for a reply after the second —
         * recording the count is what will show whether that is what happened.
         */
        logRef.current.add('internal', 'continuation_guard', {
          reason:
            turnRef.current.continuationsRequested > 0 ? 'budget_spent' : 'response_active',
          continuations: turnRef.current.continuationsRequested,
          hasActive: turnRef.current.activeResponseId !== null,
          from: turnRef.current.phase,
          pendingLiveness: livenessPendingRef.current,
        });

        // The guard stops another round of *tools*, not the answer itself. The
        // result is already delivered, so the turn ends one way or the other
        // here rather than sitting in running_tool until the watchdog calls it.
        requestForcedFinal();
        return;
      }

      if (send({ type: 'response.create' })) {
        logRef.current.add('internal', 'continuation_requested');
        advance({ type: 'continuation_requested', at: Date.now() });
      } else {
        advance({ type: 'channel_lost', at: Date.now() });
      }
    }

    /**
     * Answer "are you still there" from what is known about the turn.
     *
     * With `create_response: true` the server is already generating a reply to
     * this utterance, and the only substantial context in the prompt is the
     * cooking session — which is how a contentless question came back as the
     * next cooking step of an unrelated dish. Cancelling that response and
     * asking again with explicit instructions is what makes the answer depend
     * on the turn's state instead of on what happens to be in the prompt.
     */
    function handleLivenessCheck(transcript: string) {
      const action = decideLivenessAction(
        classifyUtterance(transcript),
        isUnresolved(turnRef.current),
      );
      if (action === 'pass_through') return;

      logRef.current.add('internal', 'liveness.decided', {
        status: action,
        from: turnRef.current.phase,
        active: turnRef.current.activeResponseId ?? undefined,
      });

      pendingLivenessActionRef.current = action;
      livenessPendingRef.current = true;

      const active = turnRef.current.activeResponseId;
      if (!active) {
        // Nothing to tear down, so the reply can be asked for straight away.
        sendLivenessCreate();
        return;
      }

      /*
       * Cancel first, and *wait*. `response.cancel` is asynchronous: the
       * response is not gone until its `response.done` arrives. Sending the
       * create in the same breath — which is what the trace shows at 13998ms —
       * asks for a second response while the first is still active, and the
       * server refuses it. The reply is created when the cancel reports, in
       * `response.done`, and nowhere else.
       */
      cancelWaitingRef.current = active;
      send({ type: 'response.cancel', response_id: active });
      advance({ type: 'liveness_cancel_sent', at: Date.now(), responseId: active });
    }

    /** The neutral reply itself. Sent once, only after the cancel reported. */
    function sendLivenessCreate() {
      const action = pendingLivenessActionRef.current;
      if (!action) return;
      pendingLivenessActionRef.current = null;

      logRef.current.add('internal', 'liveness.create', { status: action });

      const ok = send({
        type: 'response.create',
        response: {
          metadata: { purpose: 'liveness' },
          instructions: livenessInstructions(action, describeFailure(turnRef.current)),
        },
      });

      if (ok) {
        advance({ type: 'liveness_create_sent', at: Date.now() });
      } else {
        livenessPendingRef.current = false;
        advance({ type: 'channel_lost', at: Date.now() });
      }
    }

    /**
     * Ask for one reply that uses what the tools already returned, with no
     * further tools allowed.
     *
     * `tool_choice: 'none'` and a response-level `metadata` are both part of
     * `response.create` in the installed Realtime schema — checked against the
     * SDK's own types rather than assumed. The metadata is what lets the trace
     * tell this response apart from an ordinary one.
     */
    forceFinalRef.current = requestForcedFinal;

    function requestForcedFinal() {
      if (!canForceFinal(turnRef.current)) {
        logRef.current.add('internal', 'forced_final_unavailable', {
          reason: 'already_spent',
          from: turnRef.current.phase,
        });
        advance({ type: 'forced_final_unavailable', at: Date.now() });
        return;
      }

      logRef.current.add('internal', 'forced_final_requested', { from: turnRef.current.phase });
      advance({ type: 'forced_final_requested', at: Date.now() });

      const ok = send({
        type: 'response.create',
        response: {
          tool_choice: 'none',
          metadata: { purpose: 'forced_final' },
          instructions: FORCED_FINAL_INSTRUCTIONS,
        },
      });

      if (!ok) advance({ type: 'channel_lost', at: Date.now() });
    }

    /** Returns whether the payload actually went out. */
    function send(payload: { type: string; [key: string]: unknown }): boolean {
      /*
       * An `event_id` on the payloads that can be rejected, so `error.event_id`
       * names which one failed instead of leaving it to be guessed from
       * ordering. Nothing else about the send changes: the id is additive and
       * the server echoes it back only on failure.
       */
      const eventId = CORRELATED_EVENTS.has(payload.type) ? newEventId() : undefined;
      const wire = eventId ? { ...payload, event_id: eventId } : payload;

      const open = channelRef.current?.readyState === 'open';
      if (open) channelRef.current!.send(JSON.stringify(wire));

      // Only the event type is recorded. The payload can carry a tool result
      // or the instructions text, and neither belongs in a trace.
      logRef.current.add('out', payload.type, {
        sent: open,
        reason: open ? undefined : 'channel_not_open',
        eventId,
        active: turnRef.current.activeResponseId ?? undefined,
        pendingLiveness: livenessPendingRef.current,
      });

      return open;
    }
  }, [failWith, teardown]);

  /**
   * iOS suspends WebRTC when the tab is backgrounded or the screen locks. On
   * return, report a call that did not survive instead of showing a live
   * indicator over a dead connection.
   */
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      const pc = pcRef.current;
      if (!pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        failWith('バックグラウンド中に接続が切れました。もう一度開始してください。');
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [failWith]);

  /**
   * Ask again for a response to the turn that never got one.
   *
   * A bare `response.create`, with no new conversation item: the user's audio
   * was committed before this went wrong, so the item is already in the
   * conversation and re-sending it would add a second copy of what they said.
   *
   * Deliberately manual. When the outcome is unknown the safe move is to let
   * the user decide, not to retry on a timer behind their back.
   */
  const retry = useCallback(() => {
    if (!canRetry(turnRef.current)) return;
    if (channelRef.current?.readyState !== 'open') {
      setState((current) => ({
        ...current,
        stalled: '接続が切れています。音声を終了してもう一度開始してください。',
        canRetry: false,
      }));
      return;
    }

    /*
     * A stall that happened *after* tool output was delivered must not be
     * retried by re-running the ordinary path: the model would pick tools
     * again and arrive back at the same guard, which is exactly the loop the
     * device showed — succeed, suppress, wait 21s, fail, repeat.
     */
    if (retryShouldForceFinal(turnRef.current) && forceFinalRef.current) {
      logRef.current.add('internal', 'retry_requested', { reason: 'forced_final' });
      forceFinalRef.current();
      setState((current) => ({ ...current, stalled: null, canRetry: false }));
      return;
    }

    logRef.current.add('internal', 'retry_requested', { reason: 'plain' });
    turnRef.current = reduceTurn(turnRef.current, { type: 'retry_requested', at: Date.now() });

    // Sent outside `send()` because that lives in the connect closure, so the
    // id and the trace entry are added here to match.
    const eventId = newEventId();
    channelRef.current.send(JSON.stringify({ type: 'response.create', event_id: eventId }));
    logRef.current.add('out', 'response.create', {
      sent: true,
      eventId,
      reason: 'retry',
      active: turnRef.current.activeResponseId ?? undefined,
    });
    setState((current) => ({ ...current, stalled: null, canRetry: false }));
  }, []);

  /**
   * The redacted trace, for a bug report. Never any content.
   *
   * Deliberately not cleared on disconnect: the interesting traces end with a
   * call that failed, and clearing on teardown would destroy the evidence at
   * the exact moment it became worth having. Resetting is an explicit act.
   */
  const eventTrace = useCallback(() => formatEventLog(logRef.current.entries()), []);
  const resetTrace = useCallback(() => {
    logRef.current.clear();
    logRef.current.add('internal', 'trace.reset');
  }, []);

  return { state, connect, disconnect, retry, eventTrace, resetTrace };
}

function describeConnectError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'マイクの使用が許可されていません。ブラウザの設定で許可してください。';
    }
    if (error.name === 'NotFoundError') return 'マイクが見つかりませんでした。';
    if (error.name === 'NotReadableError') {
      return 'マイクを他のアプリが使用中です。そちらを終了してください。';
    }
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return '接続がタイムアウトしました。電波を確認してもう一度お試しください。';
    }
  }
  if (!navigator.onLine) return 'オフラインです。接続を確認してください。';
  return error instanceof Error ? error.message : '接続に失敗しました';
}
