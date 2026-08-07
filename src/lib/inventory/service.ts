import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  InventoryItem,
  QuantityState,
  StorageLocation,
  TransactionAction,
  TransactionSource,
} from '@/types/domain';
import {
  addDays,
  estimateExpiry,
  freshnessOf,
  todayIso,
  type ExpiryKind,
  type ExpirySource,
  type Freshness,
} from './freshness';
import { timed } from '@/lib/perf';
import { normalizeIngredientName, resolveInventoryItem } from './normalize';
import {
  applyConsumption,
  applyDelta,
  applyStateChange,
  isAvailable,
  type ConsumeOutcome,
} from './quantity';
import {
  createInventoryItemSchema,
  updateInventoryItemSchema,
  type CreateInventoryItemInput,
  type UpdateInventoryItemInput,
} from './schemas';

export type ServiceContext = {
  supabase: SupabaseClient;
  userId: string;
};

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * `*` rather than an explicit list so the code keeps running against a
 * database where migration 0003 has not been applied yet — naming the new
 * expiry columns would make every inventory query fail with 42703.
 */
const ITEM_COLUMNS = '*';

/**
 * Fill in `expiry_date` when the user did not give one, and record where the
 * date came from. An estimate must always be labelled: `expiry_source` is what
 * lets the UI show 「推定あと3日」 instead of implying the package said so.
 */
function withExpiryEstimate(
  fields: {
    name: string;
    category?: string | null;
    storage_location?: StorageLocation | null;
    expiry_date?: string | null;
    expiry_kind?: ExpiryKind | null;
    purchased_at?: string | null;
    opened_at?: string | null;
    opened?: boolean | null;
  },
): { expiry_date: string | null; expiry_kind: ExpiryKind | null; expiry_source: ExpirySource } {
  if (fields.expiry_date) {
    return {
      expiry_date: fields.expiry_date,
      expiry_kind: fields.expiry_kind ?? null,
      expiry_source: 'user',
    };
  }

  const estimate = estimateExpiry({
    name: fields.name,
    category: fields.category ?? null,
    storageLocation: fields.storage_location ?? null,
    purchasedAt: fields.purchased_at,
    openedAt: fields.opened_at,
    opened: fields.opened,
  });

  if (!estimate) {
    return { expiry_date: null, expiry_kind: fields.expiry_kind ?? null, expiry_source: 'unknown' };
  }

  return {
    expiry_date: estimate.date,
    expiry_kind: fields.expiry_kind ?? estimate.kind,
    expiry_source: 'estimated',
  };
}

export async function listInventory(
  ctx: ServiceContext,
  options: { category?: string | null; includeEmpty?: boolean } = {},
): Promise<InventoryItem[]> {
  let query = ctx.supabase
    .from('inventory_items')
    .select(ITEM_COLUMNS)
    .eq('user_id', ctx.userId)
    .order('category', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });

  if (options.category) query = query.eq('category', options.category);
  if (!options.includeEmpty) query = query.neq('quantity_state', 'empty');

  const { data, error } = await timed('db:listInventory', async () => query);
  if (error) throw new ServiceError(error.message);
  return (data ?? []) as InventoryItem[];
}

export async function getInventoryItem(
  ctx: ServiceContext,
  id: string,
): Promise<InventoryItem | null> {
  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select(ITEM_COLUMNS)
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new ServiceError(error.message);
  return (data as InventoryItem | null) ?? null;
}

export async function createInventoryItem(
  ctx: ServiceContext,
  input: CreateInventoryItemInput,
  source: TransactionSource = 'manual',
): Promise<InventoryItem> {
  const parsed = createInventoryItemSchema.parse(input);

  // Most items are registered with a name and nothing else, so the expiry is
  // estimated here rather than asked for.
  const purchasedAt = parsed.purchased_at ?? todayIso();
  const expiry = withExpiryEstimate({
    name: parsed.name,
    category: parsed.category,
    storage_location: parsed.storage_location,
    expiry_date: parsed.expiry_date,
    expiry_kind: parsed.expiry_kind,
    purchased_at: purchasedAt,
    opened_at: parsed.opened_at,
    opened: parsed.opened,
  });

  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .insert({
      user_id: ctx.userId,
      name: parsed.name,
      normalized_name: normalizeIngredientName(parsed.name),
      category: parsed.category ?? null,
      quantity: parsed.quantity ?? null,
      unit: parsed.unit ?? null,
      quantity_state: parsed.quantity_state,
      storage_location: parsed.storage_location ?? null,
      opened: parsed.opened ?? false,
      notes: parsed.notes ?? null,
      purchased_at: purchasedAt,
      opened_at: parsed.opened_at ?? (parsed.opened ? purchasedAt : null),
      ...expiry,
    })
    .select(ITEM_COLUMNS)
    .single();

  if (error) throw new ServiceError(error.message);

  const item = data as InventoryItem;
  await logTransaction(ctx, {
    itemId: item.id,
    action: 'create',
    previous: null,
    next: item,
    source,
  });

  return item;
}

