/**
 * Context for the optional captioning model used alongside Realtime audio.
 *
 * The Realtime model still receives the original audio. This configuration
 * improves the user-visible transcript, especially the quantities and units
 * that matter for inventory and shopping writes.
 */
export const REALTIME_INPUT_TRANSCRIPTION = {
  model: 'gpt-4o-mini-transcribe',
  language: 'ja',
  prompt:
    '料理と買い物に関する日本語の会話です。食材名と、数量・数字・単位（個、本、袋、g、kg、ml、L、大さじ、小さじ）を省略せず正確に書き起こしてください。',
} as const;
