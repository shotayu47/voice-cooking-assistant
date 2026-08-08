-- PHASE 5 — cooking progress detail.
--
-- `current_step` alone cannot answer "what have I actually done?". With a
-- skip, "everything before the current step" stops being true: a step that
-- was jumped over is not a step that was completed. And the app never
-- recorded what a cook actually consumed, which is the missing link between
-- 調理完了 and 在庫から減算 in the product loop.

alter table public.cooking_sessions
  add column if not exists completed_steps integer[] not null default '{}',
  add column if not exists skipped_steps integer[] not null default '{}',
  add column if not exists used_ingredients jsonb not null default '[]'::jsonb;

-- A CHECK expression may not contain a subquery, but it may call a function
-- that does. Both progress arrays index into recipe_snapshot.steps, so every
-- element has to stay addressable.
create or replace function public.int_array_within_bounds(
  values_in integer[],
  upper_bound integer
)
returns boolean
language sql
immutable
as $$
  select values_in is null or not exists (
    select 1 from unnest(values_in) as step_index
    where step_index < 0 or step_index >= upper_bound
  );
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cooking_sessions_completed_steps_in_range'
  ) then
    alter table public.cooking_sessions
      add constraint cooking_sessions_completed_steps_in_range
      check (public.int_array_within_bounds(completed_steps, total_steps));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'cooking_sessions_skipped_steps_in_range'
  ) then
    alter table public.cooking_sessions
      add constraint cooking_sessions_skipped_steps_in_range
      check (public.int_array_within_bounds(skipped_steps, total_steps));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'cooking_sessions_used_ingredients_is_array'
  ) then
    alter table public.cooking_sessions
      add constraint cooking_sessions_used_ingredients_is_array
      check (jsonb_typeof(used_ingredients) = 'array');
  end if;
end $$;

-- Existing rows: before this migration progression was strictly linear, so
-- everything before the current step was completed. A finished session
-- completed all of them.
update public.cooking_sessions
set completed_steps = case
  when status = 'completed' then
    coalesce((select array_agg(i) from generate_series(0, total_steps - 1) i), '{}')
  when current_step > 0 then
    coalesce((select array_agg(i) from generate_series(0, current_step - 1) i), '{}')
  else '{}'
end
where completed_steps = '{}';

comment on column public.cooking_sessions.completed_steps is
  'Step indices explicitly marked done. Not derivable from current_step once a step can be skipped.';
comment on column public.cooking_sessions.used_ingredients is
  'What this cook actually consumed, appended as inventory is decremented. Feeds cooking history.';
