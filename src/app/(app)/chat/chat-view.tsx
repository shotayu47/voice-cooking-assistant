'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import { VoicePanel } from '@/components/voice-panel';
import type { ShoppingSuggestion } from '@/lib/shopping/suggest';

import { SuggestionCard } from './suggestion-card';

/**
 * `suggestions` only ever arrives on a live reply. Candidates are a reading of
 * the fridge at one moment, so they are not part of `initialMessages` and do
 * not come back after a reload — see STALE_ON_REPLAY.
 */
type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  suggestions?: ShoppingSuggestion[];
};

const SUGGESTIONS = [
  '今あるもので何作れる？',
  '20分以内で',
  '肉系がいい',
  '洗い物少ないやつ',
];

export function ChatView({
  initialMessages,
  cookingSessionId,
  cookingTitle,
}: {
  initialMessages: Message[];
  cookingSessionId: string | null;
  cookingTitle: string | null;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(cookingSessionId);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setError(null);
    setInput('');
    setSending(true);
    setMessages((current) => [
      ...current,
      { id: `local-${current.length}`, role: 'user', content: trimmed },
    ]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: trimmed, cooking_session_id: sessionId }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(
          response.status === 401
            ? 'ログインが切れました。再読み込みしてください。'
            : (body.message ?? '返答を取得できませんでした。'),
        );
      }

      const result = (await response.json()) as {
        reply: string;
        cookingSessionId: string | null;
        inventoryChanged: boolean;
        shoppingSuggestions?: ShoppingSuggestion[];
      };

      setMessages((current) => [
        ...current,
        {
          id: `reply-${current.length}`,
          role: 'assistant',
          content: result.reply,
          suggestions: result.shoppingSuggestions?.length
            ? result.shoppingSuggestions
            : undefined,
        },
      ]);
      if (result.cookingSessionId) setSessionId(result.cookingSessionId);
      // The inventory pages are server-rendered; pull fresh data after a write.
      if (result.inventoryChanged) router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '通信に失敗しました');
    } finally {
      setSending(false);
    }
  }

  return (
    /*
     * Fills the shell's content area and scrolls internally, so the composer
     * sits directly above the nav without being positioned against it.
     */
    <div className="mx-auto flex h-full w-full max-w-md flex-col">
      <header
        className="flex min-h-14 shrink-0 items-center gap-2 border-b border-line bg-bg px-4"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <h1 className="flex-1 text-base font-semibold">AIに相談</h1>
        {sessionId ? (
          <Link
            href={`/cooking/${sessionId}`}
            className="rounded-lg border border-accent/40 px-3 py-2 text-xs text-accent"
          >
            調理画面へ
          </Link>
        ) : null}
      </header>

      {cookingTitle ? (
        <p className="shrink-0 border-b border-line bg-surface px-4 py-2 text-xs text-muted">
          調理中: <span className="text-fg">{cookingTitle}</span>
        </p>
      ) : null}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4">
        {messages.length === 0 ? (
          <div className="pt-6">
            <p className="text-center text-sm text-faint">
              在庫を見て、作れるものを提案します。
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  className="min-h-11 rounded-full border border-line px-4 text-sm text-fg active:bg-surface-2"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) => (
          <div key={message.id} className="space-y-2">
            <Bubble role={message.role} content={message.content} />
            {message.suggestions ? (
              <SuggestionCard suggestions={message.suggestions} />
            ) : null}
          </div>
        ))}

        {sending ? (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-surface px-4 py-3 text-sm text-faint">考え中…</div>
          </div>
        ) : null}

        {error ? <p className="text-center text-sm text-danger">{error}</p> : null}

        <VoicePanel
          onToolEffect={(effect) => {
            // Navigating would kill the live call mid-sentence, so surface the
            // 「調理画面へ」 header link instead and let the user switch over.
            if (effect.effect === 'session_changed' && effect.sessionId) {
              setSessionId(effect.sessionId);
            }
            router.refresh();
          }}
        />

        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
        className="flex shrink-0 gap-2 border-t border-line bg-bg px-3 py-2"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="今日なに作れる？"
          enterKeyHint="send"
          className="min-h-12 flex-1 rounded-xl border border-line bg-surface px-3 text-fg placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || input.trim() === ''}
          className="min-h-12 rounded-xl bg-accent px-5 font-bold text-on-accent disabled:opacity-40"
        >
          送信
        </button>
      </form>
    </div>
  );
}

function Bubble({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  const isUser = role === 'user';

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5 whitespace-pre-wrap',
          isUser
            ? 'bg-accent text-on-accent rounded-br-md'
            : 'bg-surface text-fg rounded-bl-md',
        )}
      >
        {content}
      </div>
    </div>
  );
}
