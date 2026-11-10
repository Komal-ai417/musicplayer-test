'use strict';
/* ============================================================
   om-core.js - PURE helpers, zero DOM access.
   Loaded first so every feature script (and the unit tests via
   tests/unit/om-core.test.js, which evaluates this exact file)
   shares one implementation.
   ============================================================ */

/* ===================== lyrics (LRC) ===================== */

/* Parse lyrics text: either plain text or LRC ("[mm:ss.xx] line").
   Returns { synced, lines } where each line is { t, text }:
     * synced=true  -> only timestamped lines, sorted by time
                       (t = seconds, float)
     * synced=false -> every non-empty line in order (t = null)
   Handles: multiple "[mm:ss.xx]" tags on one line, "[offset:+ms]"
   tags, and ignores metadata tags like [ar:], [ti:], [al:], [by:],
   [length:], [re:], [ve:]. Invalid timestamps are treated as plain
   text on that line. */
function parseLrc(raw) {
  const text = String(raw ?? '');
  const lines = text.split(/\r\n|\r|\n/);

  // optional global offset: positive shifts lyrics EARLIER (LRC spec)
  let offsetMs = 0;
  const off = text.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im);
  if (off) offsetMs = parseInt(off[1], 10);

  const META_TAG = /^\s*\[(?:ar|ti|al|by|length|re|ve|au|encoding|tool):/i;
  const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:,](\d{1,3}))?\]/g;

  const timed = [];
  const plain = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (META_TAG.test(line)) continue;

    STAMP.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = STAMP.exec(line))) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] ?? '';
      const frac = parseInt(fracRaw.padEnd(3, '0').slice(0, 3), 10) / 1000;
      if (min <= 600 && sec < 60) stamps.push(min * 60 + sec + frac);
    }
    const body = line.replace(STAMP, '').trim();
    if (stamps.length && body) {
      for (const t of stamps) timed.push({ t: Math.max(0, t - offsetMs / 1000), text: body });
    } else if (body) {
      plain.push({ t: null, text: body });
    }
  }

  timed.sort((a, b) => a.t - b.t || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  if (timed.length) return { synced: true, lines: timed };
  return { synced: false, lines: plain };
}

/* Index of the line that should be highlighted at `sec` seconds
   (last line whose t <= sec). -1 when nothing is active yet.
   Binary search: safe for huge lyrics. */
function lrcActiveIndex(lines, sec) {
  if (!lines || !lines.length) return -1;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t == null) { lo = mid + 1; continue; }
    if (lines[mid].t <= sec) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/* Format seconds for the lyrics editor hint / timestamps UI. */
function lrcFmtTime(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/* ===================== sorting ===================== */

const SORT_KEYS = ['recent', 'title', 'artist', 'album', 'duration'];

const COLL = { sensitivity: 'base', numeric: true };

function songSortStr(v, fallback) {
  const s = (v ?? '').toString().trim();
  return s || fallback;
}

/* Pure sort used by the library: returns a NEW array.
   { key: 'recent' | 'title' | 'artist' | 'album' | 'duration',
     dir: 'asc' | 'desc' } — 'recent' sorts by created_at (newest
   first with dir 'desc', matching the server's default order). */
function sortSongsBy(list, sort) {
  const out = [...list];
  if (!sort || !sort.key || !SORT_KEYS.includes(sort.key)) return out;
  const dir = sort.dir === 'asc' ? 1 : sort.dir === 'desc' ? -1 : 0;
  if (!dir) return out;

  switch (sort.key) {
    case 'recent':
      out.sort((a, b) =>
        dir * ((Date.parse(a.created_at || '') || 0) - (Date.parse(b.created_at || '') || 0)));
      break;
    case 'title':
      out.sort((a, b) => dir * songSortStr(a.title, '\uFFFF')
        .localeCompare(songSortStr(b.title, '\uFFFF'), undefined, COLL));
      break;
    case 'artist':
      out.sort((a, b) => dir * songSortStr(a.artist, '\uFFFFUnknown artist')
        .localeCompare(songSortStr(b.artist, '\uFFFFUnknown artist'), undefined, COLL));
      break;
    case 'album':
      out.sort((a, b) => dir * songSortStr(a.album, '\uFFFF\u2014')
        .localeCompare(songSortStr(b.album, '\uFFFF\u2014'), undefined, COLL));
      break;
    case 'duration':
      out.sort((a, b) => dir * ((a.duration_sec || 0) - (b.duration_sec || 0)));
      break;
  }
  return out;
}

/* ===================== equalizer math ===================== */

const EQ_BANDS = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/* dB -> linear gain (Web Audio AudioParam values). */
function eqDbToGain(db) {
  const d = Math.max(-12, Math.min(12, Number(db) || 0));
  return Math.pow(10, d / 20);
}

/* Band label like "60", "1k", "16k" for the panel. */
function eqBandLabel(hz) {
  return hz >= 1000 ? (hz / 1000) + 'k' : String(Math.round(hz));
}
