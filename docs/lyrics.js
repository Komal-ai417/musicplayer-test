'use strict';
/* ============================================================
   lyrics.js - lyrics panel with LRC sync + editor.
   Lyrics live in the songs table (lyrics column) and travel
   through the "songs" Edge Function (ops: get-lyrics /
   save-lyrics) — the same ownership checks as everything else.
   Parsing and active-line lookup use the pure helpers from
   om-core.js (parseLrc / lrcActiveIndex), which are unit-tested.
   ============================================================ */

const lyricsPanel = document.getElementById('lyrics-panel');
const lyricsCache = new Map();       // songId -> { synced, lines } | null (loaded, empty)
let lyricsFor = null;                // songId currently displayed
let lyricsActive = -1;               // highlighted line index

async function loadLyrics(song) {
  if (!song) return null;
  if (lyricsCache.has(song.id)) return lyricsCache.get(song.id);
  const res = await fnCall('songs', 'POST', { op: 'get-lyrics', id: song.id });
  if (!res.ok) {
    // 404 = song vanished; other errors fall back to "no lyrics" UI
    return null;
  }
  const parsed = res.data && res.data.lyrics ? parseLrc(res.data.lyrics) : null;
  const val = parsed && parsed.lines.length ? parsed : null;
  lyricsCache.set(song.id, val);
  return val;
}

function renderLyricsPanel(song, parsed) {
  if (!lyricsPanel) return;
  const titleEl = lyricsPanel.querySelector('.lp-title');
  if (titleEl) titleEl.textContent = song ? song.title : '';
  const list = lyricsPanel.querySelector('.lp-list');
  if (!list) return;

  if (!song) {
    list.innerHTML = '<div class="lp-empty">Play something to see its lyrics.</div>';
    return;
  }
  if (!parsed) {
    list.innerHTML =
      '<div class="lp-empty">No lyrics for <b>' + esc(song.title) + '</b> yet.' +
      '<button class="btn btn-primary lp-add">Add lyrics</button></div>';
    const add = list.querySelector('.lp-add');
    if (add) add.addEventListener('click', () => editLyrics(song));
    return;
  }

  const frag = document.createDocumentFragment();
  parsed.lines.forEach((line, i) => {
    const d = document.createElement('div');
    d.className = 'lyrics-line' + (parsed.synced ? ' sync' : '');
    d.dataset.i = String(i);
    d.textContent = line.text;
    frag.appendChild(d);
  });
  list.innerHTML = '';
  list.appendChild(frag);
  if (parsed.synced) {
    list.querySelectorAll('.lyrics-line').forEach(el => {
      el.addEventListener('click', () => {
        const i = +el.dataset.i;
        const t = parsed.lines[i].t;
        if (t != null && isFinite(t)) {
          try { audioEl.currentTime = Math.max(0, t); } catch { /* not seekable yet */ }
          updateLyricsSync(true);
        }
      });
    });
  }
}

/* highlight + auto-scroll; called from audioEl timeupdate */
function updateLyricsSync(force) {
  if (!lyricsPanel || lyricsPanel.hidden) return;
  const s = currentSong();
  if (!s || lyricsFor !== s.id) return;
  const parsed = lyricsCache.get(s.id);
  if (!parsed || !parsed.synced) return;
  const idx = lrcActiveIndex(parsed.lines, audioEl.currentTime || 0);
  if (idx === lyricsActive && !force) return;
  lyricsActive = idx;
  const rows = lyricsPanel.querySelectorAll('.lyrics-line');
  rows.forEach(r => r.classList.toggle('active', +r.dataset.i === idx));
  const el = rows[idx];
  if (el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* older browsers */ }
  }
}
audioEl.addEventListener('timeupdate', () => updateLyricsSync(false));

async function openLyricsPanel() {
  if (!lyricsPanel) return;
  lyricsPanel.hidden = false;
  if (queuePanel && !queuePanel.hidden) queuePanel.hidden = true;
  if (eqPanel && !eqPanel.hidden) eqPanel.hidden = true;
  lyricsActive = -1;
  const s = currentSong();
  if (!s) { lyricsFor = null; renderLyricsPanel(null, null); return; }
  if (lyricsFor === s.id) { updateLyricsSync(true); return; }
  lyricsFor = s.id;
  renderLyricsPanel(s, null);   // immediate shell (loading state)
  const list = lyricsPanel.querySelector('.lp-list');
  if (list && !lyricsCache.has(s.id)) list.innerHTML = '<div class="lp-empty">Loading lyrics...</div>';
  const parsed = await loadLyrics(s);
  if (lyricsFor !== s.id) return;      // song changed while loading
  renderLyricsPanel(s, parsed);
  updateLyricsSync(true);
}

document.getElementById('btn-lyrics').addEventListener('click', openLyricsPanel);
const lpClose = lyricsPanel ? lyricsPanel.querySelector('.lp-close') : null;
if (lpClose) lpClose.addEventListener('click', () => { lyricsPanel.hidden = true; });

/* follow song changes when the panel is open */
audioEl.addEventListener('play', () => { if (lyricsPanel && !lyricsPanel.hidden) openLyricsPanel(); });

/* ---------- editor ---------- */
async function editLyrics(song) {
  const res = await fnCall('songs', 'POST', { op: 'get-lyrics', id: song.id });
  const current = res.ok && res.data && res.data.lyrics ? String(res.data.lyrics) : '';
  const txt = await textareaModal(
    'Lyrics \u2014 ' + song.title,
    'Plain text, or <b>LRC</b> for synced highlighting: put a timestamp before each line, ' +
    'e.g. <code>[00:12.30]First line</code>. Only you can see these lyrics.',
    current,
    '[00:12.30]First line of the chorus...');
  if (txt == null) return;

  const save = await fnCall('songs', 'POST', { op: 'save-lyrics', id: song.id, lyrics: txt.slice(0, 100000) });
  if (!save.ok) { toast(fnErrText(save), 'error', 7000); return; }

  lyricsCache.delete(song.id);
  if (lyricsPanel && !lyricsPanel.hidden && lyricsFor === song.id) {
    const parsed = await loadLyrics(song);
    renderLyricsPanel(song, parsed);
    updateLyricsSync(true);
  }
  toast('Lyrics saved' + (parseLrc(txt).synced ? ' \u2014 synced' : ''), 'ok');
}

const lpEdit = lyricsPanel ? lyricsPanel.querySelector('.lp-edit') : null;
if (lpEdit) lpEdit.addEventListener('click', () => {
  const s = currentSong();
  if (s) editLyrics(s);
  else toast('Play a song first, then edit its lyrics.', 'warn');
});
