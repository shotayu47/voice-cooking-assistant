-- PHASE 9 — shopping list.
--
-- The kitchen loop already knows what is running out (PHASE 1 expiry, PHASE 3
-- missing ingredients). What it could not do is hold that knowledge until the
-- user is standing in a shop. This table is that holding place.
--
-- Deliberately no unique constraint on (user_id, normalized_name): 「卵 6個」
-- and 「卵 1パック」 are two legitimate lines, and merging them would throw
-- away what the user wrote. Duplicate *detection* is the service's job, and it
-- only reports — it never merges. See docs/phase9-shopping-list.md.

create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  name text not null,

  -- Same canonical form `inventory_items.normalized_name` uses, produced by the
  -- same `normalizeIngredientName()`. Keeping one folding rule across both
  -- tables is what will let PHASE 10 match a shopping line to stock without a
  -- second, subtly different notion of "the same ingredient".
  normalized_name text not null,

  -- Both optional: 「牛乳」 with no amount is the common case. A unit without a
  -- quantity is not — 「g」 alone says nothing — so the CHECK below rejects it.
  quantity numeric,
  unit text,

  checked boolean not null default false,
  -- Set when checked, cleared when unchecked. Not a purchase history: PHASE 12
  -- owns that, and these rows are deleted by the bulk clear.
  checked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shopping_items_name_not_blank
    check (btrim(name) <> ''),
  constraint shopping_items_normalized_name_not_blank
    check (btrim(normalized_name) <> ''),
  -- Zero is not a shopping amount, and neither is a negative one.
  constraint shopping_items_quantity_positive
    check (quantity is null or quantity > 0),
  constraint shopping_items_unit_needs_quantity
    check (unit is null or quantity is not null),
  -- Keeps `checked` and `checked_at` from disagreeing, in either direction.
  constraint shopping_items_checked_at_matches_checked
    check ((checked and checked_at is not null) or (not checked and checked_at is null))
);

-- The list query is exactly `user_id = ? order by checked, created_at`, so the
-- index covers it end to end. Sort order lives here rather than in a
-- `sort_order` column: manual reordering is out of scope, and an unused
-- numbering scheme would still need renumbering logic and tests.
create index if not exists shopping_items_user_checked_created_idx
on public.shopping_items(user_id, checked, created_at);

drop trigger if exists shopping_items_set_updated_at on public.shopping_items;
create trigger shopping_items_set_updated_at
before update on public.shopping_items
for each row execute function public.set_updated_at();

alter table public.shopping_items enable row level security;

-- Postgres has no `create policy if not exists`, so drop first. This keeps the
-- file safe to paste into the SQL editor more than once.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'shopping_items'
  loop
    execute format('drop policy if exists %I on public.shopping_items', policy_row.policyname);
  end loop;
end $$;

create policy "shopping_items_select_own" on public.shopping_items
  for select using (user_id = (select auth.uid()));
create policy "shopping_items_insert_own" on public.shopping_items
  for insert with check (user_id = (select auth.uid()));
-- USING decides which rows may be updated, WITH CHECK decides what they may
-- become. Without the latter, a row could be handed to another user_id.
create policy "shopping_items_update_own" on public.shopping_items
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- DELETE is required here, unlike inventory_transactions (append-only): both
-- single delete and the bulk clear of checked items are in scope.
create policy "shopping_items_delete_own" on public.shopping_items
  for delete using (user_id = (select auth.uid()));
