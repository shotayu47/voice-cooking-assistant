'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getServiceContext } from '@/lib/supabase/server';
import {
  adjustQuantity,
  createInventoryItem,
  deleteInventoryItem,
  setQuantityState,
  updateInventoryItem,
} from '@/lib/inventory/service';
import {
  CATEGORIES,
  QUANTITY_STATES,
  STORAGE_LOCATIONS,
  type QuantityState,
} from '@/types/domain';
import { EXPIRY_KINDS } from '@/lib/inventory/freshness';

export type FormState = { error?: string };

/** Turn "" into null so an untouched optional field stays unset. */
function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

function optionalNumber(value: FormDataEntryValue | null): number | null {
  const text = optional(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickEnum<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function readItemForm(formData: FormData) {
  return {
    name: String(formData.get('name') ?? '').trim(),
    category: pickEnum(optional(formData.get('category')), CATEGORIES),
    quantity: optionalNumber(formData.get('quantity')),
    unit: optional(formData.get('unit')),
    quantity_state:
      pickEnum(optional(formData.get('quantity_state')), QUANTITY_STATES) ?? 'available',
    storage_location: pickEnum(optional(formData.get('storage_location')), STORAGE_LOCATIONS),
    expiry_date: optional(formData.get('expiry_date')),
    opened: formData.get('opened') === 'on',
    notes: optional(formData.get('notes')),
    // PHASE 1 — expiry tracking.
    purchased_at: optional(formData.get('purchased_at')),
    opened_at: optional(formData.get('opened_at')),
    expiry_kind: pickEnum(optional(formData.get('expiry_kind')), EXPIRY_KINDS),
  };
}

function toMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? '入力内容を確認してください';
  }
  return error instanceof Error ? error.message : '保存に失敗しました';
}

export async function createItemAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await getServiceContext();

  try {
    await createInventoryItem(ctx, readItemForm(formData), 'manual');
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/inventory');
  revalidatePath('/');
  redirect('/inventory');
}

export async function updateItemAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await getServiceContext();
  const id = String(formData.get('id') ?? '');

  try {
    await updateInventoryItem(ctx, id, readItemForm(formData), 'manual');
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/inventory');
  revalidatePath(`/inventory/${id}`);
  revalidatePath('/');
  redirect('/inventory');
}

export async function deleteItemAction(formData: FormData): Promise<void> {
  const { ctx } = await getServiceContext();
  await deleteInventoryItem(ctx, String(formData.get('id') ?? ''), 'manual');

  revalidatePath('/inventory');
  revalidatePath('/');
  redirect('/inventory');
}

/** Quick +1 / -1 from the list. Returns rather than throws so the row can show it. */
export async function adjustQuantityAction(itemId: string, delta: number) {
  const { ctx } = await getServiceContext();
  const result = await adjustQuantity(ctx, itemId, delta, 'manual');

  revalidatePath('/inventory');
  revalidatePath('/');
  return result;
}

/** 「使い切った」「少ない」「十分ある」. */
export async function setStateAction(itemId: string, state: QuantityState) {
  const { ctx } = await getServiceContext();
  const result = await setQuantityState(ctx, itemId, state, 'manual');

  revalidatePath('/inventory');
  revalidatePath('/');
  return result;
}
