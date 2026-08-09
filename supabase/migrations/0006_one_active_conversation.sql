-- PHASE 10 follow-up — one active conversation per user, enforced by the database.
--
-- `getOrCreateConversation` reads "the newest active conversation" and inserts
-- one when there is none. That read and that insert are not atomic: two
-- requests arriving together — a page render and a POST /api/chat, say — can
-- both see zero and both insert. Nothing stopped them, and it shows: this
-- project's own database had three active conversations for one user by the
-- time anyone looked.
--
-- An application-level rule cannot fix that, because the race is between two
-- application processes. A partial unique index can: the second insert loses
-- with 23505 and the loser adopts the winner's row.
--
-- Nothing is deleted here. Conversations and their messages are the user's
-- record of what was said; the extra ones are marked `closed`, which the
-- existing CHECK already allows and which the app already treats as "not the
-- current conversation".

-- 1. Normalise what is already there. Keep the newest active conversation per
--    user and close the rest.
--
--    `created_at desc, id desc` rather than `created_at desc` alone: two rows
--    inserted in the same transaction can share a timestamp, and a tie would
--    make the choice non-deterministic — and therefore make re-running this
--    migration able to pick a different survivor.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id
      order by created_at desc, id desc
    ) as position
  from public.conversation_sessions
  where status = 'active'
)
update public.conversation_sessions as target
set status = 'closed'
from ranked
where target.id = ranked.id
  and ranked.position > 1;

-- 2. Stop it happening again.
--
--    Partial, so closed conversations are unconstrained — a user accumulates
--    as many of those as they have had conversations.
create unique index if not exists conversation_sessions_one_active_per_user_idx
on public.conversation_sessions (user_id)
where status = 'active';
