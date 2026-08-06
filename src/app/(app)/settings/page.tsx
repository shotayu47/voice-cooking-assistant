import { Button } from '@/components/ui/button';
import { PageShell } from '@/components/page-shell';
import { getServiceContext } from '@/lib/supabase/server';
import type { Profile } from '@/types/domain';

import { signOutAction } from './actions';
import { SettingsForm } from './settings-form';

export const metadata = { title: '設定 | 料理アシスタント' };

export default async function SettingsPage() {
  const { ctx, user } = await getServiceContext();

  const { data } = await ctx.supabase
    .from('profiles')
    .select('display_name, preferred_heat_scale, cooking_skill_level')
    .eq('id', ctx.userId)
    .maybeSingle();

  const profile = (data ?? null) as Pick<
    Profile,
    'display_name' | 'preferred_heat_scale' | 'cooking_skill_level'
  > | null;

  return (
    <PageShell title="設定">
      <p className="mb-6 text-sm text-muted">{user.email}</p>

      <SettingsForm profile={profile} />

      <form action={signOutAction} className="mt-10">
        <Button type="submit" variant="danger" size="md" block>
          ログアウト
        </Button>
      </form>
    </PageShell>
  );
}
