/**
 * A tiny in-memory stand-in for the subset of the Supabase JS client that the
 * service layer uses.
 *
 * It is not a Postgres emulator — it exists so the state machines (quantity
 * arithmetic, step transitions, transaction logging) can be tested end-to-end
 * through the real service functions without a live database. RLS is not
 * simulated; every query filters on `user_id` explicitly, which is what the
 * services do.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

type Filter = { column: string; op: 'eq' | 'neq' | 'in' | 'lte' | 'gte' | 'isNull' | 'notNull'; value: unknown };
type Sort = { column: string; ascending: boolean };

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

/**
 * Unique constraints the real schema enforces. Without these the fake would
 * happily accept a duplicate claim and an idempotency test would pass against
 * a guard that does not actually hold in Postgres.
 */
const UNIQUE_KEYS: Record<string, { columns: string[]; where?: (row: Row) => boolean }> = {
  ai_tool_calls: { columns: ['user_id', 'call_id'] },
  profiles: { columns: ['id'] },
  // Partial, exactly as migration 0006 declares it: one *active* conversation
  // per user. Without the predicate a user could never open a second
  // conversation, which is the opposite of what the index says.
  conversation_sessions: {
    columns: ['user_id'],
    where: (row) => row.status === 'active',
  },
};

/** Column defaults the real schema would apply on insert. */
const TABLE_DEFAULTS: Record<string, () => Row> = {
  inventory_items: () => ({ quantity_state: 'available', opened: false, quantity: null, unit: null }),
  recipes: () => ({ servings: 1, source_type: 'ai' }),
  cooking_sessions: () => ({ current_step: 0, status: 'active', completed_at: null }),
  inventory_transactions: () => ({ source: 'manual', quantity_delta: null }),
  conversation_sessions: () => ({ status: 'active' }),
  conversation_messages: () => ({ tool_calls: null, tool_call_id: null }),
  profiles: () => ({ locale: 'ja-JP', preferred_heat_scale: 'ih_10', cooking_skill_level: 'beginner' }),
};

type Result = { data: unknown; error: { message: string; code?: string } | null };

class Query implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private sorts: Sort[] = [];
  private limitCount: number | null = null;
  private rowMode: 'many' | 'single' | 'maybeSingle' = 'many';
  private returnRows = false;

  constructor(
    private readonly tables: Tables,
    private readonly table: string,
    private readonly operation: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload?: Row,
    private readonly upsertOptions?: { ignoreDuplicates?: boolean },
  ) {
    if (operation === 'select') this.returnRows = true;
  }

  select(): this {
    this.returnRows = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ column, op: 'neq', value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ column, op: 'in', value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ column, op: 'lte', value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ column, op: 'gte', value });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator === 'is' && value === null) {
      this.filters.push({ column, op: 'notNull', value: null });
    }
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.sorts.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): this {
    this.rowMode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.rowMode = 'maybeSingle';
    return this;
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    return (this.tables[this.table] ??= []);
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      const value = row[filter.column];
      switch (filter.op) {
        case 'eq':
          return value === filter.value;
        case 'neq':
          return value !== filter.value;
        case 'in':
          return (filter.value as unknown[]).includes(value);
        case 'lte':
          return value !== null && value !== undefined && String(value) <= String(filter.value);
        case 'gte':
          return value !== null && value !== undefined && String(value) >= String(filter.value);
        case 'notNull':
          return value !== null && value !== undefined;
        default:
          return true;
      }
    });
  }

  private run(): Result {
    const store = this.rows();

    if (this.operation === 'insert') {
      const now = new Date().toISOString();
      const row: Row = {
        id: nextId(),
        created_at: now,
        updated_at: now,
        started_at: now,
        ...(TABLE_DEFAULTS[this.table]?.() ?? {}),
        ...this.payload,
      };

      const unique = UNIQUE_KEYS[this.table];
      if (unique && (unique.where?.(row) ?? true)) {
        const clash = store.find(
          (existing) =>
            (unique.where?.(existing) ?? true) &&
            unique.columns.every((column) => existing[column] === row[column]),
        );
        if (clash) {
          // `upsert(..., { ignoreDuplicates: true })` yields no rows; a plain
          // insert raises 23505.
          if (this.upsertOptions?.ignoreDuplicates) return this.shape([]);
          return {
            data: null,
            error: {
              code: '23505',
              message: `duplicate key value violates unique constraint on ${this.table}`,
            },
          };
        }
      }

      store.push(row);
      return this.shape([row]);
    }

    const matched = store.filter((row) => this.matches(row));

    if (this.operation === 'update') {
      for (const row of matched) Object.assign(row, this.payload, { updated_at: new Date().toISOString() });
      return this.shape(matched);
    }

    if (this.operation === 'delete') {
      for (const row of matched) store.splice(store.indexOf(row), 1);
      return this.shape(matched);
    }

    let selected = [...matched];
    for (const sort of [...this.sorts].reverse()) {
      selected.sort((a, b) => {
        const left = a[sort.column];
        const right = b[sort.column];
        if (left === right) return 0;
        if (left === null || left === undefined) return 1;
        if (right === null || right === undefined) return -1;
        const order = String(left) < String(right) ? -1 : 1;
        return sort.ascending ? order : -order;
      });
    }
    if (this.limitCount !== null) selected = selected.slice(0, this.limitCount);

    return this.shape(selected);
  }

  private shape(rows: Row[]): Result {
    if (!this.returnRows) return { data: null, error: null };

    if (this.rowMode === 'single') {
      return rows.length === 1
        ? { data: clone(rows[0]), error: null }
        : { data: null, error: { message: `expected exactly one row, got ${rows.length}` } };
    }
    if (this.rowMode === 'maybeSingle') {
      return rows.length > 0 ? { data: clone(rows[0]), error: null } : { data: null, error: null };
    }
    return { data: rows.map(clone), error: null };
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createFakeSupabase(seed: Tables = {}) {
  const tables: Tables = clone(seed);

  const client = {
    from(table: string) {
      return {
        select: () => new Query(tables, table, 'select'),
        insert: (payload: Row) => new Query(tables, table, 'insert', payload),
        update: (payload: Row) => new Query(tables, table, 'update', payload),
        upsert: (payload: Row, options?: { ignoreDuplicates?: boolean }) =>
          new Query(tables, table, 'insert', payload, options),
        delete: () => new Query(tables, table, 'delete'),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, tables };
}