export async function updateInventoryItem(
  ctx: ServiceContext,
  id: string,
  patch: UpdateInventoryItemInput,
  source: TransactionSource = 'manual',
): Promise<InventoryItem> {
  const parsed = updateInventoryItemSchema.parse(patch);
  const previous = await getInventoryItem(ctx, id);
  if (!previous) throw new ServiceError('食材が見つかりません');

  const update: Record<string, unknown> = {};
  if (parsed.name !== undefined) {
    update.name = parsed.name;
    update.normalized_name = normalizeIngredientName(parsed.name);
  }
  for (const key of [
    'category',
    'quantity',
    'unit',
    'quantity_state',
    'storage_location',
    'expiry_date',
    'opened',
    'notes',
    'purchased_at',
    'opened_at',
    'expiry_kind',
  ] as const) {
    if (parsed[key] !== undefined) update[key] = parsed[key];
  }

  // Opening something usually shortens its life, so record when it happened.
  if (parsed.opened === true && !previous.opened && parsed.opened_at === undefined) {
    update.opened_at = todayIso();
  }

  if (parsed.expiry_date !== undefined && parsed.expiry_date !== null) {
    // A date the user typed is fact from now on.
    update.expiry_source = 'user';
  } else if (
    // Storage or opened state changed and the current date was only a guess —
    // re-estimate rather than leave a stale one.
    previous.expiry_source === 'estimated' &&
    (parsed.storage_location !== undefined ||
      parsed.opened !== undefined ||
      parsed.purchased_at !== undefined ||
      parsed.name !== undefined)
  ) {
    const merged = { ...previous, ...update } as InventoryItem;
    const re = withExpiryEstimate({
      name: merged.name,
      category: merged.category,
      storage_location: merged.storage_location,
      expiry_date: null,
      expiry_kind: merged.expiry_kind,
      purchased_at: merged.purchased_at,
      opened_at: (update.opened_at as string | undefined) ?? merged.opened_at,
      opened: merged.opened,
    });
    Object.assign(update, re);
  }

  if (Object.keys(update).length === 0) return previous;

  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .update(update)
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .select(ITEM_COLUMNS)
    .single();

  if (error) throw new ServiceError(error.message);

  const item = data as InventoryItem;
  await logTransaction(ctx, {
    itemId: item.id,
    action: parsed.quantity !== undefined ? 'set_quantity' : 'set_state',
    previous,
    next: item,
    quantityDelta:
      parsed.quantity !== undefined && previous.quantity !== null
        ? (parsed.quantity ?? 0) - previous.quantity
        : null,
    source,
  });

  return item;
}

export async function deleteInventoryItem(
  ctx: ServiceContext,
  id: string,
  source: TransactionSource = 'manual',
): Promise<void> {
  const previous = await getInventoryItem(ctx, id);
  if (!previous) throw new ServiceError('食材が見つかりません');

  // Log before deleting: the FK is ON DELETE SET NULL, so the audit row
  // survives with the snapshot in `previous_value`.
  await logTransaction(ctx, {
    itemId: id,
    action: 'delete',
    previous,
    next: null,
    source,
  });

  const { error } = await ctx.supabase
    .from('inventory_items')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('id', id);

  if (error) throw new ServiceError(error.message);
}

export type MutationResult =
  | { status: 'applied'; item: InventoryItem }
  | { status: 'needs_clarification'; reason: string };

/**
 * Apply a pure quantity outcome to the database and log it. Shared by
 * consume / adjust / set-state so all three audit identically.
 */
async function commitOutcome(
  ctx: ServiceContext,
  previous: InventoryItem,
  outcome: ConsumeOutcome,
  source: TransactionSource,
): Promise<MutationResult> {
  if (outcome.status === 'needs_clarification') {
    return outcome;
  }

  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .update({
      quantity: outcome.quantity,
      quantity_state: outcome.quantity_state,
    })
    .eq('user_id', ctx.userId)
    .eq('id', previous.id)
    .select(ITEM_COLUMNS)
    .single();

  if (error) throw new ServiceError(error.message);

  const item = data as InventoryItem;
  await logTransaction(ctx, {
    itemId: item.id,
    action: outcome.action,
    previous,
    next: item,
    quantityDelta: outcome.quantityDelta,
    source,
  });

  return { status: 'applied', item };
}

