'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import type { Profile } from '@/types/domain';

import { updateProfileAction, type SettingsState } from './actions';

export function SettingsForm({
  profile,
}: {
  profile: Pick<
    Profile,
    'display_name' | 'preferred_heat_scale' | 'cooking_skill_level'
  > | null;
}) {
  const [state, formAction, pending] = useActionState(
    updateProfileAction,
    {} as SettingsState,
  );

  return (
    <form action={formAction} className="space-y-5">
      <Field label="表示名">
        <Input
          name="display_name"
          maxLength={50}
          defaultValue={profile?.display_name ?? ''}
          placeholder="未設定"
        />
      </Field>

      <Field label="火力の基準" hint="AIはこの基準で火力を伝えます">
        <Select
          name="preferred_heat_scale"
          defaultValue={profile?.preferred_heat_scale ?? 'ih_10'}
        >
          <option value="ih_10">IH 10段階</option>
          <option value="low_medium_high">弱火・中火・強火</option>
        </Select>
      </Field>

      <Field label="調理レベル" hint="説明の細かさが変わります">
        <Select
          name="cooking_skill_level"
          defaultValue={profile?.cooking_skill_level ?? 'beginner'}
        >
          <option value="beginner">初心者</option>
          <option value="intermediate">ふつう</option>
          <option value="advanced">慣れている</option>
        </Select>
      </Field>

      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      {state.saved ? <p className="text-sm text-ok">保存しました</p> : null}

      <Button type="submit" variant="primary" size="lg" block disabled={pending}>
        {pending ? '保存中…' : '保存する'}
      </Button>
    </form>
  );
}
