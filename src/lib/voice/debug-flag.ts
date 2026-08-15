/**
 * Whether the voice diagnostic UI is switched on.
 *
 * Off unless `?voiceDebug=1` is present. Kept as a pure function so the rule
 * can be tested, and so the panel has exactly one place deciding it — a
 * diagnostic control that leaks into the normal cooking screen would be worse
 * than having no diagnostics at all.
 */
export function isVoiceDebugEnabled(search: string | null | undefined): boolean {
  if (!search) return false;

  try {
    return new URLSearchParams(search).get('voiceDebug') === '1';
  } catch {
    return false;
  }
}
