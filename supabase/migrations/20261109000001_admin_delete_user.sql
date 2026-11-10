-- ============================================================
-- Our Music v3 : transactional user-data cleanup for the
-- "delete-user" Edge Function (administrator-only deletion).
-- Run in Supabase SQL Editor. Safe to re-run anytime.
--
-- What it does
--   delete_user_data(p_target) removes, in ONE transaction:
--     1. playlist_songs rows inside playlists owned by the target
--     2. playlist_songs rows in OTHER users' playlists that
--        reference the target's songs
--     3. the target's playlists
--     4. the target's song metadata
--   and returns what was removed.
--
-- Safety
--   * SECURITY DEFINER + no EXECUTE grant for anon/authenticated
--     (Postgres grants EXECUTE to PUBLIC by default — revoked
--     below, this line is mandatory) — only service_role (the
--     Edge Functions' server-side client) may call it.
--   * A transaction-scoped advisory lock serializes concurrent
--     deletions of the same account, so two overlapping requests
--     can never interleave half-deleted state.
--   * Idempotent: every statement is a plain DELETE with a WHERE
--     clause — re-running after a partial failure is safe and
--     simply deletes nothing the second time.
--   * It never touches another user's playlists or song rows:
--     step 2 removes only the LINK rows pointing at the target's
--     songs; the other users' playlists themselves stay.
--
-- The function deliberately does NOT touch:
--   * auth.users  (the Edge Function calls the Auth Admin API,
--                  only after every other stage succeeded)
--   * storage.objects (cleaned via the Storage API, never SQL)
--   * GitHub files (cleaned via the GitHub API from the function)
-- ============================================================

create or replace function public.delete_user_data(p_target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_links_own   int;
  v_links_other int;
  v_playlists   int;
  v_songs       int;
begin
  if p_target is null then
    raise exception 'delete_user_data: target uuid is required';
  end if;

  -- Serialize concurrent deletions of the SAME account. Different
  -- accounts may proceed in parallel. Lock is released on commit.
  -- (Two-int4 advisory lock: first arg names the lock domain,
  --  second derives a stable int from the target UUID.)
  perform pg_advisory_xact_lock(hashtext('om-delete-user'), hashtext(p_target::text));

  -- 1. links inside the target's own playlists
  delete from public.playlist_songs ps
   where ps.playlist_id in (select id from public.playlists where user_id = p_target);
  get diagnostics v_links_own = row_count;

  -- 2. links in OTHER users' playlists that point at the target's
  --    songs (the playlists themselves are left alone)
  delete from public.playlist_songs ps
   where ps.song_id in (select id from public.songs where user_id = p_target);
  get diagnostics v_links_other = row_count;

  -- 3. the target's playlists
  delete from public.playlists where user_id = p_target;
  get diagnostics v_playlists = row_count;

  -- 4. the target's song metadata
  delete from public.songs where user_id = p_target;
  get diagnostics v_songs = row_count;

  return jsonb_build_object(
    'links_own_deleted',   v_links_own,
    'links_other_deleted', v_links_other,
    'playlists_deleted',   v_playlists,
    'songs_deleted',       v_songs
  );
end $$;

-- CRITICAL: functions are executable by PUBLIC by default.
revoke execute on function public.delete_user_data(uuid) from public;
revoke execute on function public.delete_user_data(uuid) from anon;
revoke execute on function public.delete_user_data(uuid) from authenticated;
grant  execute on function public.delete_user_data(uuid) to service_role;
