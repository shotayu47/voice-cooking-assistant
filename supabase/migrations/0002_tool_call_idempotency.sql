-- Idempotency ledger for AI tool calls.
--
-- Why: the voice path executes tools from the browser (the Realtime model
-- signals a function call over the data channel and the client relays it to
-- /api/realtime/tool). A relay can be retried — by the client, by a flaky
-- network, or by the model re-emitting a call — and "consume 2 eggs" must not
-- run twice. The model's own call_id is stable per call, so it is the natural
-- idempotency key.
--
-- The unique index is what makes the claim race-safe: two concurrent relays of
-- the same call_id cannot both insert, so exactly one executes.

create table if not exists public.ai_tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- The Realtime function-call id (`call_...`), or any client-supplied key.
  call_id text not null,
  tool_name text not null,

  status text not null default 'in_flight'
    check (status in ('in_flight', 'done')),
  result jsonb,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  constraint ai_tool_calls_unique_per_user unique (user_id, call_id)
);

create index if not exists ai_tool_calls_user_created_idx
on public.ai_tool_calls(user_id, created_at desc);

drop trigger if exists ai_tool_calls_set_updated_at on public.ai_tool_calls;
create trigger ai_tool_calls_set_updated_at
before update on public.ai_tool_calls
for each row execute function public.set_updated_at();

alter table public.ai_tool_calls enable row level security;

do $$
declare
  policy_row record;
begin
  for policy_row in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ai_tool_calls'
  loop
    execute format('drop policy if exists %I on public.ai_tool_calls', policy_row.policyname);
  end loop;
end $$;

create policy "ai_tool_calls_select_own" on public.ai_tool_calls
  for select using (user_id = (select auth.uid()));
create policy "ai_tool_calls_insert_own" on public.ai_tool_calls
  for insert with check (user_id = (select auth.uid()));
create policy "ai_tool_calls_update_own" on public.ai_tool_calls
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Records the wall-clock time of the last AI-initiated step move, so a
-- duplicate relay arriving moments later can be rejected even when it carries
-- a fresh call_id. `updated_at` cannot serve this: it also moves on status
-- changes, and any write would then look like a step move.
alter table public.cooking_sessions
  add column if not exists last_ai_step_move_at timestamptz;
