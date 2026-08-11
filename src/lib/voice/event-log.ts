/**
 * A redacted trace of one voice call, for diagnosing turns that stall.
 *
 * The failure being chased is a *sequence* — a commit with no response, a tool
 * whose output never landed, a continuation that collided with an
 * automatically created response. None of that is visible from a single event,
 * and none of it needs the content of anything.
 *
 * So this records shape only, and the redaction is enforced here rather than
 * left to each call site: event name, timestamp, ids, tool name, status,
 * elapsed. Never audio, never transcripts, never tool arguments or results,
 * never credentials, never inventory or recipe data.
 */

export type LoggedEvent = {
  /** Milliseconds since the call started, so entries read as a sequence. */
  t: number;
  event: string;
  responseId?: string;
  callId?: string;
  itemId?: string;
  tool?: string;
  status?: string;
  /** Milliseconds the step took, where that is meaningful. */
  ms?: number;
  phase?: string;
};

/** Fields that may be recorded. Anything else is dropped, not trusted. */
const ALLOWED = new Set(['responseId', 'callId', 'itemId', 'tool', 'status', 'ms', 'phase']);

const MAX_ENTRIES = 300;

export type EventLog = {
  add: (event: string, fields?: Record<string, unknown>) => void;
  entries: () => LoggedEvent[];
  clear: () => void;
};

/**
 * Ids are opaque and safe, but they are long and there is no reason to keep
 * more than enough to correlate two lines.
 */
function shortId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length <= 24 ? value : `${value.slice(0, 24)}…`;
}

export function createEventLog(now: () => number = () => Date.now()): EventLog {
  const started = now();
  let entries: LoggedEvent[] = [];

  return {
    add(event, fields = {}) {
      const entry: LoggedEvent = { t: now() - started, event };

      for (const [key, value] of Object.entries(fields)) {
        // An unrecognised key is dropped rather than serialised: that is what
        // stops a transcript arriving here because someone spread an event in.
        if (!ALLOWED.has(key) || value == null) continue;

        if (key === 'ms') {
          if (typeof value === 'number') entry.ms = Math.round(value);
          continue;
        }
        if (key === 'status' || key === 'tool' || key === 'phase') {
          // Bounded, so a status field carrying a sentence cannot smuggle one.
          if (typeof value === 'string') entry[key] = value.slice(0, 40);
          continue;
        }
        const id = shortId(value);
        if (id) entry[key as 'responseId' | 'callId' | 'itemId'] = id;
      }

      entries.push(entry);
      // A long cooking call must not grow this without bound.
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    },

    entries: () => [...entries],
    clear: () => {
      entries = [];
    },
  };
}

/** One line per event, for pasting into a bug report. */
export function formatEventLog(entries: LoggedEvent[]): string {
  return entries
    .map((entry) => {
      const parts = [`${String(entry.t).padStart(6)}ms`, entry.event];
      if (entry.phase) parts.push(`phase=${entry.phase}`);
      if (entry.tool) parts.push(`tool=${entry.tool}`);
      if (entry.status) parts.push(`status=${entry.status}`);
      if (entry.responseId) parts.push(`resp=${entry.responseId}`);
      if (entry.callId) parts.push(`call=${entry.callId}`);
      if (entry.itemId) parts.push(`item=${entry.itemId}`);
      if (entry.ms !== undefined) parts.push(`took=${entry.ms}ms`);
      return parts.join(' ');
    })
    .join('\n');
}
