'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  QUANTITY_STATE_LABELS,
  STORAGE_LABELS,
} from '@/lib/labels';
import { QUANTITY_STATES, STORAGE_LOCATIONS, type InventoryItem } from '@/types/domain';

import type { FormState } from './actions';

/**
 * Add / edit form (SPEC §5.3). Only the name is required — everything else is
 * optional so registering 「醤油」 stays a two-tap job.
 */
export function ItemForm({
  action,
  item,
  submitLabel,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  item?: InventoryItem;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);

  return (
    <form action={formAction} className="space-y-5">
      {item ? <input type="hidden" name="id" value={item.id} /> : null}

      <Field label="食材名" hint="これだけで登録できます">
        <Input
          name="name"
          required
          maxLength={100}
          autoFocus={!item}
          defaultValue={item?.name ?? ''}
          placeholder="例: 鶏もも肉"
        />
      </Field>

      <Field label="カテゴリ">
        <Select name="category" defaultValue={item?.category ?? ''}>
          <option value="">未設定</option>
          {CATEGORY_ORDER.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="在庫の状態">
        <Select name="quantity_state" defaultValue={item?.quantity_state ?? 'available'}>
          {QUANTITY_STATES.map((value) => (
            <option key={value} value={value}>
              {QUANTITY_STATE_LABELS[value]}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="数量（任意）">
          <Input
            name="quantity"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            defaultValue={item?.quantity ?? ''}
            placeholder="—"
          />
        </Field>
        <Field label="単位（任意）">
          <Input
            name="unit"
            maxLength={20}
            defaultValue={item?.unit ?? ''}
            placeholder="個 / g / ml"
          />
        </Field>
      </div>

      <Field label="保存場所（任意）">
        <Select name="storage_location" defaultValue={item?.storage_location ?? ''}>
          <option value="">未設定</option>
          {STORAGE_LOCATIONS.map((value) => (
            <option key={value} value={value}>
              {STORAGE_LABELS[value]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="賞味期限（任意）">
        <Input name="expiry_date" type="date" defaultValue={item?.expiry_date ?? ''} />
      </Field>

      <label className="flex min-h-12 items-center gap-3 rounded-xl border border-line bg-surface px-3">
        <input
          type="checkbox"
          name="opened"
          defaultChecked={item?.opened ?? false}
          className="size-5 accent-accent"
        />
        <span>開封済み</span>
      </label>

      <Field label="メモ（任意）">
        <Textarea name="notes" maxLength={500} defaultValue={item?.notes ?? ''} />
      </Field>

      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}

      <Button type="submit" variant="primary" size="lg" block disabled={pending}>
        {pending ? '保存中…' : submitLabel}
      </Button>
    </form>
  );
}
