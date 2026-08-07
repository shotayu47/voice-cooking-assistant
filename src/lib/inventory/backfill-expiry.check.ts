import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { estimateExpiry } from './freshness';

/**
 * One-off backfill for PHASE 1 (not part of `npm test`).
 *
 * Rows created before expiry tracking existed carry `expiry_source: unknown`
 * and no date, so 「早めに使う食材」 stays empty for anyone who already had
 * inventory. This fills those in using the same estimator the app uses on
 * create, so there is one source of truth for shelf lives.
 *
 * Safe to re-run: only touches rows that still have no date, and never
 * overwrites a date the user entered.
 *
 * Run with: npm run test:live
 */

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type Row = {
  id: string;
  user_id: string;
  name: string;
  category: string | null;
  storage_location: string | null;
  purchased_at: string | null;
  opened_at: string | null;
  opened: boolean | null;
  expiry_date: string | null;
  expiry_source: string | null;
};

describe('backfill expiry estimates', () => {
  it('fills in every row that has no date yet', async () => {
    expect(URL_ENV, 'NEXT_PUBLIC_SUPABASE_URL must be set').toBeTruthy();
    expect(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY must be set').toBeTruthy();

    // Service role: this is a maintenance task that spans every user's rows,
    // so it deliberately bypasses RLS. It is never reachable from the app.
    const supabase = createClient(URL_ENV!, SERVICE_KEY!, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase
      .from('inventory_items')
      .select(
        'id, user_id, name, category, storage_location, purchased_at, opened_at, opened, expiry_date, expiry_source',
      )
      .is('expiry_date', null)
      .neq('quantity_state', 'empty');

    expect(error, error?.message).toBeNull();

    const rows = (data ?? []) as Row[];
    const results: string[] = [];

    for (const row of rows) {
      const estimate = estimateExpiry({
        name: row.name,
        category: row.category,
        storageLocation: row.storage_location as never,
        purchasedAt: row.purchased_at,
        openedAt: row.opened_at,
        opened: row.opened,
      });

      if (!estimate) {
        results.push(`skip     ${row.name} (推定できる情報がない)`);
        continue;
      }

      const { error: updateError } = await supabase
        .from('inventory_items')
        .update({
          expiry_date: estimate.date,
          expiry_kind: estimate.kind,
          expiry_source: 'estimated',
          purchased_at: row.purchased_at,
        })
        .eq('id', row.id)
        // Belt and braces: never overwrite a date that appeared in between.
        .is('expiry_date', null);

      expect(updateError, updateError?.message).toBeNull();
      results.push(`filled   ${row.name} -> ${estimate.date} (${estimate.kind})`);
    }

    console.log(`\n${rows.length} rows without a date:`);
    for (const line of results) console.log(`  ${line}`);
  }, 60_000);
});
