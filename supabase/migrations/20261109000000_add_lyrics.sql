-- ============================================================
-- Our Music v3 : lyrics column
-- Run in Supabase SQL Editor. Safe to re-run anytime.
--
-- Adds optional lyrics to each song. Accepted formats:
--   * plain text
--   * LRC ("[mm:ss.xx] line") — synced highlighting in the player
-- The column inherits the existing songs RLS policies (own rows
-- only); reading/writing goes through the "songs" Edge Function.
-- Length is capped at 100 000 characters by the Edge Function.
-- ============================================================

alter table public.songs
  add column if not exists lyrics text;

comment on column public.songs.lyrics is
  'Optional lyrics text (plain or LRC format), private to the song owner.';
