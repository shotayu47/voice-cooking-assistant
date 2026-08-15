/**
 * A redacted trace of one voice call, for diagnosing turns that stall.
 *
 * The failure being chased is a *sequence* — an interruption, a cancel, a
 * response that was asked for and never arrived — and none of it needs the
 * content of anything. So this records shape only, and the redaction is
 * enforced here rather than left to each call site.
 *
 * Two rules make that hold:
 *
 *  1. an allowlist decides which fields may be recorded at all; anything else
 *     is dropped rather than serialised;
 *  2. every identifier is replaced by a per-call alias (`R1`, `C2`) before it
 *     is stored. No server-generated id is ever written down, and a string
 *     that arrives in an id field becomes an alias rather than text — so even
 *     a mistake at the call site cannot put a transcript in the output.
 *
 * Never recorded: audio, transcripts, tool arguments or results, inventory,
 * recipes, shopping items, email, user ids, cookies, tokens, keys, or raw
 * event payloads.
 *
 * Held in memory only, bounded, and never written to a database or shipped
 * anywhere. It leaves the device only if the user copies it themselves.
 */

/** Which side of the data channel an entry came from. */
export type Direction = 'in' | 'out' | 'internal';

export type LoggedEvent = {
  /** Sequence number, so ordering survives copy/paste. */
  n: number;
  /** Milliseconds since the log was created. */
  t: number;
  dir: Direction;
  event: string;
  /** Aliases, never raw ids. */
  resp?: string;
  call?: string;
  item?: string;
  /** The response the turn considered active, as an alias. */
  active?: string;
  /** The response a cancel is outstanding for. */
  cancelWaiting?: string;
  status?: string;
  code?: string;
  tool?: string;
  /** Reducer phase either side of this event. */
  from?: string;
  to?: string;
  pendingLiveness?: boolean;
  /** Whether an outbound payload actually reached the channel. */
  sent?: boolean;
  reason?: string;
  ms?: number;
};

/** Fields carrying an identifier. Aliased before storage. */
const ID_FIELDS = new Set(['resp', 'call', 'item', 'active', 'cancelWaiting']);
/** Short, bounded, non-identifying strings. */
const TEXT_FIELDS = new Set(['status', 'code', 'tool', 'from', 'to', 'reason']);
const BOOL_FIELDS = new Set(['pendingLiveness', 'sent']);
const NUM_FIELDS = new Set(['ms']);

const MAX_ENTRIES = 400;
const MAX_TEXT = 40;

/** `resp`/`active`/`cancelWaiting` share one namespace so they correlate. */
function aliasPrefix(field: string): string {
  if (field === 'call') return 'C';
  if (field === 'item') return 'I';
  return 'R';
}

export type EventLog = {
  add: (dir: Direction, event: string, fields?: Record<string, unknown>) => void;
  entries: () => LoggedEvent[];
  clear: () => void;
};

export function createEventLog(now: () => number = () => Date.now()): EventLog {
  const started = now();
  let entries: LoggedEvent[] = [];
  let sequence = 0;

  /** raw id -> alias, per prefix. Raw ids never leave this closure. */
  const aliases = new Map<string, string>();
  const counts = new Map<string, number>();

  function alias(field: string, raw: unknown): string | undefined {
    if (raw == null) return undefined;
    const prefix = aliasPrefix(field);
    // Anything non-string is still keyed, so a stray object cannot be stored.
    const key = `${prefix}:${String(raw)}`;

    const existing = aliases.get(key);
    if (existing) return existing;

    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    const value = `${prefix}${next}`;
    aliases.set(key, value);
    return value;
  }

  return {
    add(dir, event, fields = {}) {
      sequence += 1;
      const entry: LoggedEvent = {
        n: sequence,
        t: now() - started,
        dir,
        event: String(event).slice(0, MAX_TEXT),
      };

      for (const [key, value] of Object.entries(fields)) {
        if (value == null) continue;

        if (ID_FIELDS.has(key)) {
          const value_ = alias(key, value);
          if (value_) entry[key as 'resp' | 'call' | 'item' | 'active' | 'cancelWaiting'] = value_;
          continue;
        }
        if (TEXT_FIELDS.has(key)) {
          if (typeof value === 'string') {
            entry[key as 'status' | 'code' | 'tool' | 'from' | 'to' | 'reason'] = value.slice(
              0,
              MAX_TEXT,
            );
          }
          continue;
        }
        if (BOOL_FIELDS.has(key)) {
          entry[key as 'pendingLiveness' | 'sent'] = Boolean(value);
          continue;
        }
        if (NUM_FIELDS.has(key)) {
          if (typeof value === 'number' && Number.isFinite(value)) entry.ms = Math.round(value);
          continue;
        }
        // Not on the allowlist. Dropped — this is what keeps a transcript out
        // when someone spreads a raw event in.
      }

      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    },

    entries: () => [...entries],
    clear: () => {
      entries = [];
      sequence = 0;
      aliases.clear();
      counts.clear();
    },
  };
}

const ARROW: Record<Direction, string> = { in: '<-', out: '->', internal: '  ' };

/** One line per event, for pasting into a bug report. */
export function formatEventLog(entries: LoggedEvent[]): string {
  const header = [
    '# voice trace (redacted: no audio, transcripts, tool data, or ids)',
    `# entries: ${entries.length}`,
    '',
  ].join('\n');

  const lines = entries.map((entry) => {
    const parts = [
      String(entry.n).padStart(4),
      `${String(entry.t).padStart(7)}ms`,
      ARROW[entry.dir],
      entry.event,
    ];

    if (entry.from || entry.to) parts.push(`phase=${entry.from ?? '?'}>${entry.to ?? '?'}`);
    if (entry.status) parts.push(`status=${entry.status}`);
    if (entry.code) parts.push(`code=${entry.code}`);
    if (entry.tool) parts.push(`tool=${entry.tool}`);
    if (entry.resp) parts.push(`resp=${entry.resp}`);
    if (entry.call) parts.push(`call=${entry.call}`);
    if (entry.item) parts.push(`item=${entry.item}`);
    if (entry.active) parts.push(`active=${entry.active}`);
    if (entry.cancelWaiting) parts.push(`cancelWaiting=${entry.cancelWaiting}`);
    if (entry.pendingLiveness !== undefined) parts.push(`pendingLiveness=${entry.pendingLiveness}`);
    if (entry.sent !== undefined) parts.push(`sent=${entry.sent}`);
    if (entry.reason) parts.push(`reason=${entry.reason}`);
    if (entry.ms !== undefined) parts.push(`took=${entry.ms}ms`);

    return parts.join(' ');
  });

  return `${header}${lines.join('\n')}`;
}