export async function consumeInventoryItem(
  ctx: ServiceContext,
  input: {
    itemId: string;
    amount?: number | null;
    unit?: string | null;
    consumeAll?: boolean;
    /** 「卵あと2個」 — sets the level rather than subtracting. */
    remaining?: number | null;
    /** 「半分使った」 — the share used, 0 < f <= 1. */
    fraction?: number | null;
  },
  source: TransactionSource = 'manual',
): Promise<MutationResult> {
  const previous = await getInventoryItem(ctx, input.itemId);
  if (!previous) throw new ServiceError('食材が見つかりません');

  const outcome = applyConsumption(previous, {
    amount: input.amount,
    unit: input.unit,
    consumeAll: input.consumeAll,
    remaining: input.remaining,
    fraction: input.fraction,
  });

  return commitOutcome(ctx, previous, outcome, source);
}

export async function adjustQuantity(
  ctx: ServiceContext,
  itemId: string,
  delta: number,
  source: TransactionSource = 'manual',
): Promise<MutationResult> {
  const previous = await getInventoryItem(ctx, itemId);
  if (!previous) throw new ServiceError('食材が見つかりません');

  return commitOutcome(ctx, previous, applyDelta(previous, delta), source);
}

export async function setQuantityState(
  ctx: ServiceContext,
  itemId: string,
  state: QuantityState,
  source: TransactionSource = 'manual',
): Promise<MutationResult> {
  const previous = await getInventoryItem(ctx, itemId);
  if (!previous) throw new ServiceError('食材が見つかりません');

  return commitOutcome(ctx, previous, applyStateChange(previous, state), source);
}

/**
 * Find the single inventory item a spoken name refers to. Returns the
 * ambiguity so the caller can ask instead of guessing.
 */
export async function findInventoryItemByName(ctx: ServiceContext, name: string) {
  const items = await listInventory(ctx, { includeEmpty: true });
  return resolveInventoryItem(name, items);
}

export async function listTransactions(ctx: ServiceContext, limit = 50) {
  const { data, error } = await ctx.supabase
    .from('inventory_transactions')
    .select('id, inventory_item_id, action, quantity_delta, previous_value, new_value, source, created_at')
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new ServiceError(error.message);
  return data ?? [];
}

export type UrgentItem = { item: InventoryItem; freshness: Freshness };

/**
 * 「早めに使う食材」 — what should be eaten first (PHASE 1).
 *
 * Includes items whose date is only an estimate; the caller renders the
 * `estimated` flag so a guess is never shown as if it were printed on the
 * package. Already-expired items are included and sort first — hiding them
 * would be the one case where silence is actively unhelpful.
 */
export async function listExpiringSoon(
  ctx: ServiceContext,
  days = 3,
  limit = 10,
): Promise<UrgentItem[]> {
  const today = todayIso();

  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select(ITEM_COLUMNS)
    .eq('user_id', ctx.userId)
    .neq('quantity_state', 'empty')
    .not('expiry_date', 'is', null)
    .lte('expiry_date', addDays(today, days))
    .order('expiry_date', { ascending: true })
    .limit(limit);

  if (error) throw new ServiceError(error.message);

  return ((data ?? []) as InventoryItem[])
    .filter(isAvailable)
    .map((item) => ({ item, freshness: freshnessOf(item, today) }))
    .filter((entry): entry is UrgentItem => entry.freshness !== null);
}

type LogInput = {
  itemId: string | null;
  action: TransactionAction;
  previous: InventoryItem | null;
  next: InventoryItem | null;
  quantityDelta?: number | null;
  source: TransactionSource;
};

/**
 * Append to the audit log. SPEC §19 requires every AI mutation to produce a
 * transaction; manual edits are logged the same way so history is complete.
 */
async function logTransaction(ctx: ServiceContext, input: LogInput): Promise<void> {
  const { error } = await ctx.supabase.from('inventory_transactions').insert({
    user_id: ctx.userId,
    inventory_item_id: input.itemId,
    action: input.action,
    quantity_delta: input.quantityDelta ?? null,
    previous_value: input.previous ? snapshot(input.previous) : null,
    new_value: input.next ? snapshot(input.next) : null,
    source: input.source,
  });

  // A failed audit write must not silently pass — but it also must not undo a
  // committed inventory change. Surface it loudly in logs.
  if (error) {
    console.error('[inventory] failed to log transaction', error.message);
    throw new ServiceError(`在庫履歴の記録に失敗しました: ${error.message}`);
  }
}

function snapshot(item: InventoryItem) {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    quantity_state: item.quantity_state,
    storage_location: item.storage_location,
    expiry_date: item.expiry_date,
  };
}
