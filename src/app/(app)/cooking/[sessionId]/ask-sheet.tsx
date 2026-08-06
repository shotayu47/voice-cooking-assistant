'use client';

import { useState } from 'react';

/**
 * In-cooking question sheet. Asking must never move the step on its own —
 * the backend caps step moves per turn, and the caller re-reads the real step
 * once the turn finishes.
 */
const QUICK_QUESTIONS = [
  '火力どれくらい？',
  'あと何分？',
  '何グラム？',
  'もう一回言って',
  'これ焦げそう',
];

export function AskSheet({
  sessionId,
  onClose,
  onTurnComplete,
}: {
  sessionId: string;
  onClose: () => void;
  onTurnComplete: () => void;
}) {
  const [input, setInput] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setError(null);
    setReply(null);

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
            ? 'ログインが切れました。画面を再読み込みしてください。'
            : (body.message ?? '返答を取得できませんでした'),
        );
      }

      const result = (await response.json()) as { reply: string };
      setReply(result.reply);
      setInput('');
      onTurnComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '通信に失敗しました');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/70">
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="flex-1"
      />

      <div
        className="rounded-t-2xl border-t border-line bg-surface px-4 pt-4"
        style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted">AIに質問</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 px-2 text-sm text-faint"
          >
            閉じる
          </button>
        </div>

        {reply ? (
          <p className="mb-3 rounded-xl bg-bg px-4 py-3 whitespace-pre-wrap">{reply}</p>
        ) : null}
        {error ? <p className="mb-3 text-sm text-danger">{error}</p> : null}
        {sending ? <p className="mb-3 text-sm text-faint">考え中…</p> : null}

        <div className="mb-3 flex flex-wrap gap-2">
          {QUICK_QUESTIONS.map((question) => (
            <button
              key={question}
              type="button"
              disabled={sending}
              onClick={() => void ask(question)}
              className="min-h-11 rounded-full border border-line px-4 text-sm active:bg-surface-2 disabled:opacity-40"
            >
              {question}
            </button>
          ))}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void ask(input);
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="質問を入力"
            enterKeyHint="send"
            className="min-h-12 flex-1 rounded-xl border border-line bg-bg px-3 text-fg placeholder:text-faint focus:border-accent focus:outline-none"
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
    </div>
  );
}
