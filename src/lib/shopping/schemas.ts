import { z } from 'zod';

/** Server-side validation for every shopping-list write path. */

/**
 * A name is the only thing a shopping line needs.
 *
 * `quantity` and `unit` travel together: a unit with no quantity ("g") carries
 * no information, and the database rejects it too
 * (`shopping_items_unit_needs_quantity`). Validating it here as well means the
 * caller gets a Japanese message instead of a Postgres constraint name.
 */
export const createShoppingItemSchema = z
  .object({
    name: z.string().trim().min(1, '品名を入力してください').max(100),
    quantity: z
      .number()
      .positive('数量は0より大きい数で入力してください')
      .finite('数量が正しくありません')
      .optional()
      .nullable(),
    unit: z
      .string()
      .trim()
      .max(20)
      .optional()
      .nullable()
      .transform((value) => (value === '' ? null : (value ?? null))),
  })
  // `quantity` is optional *and* nullable, so "no quantity" arrives as either
  // `undefined` (field omitted) or `null` (field cleared). Testing only against
  // null let an omitted quantity through with a unit attached.
  .refine((value) => value.unit === null || (value.quantity !== null && value.quantity !== undefined), {
    message: '単位を使うときは数量も入力してください',
    path: ['unit'],
  });

export type CreateShoppingItemInput = z.input<typeof createShoppingItemSchema>;

export const setShoppingItemCheckedSchema = z.object({
  item_id: z.uuid(),
  checked: z.boolean(),
});

export const deleteShoppingItemSchema = z.object({
  item_id: z.uuid(),
});
