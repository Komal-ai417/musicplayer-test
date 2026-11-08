'use strict';
/* ============================================================
   playlists.js - playlists CRUD + the sidebar nav + views
   ============================================================ */

async function loadPlaylists() {
  const { data, error } = await state.sb.from('playlists')
    .select('*').order('created_at', { ascending: true });
  if (error) throw error;
  state.playlists = data || [];
}

async function loadPlLinks() {
  const { data, error } = await state.sb.from('playlist_songs')
    .select('playlist_id, song_id, position');
  if (error) throw error;
  state.plLinks = data || [];
}

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

/* ---------- CRUD ---------- */
async function createPlaylist(name, songToAdd) {
  const n = name || await promptModal('New playlist', 'Give your playlist a name.', 'e.g. Evening chill');
  if (n == null || !n) return;
  const { data, error } = await state.sb.from('playlists')
    .insert({ name: n.slice(0, 100) }).select().single();
  if (error) { toast('Could not create the playlist: ' + esc(error.message), 'error'); return; }
  state.playlists.push(data);
  if (songToAdd) {
    await addToPlaylist(data, songToAdd, true);
    showView({ type: 'playlist', id: data.id });
  } else {
    renderPlaylistNav();
    showView({ type: 'playlist', id: data.id });
    toast('Playlist \u201C' + esc(data.name) + '\u201D created');
  }
}

async function renamePlaylist(pl) {
  const n = await promptModal('Rename playlist', 'Rename \u201C' + esc(pl.name) + '\u201D:', '', pl.name);
  if (n == null || !n || n === pl.name) return;
  const { error } = await state.sb.from('playlists').update({ name: n.slice(0, 100) }).eq('id', pl.id);
  if (error) { toast('Could not rename: ' + esc(error.message), 'error'); return; }
  pl.name = n.slice(0, 100);
  showView({ type: 'playlist', id: pl.id });
}

async function deletePlaylist(pl) {
  const ok = await confirmModal('Delete playlist?',
    '\u201C' + esc(pl.name) + '\u201D will disappear (the songs themselves are not deleted).',
    'Delete playlist', true);
  if (!ok) return;
  const { error } = await state.sb.from('playlists').delete().eq('id', pl.id);
  if (error) { toast('Could not delete: ' + esc(error.message), 'error'); return; }
  state.playlists = state.playlists.filter(p => p.id !== pl.id);
  state.plLinks = state.plLinks.filter(l => l.playlist_id !== pl.id);
  if (state.view.type === 'playlist' && state.view.id === pl.id) showView({ type: 'all' });
  else { renderPlaylistNav(); renderSongList(); }
  toast('Playlist deleted');
}

async function addToPlaylist(pl, song, quiet) {
  const pos = state.plLinks.filter(l => l.playlist_id === pl.id).length;
  const { error } = await state.sb.from('playlist_songs')
    .insert({ playlist_id: pl.id, song_id: song.id, position: pos });
  if (error) {
    if (error.code === '23505') toast('Already in \u201C' + esc(pl.name) + '\u201D', 'warn');
    else toast('Could not add: ' + esc(error.message), 'error');
    return;
  }
  state.plLinks.push({ playlist_id: pl.id, song_id: song.id, position: pos });
  if (!quiet) toast('Added to \u201C' + esc(pl.name) + '\u201D');
  renderPlaylistNav();
  if (state.view.type === 'playlist' && state.view.id === pl.id) renderSongList();
  else renderSongList(); /* keep counts fresh */
}

async function removeFromPlaylist(pl, song) {
  const { error } = await state.sb.from('playlist_songs')
    .delete().eq('playlist_id', pl.id).eq('song_id', song.id);
  if (error) { toast('Could not remove: ' + esc(error.message), 'error'); return; }
  state.plLinks = state.plLinks.filter(l => !(l.playlist_id === pl.id && l.song_id === song.id));
  renderPlaylistNav();
  renderSongList();
}
