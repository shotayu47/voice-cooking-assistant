import { describe, expect, it } from 'vitest';

import { isVoiceDebugEnabled } from './debug-flag';

/**
 * The diagnostic control must be invisible during ordinary cooking. A stray
 * "音声診断をコピー" button next to the mic toggle would be a worse bug than
 * the one it exists to investigate.
 */

describe('isVoiceDebugEnabled', () => {
  it('is on for ?voiceDebug=1', () => {
    expect(isVoiceDebugEnabled('?voiceDebug=1')).toBe(true);
  });

  it('is on when other parameters are present too', () => {
    expect(isVoiceDebugEnabled('?foo=bar&voiceDebug=1')).toBe(true);
  });

  it('is off with no query string at all', () => {
    expect(isVoiceDebugEnabled('')).toBe(false);
    expect(isVoiceDebugEnabled(null)).toBe(false);
    expect(isVoiceDebugEnabled(undefined)).toBe(false);
  });

  it('is off for any value other than 1', () => {
    // Only the exact opt-in counts, so a stale or copied link cannot half-enable it.
    expect(isVoiceDebugEnabled('?voiceDebug=0')).toBe(false);
    expect(isVoiceDebugEnabled('?voiceDebug=true')).toBe(false);
    expect(isVoiceDebugEnabled('?voiceDebug=')).toBe(false);
    expect(isVoiceDebugEnabled('?voiceDebug')).toBe(false);
  });

  it('is off for a similarly named parameter', () => {
    expect(isVoiceDebugEnabled('?voiceDebugging=1')).toBe(false);
    expect(isVoiceDebugEnabled('?debug=1')).toBe(false);
  });

  it('is off rather than throwing on malformed input', () => {
    expect(isVoiceDebugEnabled('%%%')).toBe(false);
  });
});
