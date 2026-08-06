import 'server-only';

import OpenAI from 'openai';

/**
 * Server-side only. OPENAI_API_KEY must never reach a client bundle.
 *
 * The timeout matters more than usual here: a hung completion during cooking
 * leaves someone standing over a hot pan waiting for an answer that will never
 * come. Better to fail in 45s and say so.
 */
export function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  return new OpenAI({ apiKey, timeout: 45_000, maxRetries: 1 });
}

// `OPENAI_MODEL=` (empty) in .env.local must fall back too, hence || not ??.
export const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
