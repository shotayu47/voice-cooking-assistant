'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createClient, getServiceContext } from '@/lib/supabase/server';

export type SettingsState = { error?: string; saved?: boolean };

const HEAT_SCALES = ['ih_10', 'low_medium_high'] as const;
const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;

export async function updateProfileAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const { ctx } = await getServiceContext();

  const displayName = String(formData.get('display_name') ?? '').trim();
  const heatScale = String(formData.get('preferred_heat_scale') ?? '');
  const skillLevel = String(formData.get('cooking_skill_level') ?? '');

  if (!(HEAT_SCALES as readonly string[]).includes(heatScale)) {
    return { error: '火力の基準が不正です' };
  }
  if (!(SKILL_LEVELS as readonly string[]).includes(skillLevel)) {
    return { error: '調理レベルが不正です' };
  }

  // Upsert: the signup trigger normally creates the row, but a user created
  // before the trigger existed would have none.
  const { error } = await ctx.supabase.from('profiles').upsert(
    {
      id: ctx.userId,
      display_name: displayName === '' ? null : displayName,
      preferred_heat_scale: heatScale,
      cooking_skill_level: skillLevel,
    },
    { onConflict: 'id' },
  );

  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { saved: true };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
