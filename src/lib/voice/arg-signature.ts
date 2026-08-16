/**
 * Were two calls to the same tool made with the same arguments?
 *
 * The device showed `search_meal_candidates` running three times in one turn,
 * and the trace could not say whether the model was refining a query or asking
 * the identical question again — the arguments are redacted, and rightly so.
 *
 * This answers the question without keeping the answer's ingredients: the
 * arguments are canonicalised, reduced to a digest, and only ever compared.
 * The digest is never logged; what reaches the trace is SAME, DIFFERENT, or
 * FIRST. Past calls cannot be reconstructed from any of it.
 */

export type ArgumentComparison = 'FIRST' | 'SAME' | 'DIFFERENT' | 'UNREADABLE';

/**
 * Key order varies between model emissions for the same logical call, so it is
 * normalised before hashing — otherwise every call would read as DIFFERENT.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalise((value as Record<string, unknown>)[key])]);
  }
  return value;
}

/** FNV-1a. Small, deterministic, and one-way enough for an equality check. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * A digest of one call's arguments.
 *
 * Returns null for anything unparseable, so a malformed payload is reported
 * as UNREADABLE rather than silently compared as a string.
 */
export function argumentSignature(rawArguments: string): string | null {
  try {
    return digest(JSON.stringify(canonicalise(JSON.parse(rawArguments))));
  } catch {
    return null;
  }
}

/** Compares against the previous signature for the same tool. */
export function compareSignature(
  previous: string | null | undefined,
  current: string | null,
): ArgumentComparison {
  if (current === null) return 'UNREADABLE';
  if (previous == null) return 'FIRST';
  return previous === current ? 'SAME' : 'DIFFERENT';
}
