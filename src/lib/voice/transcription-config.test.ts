import { describe, expect, it } from 'vitest';

import { REALTIME_INPUT_TRANSCRIPTION } from './transcription-config';

describe('REALTIME_INPUT_TRANSCRIPTION', () => {
  it('pins Japanese and gives the caption model quantity/unit context', () => {
    expect(REALTIME_INPUT_TRANSCRIPTION.model).toBe('gpt-4o-mini-transcribe');
    expect(REALTIME_INPUT_TRANSCRIPTION.language).toBe('ja');
    expect(REALTIME_INPUT_TRANSCRIPTION.prompt).toContain('数量');
    expect(REALTIME_INPUT_TRANSCRIPTION.prompt).toContain('単位');
    expect(REALTIME_INPUT_TRANSCRIPTION.prompt).toContain('個');
    expect(REALTIME_INPUT_TRANSCRIPTION.prompt).toContain('大さじ');
  });
});
