import 'server-only';

import OpenAI from 'openai';

/** Server-side only. OPENAI_API_KEY must never reach a client bundle. */
export function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  return new OpenAI({ apiKey });
}

export const CHAT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1';
