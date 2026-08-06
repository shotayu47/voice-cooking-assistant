import { z } from 'zod';

import {
  CATEGORIES,
  QUANTITY_STATES,
  STORAGE_LOCATIONS,
} from '@/types/domain';
import { EXPIRY_KINDS } from './freshness';

/** Server-side validation for every inventory write path (UI and AI alike). */

const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .nullable()
  .transform((value) => (value === '' ? null : (value ?? null)));

/** YYYY-MM-DD, with an empty form field treated as "not set". */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式です')
  .optional()
  .nullable()
  .or(z.literal('').transform(() => null));

export const createInventoryItemSchema = z.object({
  // Name alone is enough (SPEC §4.1, §8.2).
  name: z.string().trim().min(1, '食材名を入力してください').max(100),
  category: z.enum(CATEGORIES).optional().nullable(),
  quantity: z.number().nonnegative().finite().optional().nullable(),
  unit: optionalText,
  quantity_state: z.enum(QUANTITY_STATES).default('available'),
  storage_location: z.enum(STORAGE_LOCATIONS).optional().nullable(),
  expiry_date: isoDate,
  opened: z.boolean().optional().default(false),
  notes: z.string().trim().max(500).optional().nullable(),

  // PHASE 1 — expiry tracking.
  purchased_at: isoDate,
  opened_at: isoDate,
  expiry_kind: z.enum(EXPIRY_KINDS).optional().nullable(),
});

export type CreateInventoryItemInput = z.input<typeof createInventoryItemSchema>;

export const updateInventoryItemSchema = createInventoryItemSchema
  .partial()
  .extend({ name: z.string().trim().min(1).max(100).optional() });

export type UpdateInventoryItemInput = z.input<typeof updateInventoryItemSchema>;

export const consumeInventoryItemSchema = z.object({
  item_id: z.uuid(),
  amount: z.number().positive().finite().optional().nullable(),
  unit: optionalText,
  consume_all: z.boolean().optional().default(false),
});

export const adjustQuantitySchema = z.object({
  item_id: z.uuid(),
  delta: z.number().finite().refine((value) => value !== 0, '増減量が0です'),
});

export const setQuantityStateSchema = z.object({
  item_id: z.uuid(),
  quantity_state: z.enum(QUANTITY_STATES),
});
