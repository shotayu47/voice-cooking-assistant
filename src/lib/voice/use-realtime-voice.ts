'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { selectExecutableCalls, type RealtimeFunctionCall } from './select-calls';

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
};

export type ToolEffect = {
  effect: 'inventory_changed' | 'session_changed' | null;
  sessionId: string | null;
};

const INITIAL_STATE: VoiceState = {
  status: 'idle',
  userTranscript: '',
  assistantTranscript: '',
  activeTool: null,
  notice: null,
  error: null,
};

type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  response?: { output?: RealtimeFunctionCall[] };
  error?: { message?: string; code?: string };
};

export function useRealtimeVoice(options: {
  /** Called after a tool call that changed persistent state. */
  onToolEffect?: (effect: ToolEffect) => void;
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

  const onToolEffectRef = useRef(options.onToolEffect);
  useEffect(() => {
    onToolEffectRef.current = options.onToolEffect;
  }, [options.onToolEffect]);

  const teardown = useCallback(() => {
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
        setState((current) => ({ ...current, status: 'live' }));
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

    async function handleEvent(event: RealtimeEvent) {
      switch (event.type) {
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
          setState((current) => ({ ...current, assistantTranscript: '' }));
          break;

        // What the user said.
        case 'conversation.item.input_audio_transcription.completed':
          if (event.transcript) {
            setState((current) => ({
              ...current,
              userTranscript: event.transcript!.trim(),
            }));
          }
          break;

        // Completed model turn — run any function calls it contains.
        case 'response.done': {
          const calls = selectExecutableCalls(event.response?.output, handledCallsRef.current);
          for (const call of calls) {
            handledCallsRef.current.add(call.callId);
            await runTool(call.name, call.callId, call.arguments);
          }
          break;
        }

        case 'error':
          console.error('[voice] realtime error:', event.error?.message);
          setState((current) => ({
            ...current,
            notice: '聞き取りに問題がありました。もう一度話しかけてください。',
          }));
          break;
      }
    }

    async function runTool(name: string, callId: string, args: string) {
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
            };

        if (!response.ok) {
          setState((current) => ({ ...current, notice: '操作に失敗しました' }));
        }

        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(body.result),
          },
        });
        send({ type: 'response.create' });

        if (body.effect) {
          onToolEffectRef.current?.({ effect: body.effect, sessionId: body.session_id });
        }
      } catch {
        // Timed out or offline. Tell the model so it can say something rather
        // than waiting forever for an output that will never arrive.
        setState((current) => ({ ...current, notice: '操作がタイムアウトしました' }));
        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({
              error: 'tool_unreachable',
              message: 'サーバーに接続できませんでした。ユーザーに再試行を促してください。',
            }),
          },
        });
        send({ type: 'response.create' });
      } finally {
        setState((current) => ({ ...current, activeTool: null }));
      }
    }

    function send(payload: unknown) {
      if (channelRef.current?.readyState === 'open') {
        channelRef.current.send(JSON.stringify(payload));
      }
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

  return { state, connect, disconnect };
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
