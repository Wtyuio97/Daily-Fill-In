-- The Daily Fill-In: leaderboard setup for Supabase.
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.
-- Safe to run again later; it updates the functions without touching saved scores.

-- One row per player per edition.
create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  edition_key date        not null,
  player_id   uuid        not null,
  name        text        not null,
  score       int         not null,
  correct     int         not null,
  total       int         not null,
  created_at  timestamptz not null default now(),
  unique (edition_key, player_id)
);
create unique index if not exists scores_edition_name_idx on public.scores (edition_key, lower(name));
create index if not exists scores_edition_rank_idx on public.scores (edition_key, score desc, created_at);

-- Visitors can't read or change the table directly. Everything goes through the two functions below.
alter table public.scores enable row level security;
revoke all on table public.scores from anon, authenticated;

-- Save a finished game. Returns {"ok": true} or {"ok": false, "error": "..."}.
create or replace function public.submit_score(
  p_edition text, p_player uuid, p_name text, p_score int, p_correct int, p_total int
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_edition date;
  v_today   date := (now() at time zone 'America/New_York')::date;
  v_name    text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  begin
    v_edition := p_edition::date;
  exception when others then
    return json_build_object('ok', false, 'error', 'bad_edition');
  end;
  -- Only today's edition (or yesterday's, for people who started before the morning update).
  if v_edition < v_today - 1 or v_edition > v_today then
    return json_build_object('ok', false, 'error', 'closed_edition');
  end if;
  if p_player is null then
    return json_build_object('ok', false, 'error', 'bad_player');
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 20 or v_name !~ '^[A-Za-z0-9 ._''-]+$' then
    return json_build_object('ok', false, 'error', 'bad_name');
  end if;
  -- A right answer is worth 50 to 100 points, a wrong one 0.
  if p_total is null or p_correct is null or p_score is null
     or p_total < 3 or p_total > 10 or p_correct < 0 or p_correct > p_total
     or p_score < 50 * p_correct or p_score > 100 * p_correct then
    return json_build_object('ok', false, 'error', 'bad_score');
  end if;
  if exists (select 1 from scores where edition_key = v_edition and player_id = p_player) then
    return json_build_object('ok', false, 'error', 'already_played');
  end if;
  if exists (select 1 from scores where edition_key = v_edition and lower(name) = lower(v_name)) then
    return json_build_object('ok', false, 'error', 'name_taken');
  end if;
  insert into scores (edition_key, player_id, name, score, correct, total)
  values (v_edition, p_player, v_name, p_score, p_correct, p_total);
  return json_build_object('ok', true);
exception when unique_violation then
  -- Two people grabbed the same name at the same moment.
  return json_build_object('ok', false, 'error', 'name_taken');
end;
$$;

-- Top players for an edition, plus the asking player's own row if they're further down.
create or replace function public.get_leaderboard(
  p_edition text, p_player uuid default null, p_limit int default 10
) returns table (place bigint, name text, score int, correct int, total int, is_you boolean, players bigint)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select s.name, s.score, s.correct, s.total, s.player_id,
           rank()       over (order by s.score desc)                  as place,
           row_number() over (order by s.score desc, s.created_at asc) as pos,
           count(*)     over ()                                       as players
    from scores s
    where s.edition_key = p_edition::date
  )
  select r.place, r.name, r.score, r.correct, r.total,
         coalesce(r.player_id = p_player, false) as is_you,
         r.players
  from ranked r
  where r.pos <= least(greatest(coalesce(p_limit, 10), 1), 50)
     or r.player_id = p_player
  order by r.pos;
$$;

revoke all on function public.submit_score(text, uuid, text, int, int, int) from public;
revoke all on function public.get_leaderboard(text, uuid, int) from public;
grant execute on function public.submit_score(text, uuid, text, int, int, int) to anon, authenticated;
grant execute on function public.get_leaderboard(text, uuid, int) to anon, authenticated;

-- Tell the Supabase API about the new functions.
notify pgrst, 'reload schema';
