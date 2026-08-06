-- PHASE 1 — expiry tracking.
--
-- `expiry_date` already existed but carried no context: there was no way to
-- tell a date the user read off the package from one the app guessed, and no
-- way to tell 消費期限 (safety) from 賞味期限 (quality). Both matter when the
-- app starts telling someone what to eat first.
--
-- The estimated date is written into `expiry_date` rather than computed at
-- read time, so "expiring soon" stays an indexed range scan.

alter table public.inventory_items
  add column if not exists purchased_at date,
  add column if not exists opened_at date,
  add column if not exists expiry_kind text,
  add column if not exists expiry_source text not null default 'unknown';

-- Added separately: `add column ... check` cannot be made idempotent, and a
-- rerun would otherwise fail on the duplicate constraint name.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_items_expiry_kind_check'
  ) then
    alter table public.inventory_items
      add constraint inventory_items_expiry_kind_check
      check (expiry_kind is null or expiry_kind in ('use_by', 'best_before'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'inventory_items_expiry_source_check'
  ) then
    alter table public.inventory_items
      add constraint inventory_items_expiry_source_check
      check (expiry_source in ('user', 'estimated', 'unknown'));
  end if;

  -- An item cannot be opened before it was bought.
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_items_opened_after_purchase_check'
  ) then
    alter table public.inventory_items
      add constraint inventory_items_opened_after_purchase_check
      check (opened_at is null or purchased_at is null or opened_at >= purchased_at);
  end if;
end $$;

-- Existing rows: a date that is already there was typed by the user.
update public.inventory_items
set expiry_source = 'user'
where expiry_date is not null and expiry_source = 'unknown';

-- Drives「早めに使う食材」. Partial: rows with no date are never in that list.
create index if not exists inventory_items_urgency_idx
on public.inventory_items(user_id, expiry_date)
where expiry_date is not null and quantity_state <> 'empty';

comment on column public.inventory_items.expiry_source is
  'user = read off the package, estimated = computed by lib/inventory/freshness.ts. Never present an estimate as fact.';
