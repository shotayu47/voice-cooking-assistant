'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import type { ShoppingFormState } from '@/lib/shopping/actions-core';

import { addShoppingItemAction } from './actions';

/**
 * Add one line to the list.
 *
 * A name on its own is the common case — 「牛乳」 with no amount — so the
 * quantity and unit share one narrower row below it and stay optional.
 */
export function AddShoppingItemForm() {
  const [state, formAction, pending] = useActionState(
    addShoppingItemAction,
    {} as ShoppingFormState,
  );

  const formRef = useRef<HTMLFormElement>(null);
  const lastAdded = useRef(0);
  // Caught before the round trip. The server checks the same rules again — this
  // only saves the user a wait to be told something the page already knew.
  const [clientError, setClientError] = useState<string | null>(null);

  // Clear only on a *new* success. `useActionState` returns the same state
  // object across re-renders, so resetting whenever `added` is truthy would
  // wipe the boxes again every time the list around it re-rendered.
  useEffect(() => {
    const added = state.added ?? 0;
    if (added > lastAdded.current) {
      lastAdded.current = added;
      formRef.current?.reset();
      setClientError(null);
      field(formRef.current, 'name')?.focus();
    }
  }, [state.added]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const quantity = field(form, 'quantity')?.value.trim() ?? '';
    const unit = field(form, 'unit')?.value.trim() ?? '';

    if (unit !== '' && quantity === '') {
      // React runs the form action unless the submit is prevented here.
      event.preventDefault();
      setClientError('単位を使うときは数量も入力してください');
      field(form, 'quantity')?.focus();
      return;
    }

    setClientError(null);
  }

  const kept = state.values;
  const error = clientError ?? state.error;

  return (
    <form ref={formRef} action={formAction} onSubmit={handleSubmit} className="space-y-3">
      <Field label="品名">
        <Input
          name="name"
          required
          maxLength={100}
          enterKeyHint="done"
          placeholder="牛乳"
          defaultValue={kept?.name ?? ''}
          aria-describedby="shopping-form-status"
        />
      </Field>

      <div className="flex gap-3">
        <div className="w-28 shrink-0">
          <Field label="数量">
            <Input
              name="quantity"
              // `decimal` keeps the dot on the iOS pad — 「0.5」 is a real
              // amount, and `numeric` would hide it.
              inputMode="decimal"
              enterKeyHint="done"
              placeholder="任意"
              defaultValue={kept?.quantity ?? ''}
            />
          </Field>
        </div>
        <div className="flex-1">
          <Field label="単位">
            <Input
              name="unit"
              maxLength={20}
              enterKeyHint="done"
              placeholder="任意（個・本・g）"
              defaultValue={kept?.unit ?? ''}
            />
          </Field>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {state.warning ? (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
          {state.warning}
        </p>
      ) : null}

      {/*
       * One live region for both outcomes. Only its text changes, so a
       * re-render carrying the same message is not read out again.
       */}
      <p id="shopping-form-status" aria-live="polite" className="sr-only">
        {error ?? state.warning ?? ''}
      </p>

      <Button type="submit" variant="primary" size="lg" block disabled={pending}>
        {pending ? '追加中…' : 'リストに追加'}
      </Button>
    </form>
  );
}

/** The named control, when it is a text box. */
function field(form: HTMLFormElement | null, name: string): HTMLInputElement | null {
  const element = form?.elements.namedItem(name);
  return element instanceof HTMLInputElement ? element : null;
}
