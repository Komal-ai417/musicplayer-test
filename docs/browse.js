'use strict';
/* ============================================================
   browse.js - artist & album pages (grid + filtered song list).
   Views used: {type:'artists'}, {type:'albums'}, {type:'artist',
   id:<name>}, {type:'album', id:<name>} — hooked into the
   existing view machinery in playlists.js / library.js.
   ============================================================ */

const UNKNOWN_ARTIST = 'Unknown artist';
const UNKNOWN_ALBUM = '\u2014'; // matches the row display fallback

function artistName(s) { return (s.artist && s.artist.trim()) ? s.artist.trim() : UNKNOWN_ARTIST; }
function albumName(s) { return (s.album && s.album.trim()) ? s.album.trim() : ''; }

/* Song source for artist / album views (called by visibleSongs). */
function browseSongs(view) {
  if (!view || !view.id) return [];
  if (view.type === 'artist') return state.songs.filter(s => artistName(s) === view.id);
  if (view.type === 'album') return state.songs.filter(s => albumName(s) === view.id && albumName(s) !== '');
  return [];
}

function browseViewTitle(view) {
  if (view.type === 'artists') return 'Artists';
  if (view.type === 'albums') return 'Albums';
  if (view.type === 'artist') return view.id;
  if (view.type === 'album') return view.id || 'Album';
  return null;
}

/* ---------- groupings ---------- */
function artistGroups() {
  const map = new Map();
  for (const s of state.songs) {
    const k = artistName(s);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count }));
}

function albumGroups() {
  const map = new Map();
  for (const s of state.songs) {
    const k = albumName(s);
    if (!k) continue;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count }));
}

/* ---------- grid rendering (hooked into renderSongList) ---------- */
function renderBrowseView() {
  const t = state.view.type;
  if (t !== 'artists' && t !== 'albums') return false;

  document.getElementById('table-head').hidden = true;
  document.getElementById('empty-state').hidden = true;
  document.getElementById('search-empty').hidden = true;

  const wrap = document.getElementById('song-list');
  wrap.innerHTML = '';

  const groups = t === 'artists' ? artistGroups() : albumGroups();
  const q = state.search.trim().toLowerCase();
  const filtered = q ? groups.filter(g => g.name.toLowerCase().includes(q)) : groups;

  document.getElementById('view-sub').textContent =
    filtered.length + (filtered.length === 1 ? (t === 'artists' ? ' artist' : ' album') : (t === 'artists' ? ' artists' : ' albums'));

  const actions = document.getElementById('view-actions');
  actions.innerHTML = '';

  if (!filtered.length) {
    if (state.search.trim()) document.getElementById('search-empty').hidden = false;
    else document.getElementById('empty-state').hidden = false;
    return true;
  }

  const grid = document.createElement('div');
  grid.className = 'browse-grid';
  const frag = document.createDocumentFragment();
  for (const g of filtered) {
    const card = document.createElement('button');
    card.className = 'tile';

    if (t === 'artists') {
      const h = hueFromString(g.name);
      card.innerHTML =
        '<span class="tile-art person" style="background:linear-gradient(135deg,hsl(' + h + ',42%,38%),hsl(' + ((h + 50) % 360) + ',42%,20%))">' +
          icon('person', 30) +
        '</span>' +
        '<span class="tile-name">' + esc(g.name) + '</span>' +
        '<span class="tile-sub muted tiny">' + g.count + (g.count === 1 ? ' song' : ' songs') + '</span>';
    } else {
      const any = state.songs.find(s => albumName(s) === g.name);
      const withCover = any && any.cover_data ? any : null;
      const h = hueFromString(g.name);
      const art = withCover
        ? '<span class="tile-art">' + coverHtml(withCover) + '</span>'
        : '<span class="tile-art" style="background:linear-gradient(135deg,hsl(' + h + ',42%,38%),hsl(' + ((h + 50) % 360) + ',42%,20%))">' + icon('album', 30) + '</span>';
      card.innerHTML =
        art +
        '<span class="tile-name">' + esc(g.name) + '</span>' +
        '<span class="tile-sub muted tiny">' + esc(artistName(any || {})) + (g.count ? ' \u00B7 ' + g.count + (g.count === 1 ? ' song' : ' songs') : '') + '</span>';
    }

    card.addEventListener('click', () => showView({ type: t === 'artists' ? 'artist' : 'album', id: g.name }));
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  wrap.appendChild(grid);
  return true;
}

/* ---------- sidebar nav ---------- */
document.getElementById('nav-artists').addEventListener('click', () => showView({ type: 'artists' }));
document.getElementById('nav-albums').addEventListener('click', () => showView({ type: 'albums' }));

function updateBrowseNav(view) {
  const a = document.getElementById('nav-artists');
  const l = document.getElementById('nav-albums');
  if (a) a.classList.toggle('active', view.type === 'artists' || view.type === 'artist');
  if (l) l.classList.toggle('active', view.type === 'albums' || view.type === 'album');
}
