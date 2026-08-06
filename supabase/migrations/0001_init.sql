-- Voice Cooking Assistant — Phase 1 schema
-- SPEC.md §6 (Database Schema) / §7 (Row Level Security)

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6.1 profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  locale text default 'ja-JP',
  timezone text default 'Asia/Tokyo',
  cooking_skill_level text default 'beginner'
    check (cooking_skill_level in ('beginner', 'intermediate', 'advanced')),
  preferred_heat_scale text default 'ih_10'
    check (preferred_heat_scale in ('ih_10', 'low_medium_high')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- A profile row must exist for every authenticated user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 6.2 inventory_items
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  name text not null,
  normalized_name text,
  category text,

  quantity numeric,
  unit text,

  quantity_state text not null default 'available'
    check (quantity_state in (
      'unknown',
      'low',
      'available',
      'plenty',
      'empty'
    )),

  storage_location text
    check (
      storage_location is null
      or storage_location in (
        'fridge',
        'freezer',
        'pantry',
        'room_temperature',
        'other'
      )
    ),

  expiry_date date,
  opened boolean default false,
  notes text,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  -- Quantity is optional, but it can never be negative.
  constraint inventory_items_quantity_non_negative
    check (quantity is null or quantity >= 0)
);

create index if not exists inventory_items_user_id_idx
on public.inventory_items(user_id);

create index if not exists inventory_items_expiry_idx
on public.inventory_items(user_id, expiry_date);

create index if not exists inventory_items_normalized_name_idx
on public.inventory_items(user_id, normalized_name);

drop trigger if exists inventory_items_set_updated_at on public.inventory_items;
create trigger inventory_items_set_updated_at
before update on public.inventory_items
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6.3 recipes
-- ---------------------------------------------------------------------------

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,

  title text not null,
  description text,

  servings integer default 1,
  estimated_minutes integer,
  difficulty text
    check (difficulty is null or difficulty in ('easy', 'medium', 'hard')),

  ingredients jsonb not null,
  steps jsonb not null,

  source_type text default 'ai'
    check (source_type in ('ai', 'user', 'imported')),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists recipes_user_id_idx
on public.recipes(user_id, created_at desc);

drop trigger if exists recipes_set_updated_at on public.recipes;
create trigger recipes_set_updated_at
before update on public.recipes
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6.4 cooking_sessions
-- ---------------------------------------------------------------------------

create table if not exists public.cooking_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  recipe_id uuid references public.recipes(id) on delete set null,

  recipe_snapshot jsonb not null,

  current_step integer not null default 0,
  total_steps integer not null,

  status text not null default 'active'
    check (status in (
      'active',
      'paused',
      'completed',
      'cancelled'
    )),

  started_at timestamptz default now(),
  completed_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  -- The database — not the model — bounds the current step.
  constraint cooking_sessions_total_steps_positive
    check (total_steps > 0),
  constraint cooking_sessions_current_step_in_range
    check (current_step >= 0 and current_step < total_steps)
);

create index if not exists cooking_sessions_user_id_idx
on public.cooking_sessions(user_id, created_at desc);

-- At most one active/paused session per user keeps "resume cooking" unambiguous.
create unique index if not exists cooking_sessions_one_open_per_user_idx
on public.cooking_sessions(user_id)
where status in ('active', 'paused');

drop trigger if exists cooking_sessions_set_updated_at on public.cooking_sessions;
create trigger cooking_sessions_set_updated_at
before update on public.cooking_sessions
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6.5 inventory_transactions
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,

  action text not null
    check (action in (
      'create',
      'increase',
      'decrease',
      'set_quantity',
      'set_state',
      'consume_all',
      'delete'
    )),

  quantity_delta numeric,
  previous_value jsonb,
  new_value jsonb,
  source text default 'manual'
    check (source in (
      'manual',
      'ai_text',
      'ai_voice',
      'receipt',
      'barcode',
      'photo'
    )),

  created_at timestamptz default now()
);

create index if not exists inventory_transactions_user_id_idx
on public.inventory_transactions(user_id, created_at desc);

