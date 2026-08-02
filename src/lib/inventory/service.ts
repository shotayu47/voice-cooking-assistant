import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  InventoryItem,
  QuantityState,
  TransactionAction,
  TransactionSource,
} from '@/types/domain';
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

const ITEM_COLUMNS =
  'id, user_id, name, normalized_name, category, quantity, unit, quantity_state, storage_location, expiry_date, opened, notes, created_at, updated_at';

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

  const { data, error } = await query;
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
      expiry_date: parsed.expiry_date ?? null,
      opened: parsed.opened ?? false,
      notes: parsed.notes ?? null,
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
  ] as const) {
    if (parsed[key] !== undefined) update[key] = parsed[key];
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
  input: { itemId: string; amount?: number | null; unit?: string | null; consumeAll?: boolean },
  source: TransactionSource = 'manual',
): Promise<MutationResult> {
  const previous = await getInventoryItem(ctx, input.itemId);
  if (!previous) throw new ServiceError('食材が見つかりません');

  const outcome = applyConsumption(previous, {
    amount: input.amount,
    unit: input.unit,
    consumeAll: input.consumeAll,
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

/** Items expiring within `days`, soonest first. Drives the home screen. */
export async function listExpiringSoon(ctx: ServiceContext, days = 3) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select(ITEM_COLUMNS)
    .eq('user_id', ctx.userId)
    .neq('quantity_state', 'empty')
    .not('expiry_date', 'is', null)
    .lte('expiry_date', cutoff.toISOString().slice(0, 10))
    .order('expiry_date', { ascending: true })
    .limit(10);

  if (error) throw new ServiceError(error.message);
  return ((data ?? []) as InventoryItem[]).filter(isAvailable);
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
