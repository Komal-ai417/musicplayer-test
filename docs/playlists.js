'use strict';
/* ============================================================
   playlists.js - playlists CRUD + the sidebar nav + views.
   All operations go through the "playlists" Edge Function,
   which re-checks ownership on the server.
   ============================================================ */

function playlistSongs(plId) {
  return state.plLinks
    .filter(l => l.playlist_id === plId)
    .sort((a, b) => a.position - b.position)
    .map(l => state.songs.find(s => s.id === l.song_id))
    .filter(Boolean);
}

/* ---------- sidebar nav ---------- */
function renderPlaylistNav() {
  const ul = document.getElementById('playlist-nav');
  ul.innerHTML = '';
  for (const pl of state.playlists) {
    const count = state.plLinks.filter(l => l.playlist_id === pl.id).length;
    const li = document.createElement('li');
    const b = document.createElement('button');
    if (state.view.type === 'playlist' && state.view.id === pl.id) b.classList.add('active');
    b.innerHTML = '<span class="pl-note"></span><span class="pl-name">' + esc(pl.name) +
                  '</span><span class="pl-count">' + (count || '') + '</span>';
    b.addEventListener('click', () => showView({ type: 'playlist', id: pl.id }));
    li.appendChild(b);
    ul.appendChild(li);
  }
}

document.getElementById('btn-new-playlist').addEventListener('click', () => createPlaylist());
document.getElementById('nav-all').addEventListener('click', () => showView({ type: 'all' }));

/* ---------- view switching ---------- */
function showView(view) {
  state.view = view;
  state.search = '';
  const si = document.getElementById('search-input');
  si.value = '';
  document.getElementById('nav-all').classList.toggle('active', view.type === 'all');
  const title = document.getElementById('view-title');
  if (view.type === 'all') title.textContent = 'All songs';
  else {
    const pl = state.playlists.find(p => p.id === view.id);
    title.textContent = pl ? pl.name : 'Playlist';
  }
  renderPlaylistNav();
  renderSongList();
}

/* ---------- header actions for playlist views ---------- */
function addPlaylistHeaderActions(container) {
  const pl = state.playlists.find(p => p.id === state.view.id);
  if (!pl) return;
  const rename = document.createElement('button');
  rename.className = 'btn btn-ghost';
  rename.innerHTML = icon('pencil', 15) + ' Rename';
  rename.addEventListener('click', () => renamePlaylist(pl));
  container.appendChild(rename);

  const del = document.createElement('button');
  del.className = 'btn btn-ghost';
  del.innerHTML = icon('trash', 15) + ' Delete';
  del.addEventListener('click', () => deletePlaylist(pl));
  container.appendChild(del);
}

/* ---------- CRUD (via Edge Function) ---------- */
async function createPlaylist(name, songToAdd) {
  const n = name || await promptModal('New playlist', 'Give your playlist a name.', 'e.g. Evening chill');
  if (n == null || !n) return;
  const res = await fnCall('playlists', 'POST', { op: 'create', name: n });
  if (!res.ok || !res.data || !res.data.playlist) { toast(fnErrText(res), 'error'); return; }
  const pl = res.data.playlist;
  state.playlists.push(pl);
  if (songToAdd) await addToPlaylist(pl, songToAdd, true);
  showView({ type: 'playlist', id: pl.id });
  toast('Playlist \u201C' + esc(pl.name) + '\u201D created');
}

async function renamePlaylist(pl) {
  const n = await promptModal('Rename playlist', 'Rename \u201C' + esc(pl.name) + '\u201D:', '', pl.name);
  if (n == null || !n || n === pl.name) return;
  const res = await fnCall('playlists', 'POST', { op: 'rename', id: pl.id, name: n });
  if (!res.ok) { toast(fnErrText(res), 'error'); return; }
  pl.name = n.slice(0, 100);
  showView({ type: 'playlist', id: pl.id });
}

async function deletePlaylist(pl) {
  const ok = await confirmModal('Delete playlist?',
    '\u201C' + esc(pl.name) + '\u201D will disappear (the songs themselves are not deleted).',
    'Delete playlist', true);
  if (!ok) return;
  const res = await fnCall('playlists', 'POST', { op: 'delete', id: pl.id });
  if (!res.ok) { toast(fnErrText(res), 'error'); return; }
  state.playlists = state.playlists.filter(p => p.id !== pl.id);
  state.plLinks = state.plLinks.filter(l => l.playlist_id !== pl.id);
  if (state.view.type === 'playlist' && state.view.id === pl.id) showView({ type: 'all' });
  else { renderPlaylistNav(); renderSongList(); }
  toast('Playlist deleted');
}

async function addToPlaylist(pl, song, quiet) {
  const pos = state.plLinks.filter(l => l.playlist_id === pl.id).length;
  const res = await fnCall('playlists', 'POST', { op: 'add', playlist_id: pl.id, song_id: song.id });
  if (!res.ok) {
    if (res.status === 409) toast('Already in \u201C' + esc(pl.name) + '\u201D', 'warn');
    else toast(fnErrText(res), 'error');
    return;
  }
  state.plLinks.push({ playlist_id: pl.id, song_id: song.id, position: pos });
  if (!quiet) toast('Added to \u201C' + esc(pl.name) + '\u201D');
  renderPlaylistNav();
  renderSongList();
}

async function removeFromPlaylist(pl, song) {
  const res = await fnCall('playlists', 'POST', { op: 'remove', playlist_id: pl.id, song_id: song.id });
  if (!res.ok) { toast(fnErrText(res), 'error'); return; }
  state.plLinks = state.plLinks.filter(l => !(l.playlist_id === pl.id && l.song_id === song.id));
  renderPlaylistNav();
  renderSongList();
}