create index if not exists inventory_transactions_item_idx
on public.inventory_transactions(inventory_item_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 6.6 conversation_sessions
-- ---------------------------------------------------------------------------

create table if not exists public.conversation_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  cooking_session_id uuid references public.cooking_sessions(id) on delete set null,

  status text default 'active'
    check (status in ('active', 'closed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists conversation_sessions_user_id_idx
on public.conversation_sessions(user_id, created_at desc);

drop trigger if exists conversation_sessions_set_updated_at on public.conversation_sessions;
create trigger conversation_sessions_set_updated_at
before update on public.conversation_sessions
for each row execute function public.set_updated_at();

-- Chat transcript. Not in the SPEC schema, but the chat page has to survive a
-- reload and the model must never be the only place a message lives.
create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_session_id uuid not null
    references public.conversation_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Replay order must be exact: a tool result that precedes its own call is a
  -- protocol error, and timestamps can tie at millisecond resolution.
  seq bigint generated always as identity,

  role text not null check (role in ('user', 'assistant', 'tool')),
  content text,
  tool_calls jsonb,
  tool_call_id text,

  created_at timestamptz default now()
);

create index if not exists conversation_messages_session_idx
on public.conversation_messages(conversation_session_id, seq);

-- ---------------------------------------------------------------------------
-- 7. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles               enable row level security;
alter table public.inventory_items        enable row level security;
alter table public.recipes                enable row level security;
alter table public.cooking_sessions       enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.conversation_sessions  enable row level security;
alter table public.conversation_messages  enable row level security;

-- Postgres has no `create policy if not exists`, so drop first. This keeps the
-- file safe to paste into the SQL editor more than once.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'profiles',
        'inventory_items',
        'recipes',
        'cooking_sessions',
        'inventory_transactions',
        'conversation_sessions',
        'conversation_messages'
      )
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      policy_row.policyname,
      policy_row.tablename
    );
  end loop;
end $$;

-- profiles: id = auth.uid()
create policy "profiles_select_own" on public.profiles
  for select using (id = (select auth.uid()));
create policy "profiles_insert_own" on public.profiles
  for insert with check (id = (select auth.uid()));
create policy "profiles_update_own" on public.profiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Everything else: user_id = auth.uid()
create policy "inventory_items_select_own" on public.inventory_items
  for select using (user_id = (select auth.uid()));
create policy "inventory_items_insert_own" on public.inventory_items
  for insert with check (user_id = (select auth.uid()));
create policy "inventory_items_update_own" on public.inventory_items
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "inventory_items_delete_own" on public.inventory_items
  for delete using (user_id = (select auth.uid()));

create policy "recipes_select_own" on public.recipes
  for select using (user_id = (select auth.uid()));
create policy "recipes_insert_own" on public.recipes
  for insert with check (user_id = (select auth.uid()));
create policy "recipes_update_own" on public.recipes
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "recipes_delete_own" on public.recipes
  for delete using (user_id = (select auth.uid()));

create policy "cooking_sessions_select_own" on public.cooking_sessions
  for select using (user_id = (select auth.uid()));
create policy "cooking_sessions_insert_own" on public.cooking_sessions
  for insert with check (user_id = (select auth.uid()));
create policy "cooking_sessions_update_own" on public.cooking_sessions
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "cooking_sessions_delete_own" on public.cooking_sessions
  for delete using (user_id = (select auth.uid()));

-- Transactions are an append-only audit log: no update, no delete.
create policy "inventory_transactions_select_own" on public.inventory_transactions
  for select using (user_id = (select auth.uid()));
create policy "inventory_transactions_insert_own" on public.inventory_transactions
  for insert with check (user_id = (select auth.uid()));

create policy "conversation_sessions_select_own" on public.conversation_sessions
  for select using (user_id = (select auth.uid()));
create policy "conversation_sessions_insert_own" on public.conversation_sessions
  for insert with check (user_id = (select auth.uid()));
create policy "conversation_sessions_update_own" on public.conversation_sessions
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "conversation_messages_select_own" on public.conversation_messages
  for select using (user_id = (select auth.uid()));
create policy "conversation_messages_insert_own" on public.conversation_messages
  for insert with check (user_id = (select auth.uid()));
