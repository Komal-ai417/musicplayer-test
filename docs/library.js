'use strict';
/* ============================================================
   library.js - song list, upload pipeline, delete.
   All server work happens in Edge Functions; the browser
   only touches the private staging bucket during upload.
   ============================================================ */

/* songs for the current view + search filter */
function visibleSongs() {
  let list = state.view.type === 'all'
    ? state.songs
    : (typeof playlistSongs === 'function' ? playlistSongs(state.view.id) : []);
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter(s =>
      (s.title + ' ' + (s.artist || '') + ' ' + (s.album || '')).toLowerCase().includes(q));
  }
  return list;
}

/* ---------- rendering ---------- */
function renderSongList() {
  const wrap = document.getElementById('song-list');
  const list = visibleSongs();
  wrap.innerHTML = '';
  document.getElementById('table-head').hidden = false;
  document.getElementById('empty-state').hidden = true;
  document.getElementById('search-empty').hidden = true;

  if (!list.length) {
    document.getElementById('table-head').hidden = true;
    if (state.search.trim()) document.getElementById('search-empty').hidden = false;
    else document.getElementById('empty-state').hidden = false;
  }
  const frag = document.createDocumentFragment();
  list.forEach((s, i) => frag.appendChild(songRow(s, i)));
  wrap.appendChild(frag);
  refreshRowMarks();
  updateViewMeta();
}

function songRow(s, i) {
  const row = document.createElement('div');
  row.className = 'song-row';
  row.dataset.id = s.id;
  row.innerHTML =
    '<span class="c-idx">' +
      '<span class="num">' + (i + 1) + '</span>' +
      '<span class="hov">' + icon('play', 16) + '</span>' +
      '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>' +
    '</span>' +
    '<span class="cover" style="' + coverTileStyle(s.id) + '">' + coverHtml(s) + '</span>' +
    '<span class="c-title"><b>' + esc(s.title) + '</b><span>' + esc(s.artist || 'Unknown artist') + '</span></span>' +
    '<span class="c-album">' + esc(s.album || '\u2014') + '</span>' +
    '<span class="c-dur">' + fmtTime(s.duration_sec) + '</span>' +
    '<span class="c-menu"><button class="icon-btn row-menu" title="More">' + icon('dots', 18) + '</button></span>';

  row.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    /* Tapping the song that is already playing toggles play/pause
       (like Spotify) instead of restarting it from 0:00. */
    if (playingId() === s.id) { togglePlay(); return; }
    setQueue(visibleSongs(), i);
  });
  row.querySelector('.row-menu').addEventListener('click', e => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openSongMenu(s, r.left, r.bottom + 4);
  });
  return row;
}

function refreshRowMarks() {
  const pid = playingId();
  $$('#song-list .song-row').forEach(r => r.classList.toggle('playing', r.dataset.id === pid));
}

function updateViewMeta() {
  const isAll = state.view.type === 'all';
  const list = visibleSongs();
  document.getElementById('nav-count').hidden = true;
  if (isAll && state.songs.length) {
    document.getElementById('nav-count').textContent = state.songs.length;
    document.getElementById('nav-count').hidden = false;
  }

  const baseList = state.view.type === 'all'
    ? state.songs
    : (typeof playlistSongs === 'function' ? playlistSongs(state.view.id) : []);
  const total = list.reduce((a, s) => a + (s.duration_sec || 0), 0);
  const mins = total ? '\u00B7 ' + Math.max(1, Math.round(total / 60)) + ' min' : '';
  document.getElementById('view-sub').textContent = state.search.trim()
    ? list.length + ' of ' + baseList.length + ' songs' + mins
    : list.length + (list.length === 1 ? ' song' : ' songs') + mins;

  const actions = document.getElementById('view-actions');
  actions.innerHTML = '';
  if (!isAll && typeof addPlaylistHeaderActions === 'function') {
    addPlaylistHeaderActions(actions);
  }
  if (list.length) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.innerHTML = icon('play', 16) + ' Play';
    b.addEventListener('click', () => setQueue(list, 0));
    actions.appendChild(b);
  }
}

function refreshAll() {
  renderSongList();
  if (typeof renderPlaylistNav === 'function') renderPlaylistNav();
}

/* ---------- song context menu ---------- */
function openSongMenu(s, x, y) {
  const items = [{ header: esc(s.title) }];
  if (state.playlists.length) {
    for (const pl of state.playlists) {
      const inIt = state.plLinks.some(l => l.playlist_id === pl.id && l.song_id === s.id);
      items.push(inIt
        ? { label: '\u2713 ' + pl.name, disabled: true }
        : { label: pl.name, icon: 'note', onclick: () => addToPlaylist(pl, s) });
    }
  } else {
    items.push({ label: 'No playlists yet', disabled: true });
  }
  items.push({ label: 'New playlist with this song', icon: 'plus', onclick: () => createPlaylist(null, s) });
  if (state.view.type === 'playlist') {
    const pl = state.playlists.find(p => p.id === state.view.id);
    if (pl) items.push({ label: 'Remove from this playlist', icon: 'x', onclick: () => removeFromPlaylist(pl, s) });
  }
  items.push('-');
  items.push({ label: 'Delete song', icon: 'trash', danger: true, onclick: () => deleteSong(s) });
  openMenu(items, x, y);
}

/* ---------- delete (server-side) ---------- */
async function deleteSong(s) {
  const ok = await confirmModal('Delete song?',
    '\u201C' + esc(s.title) + '\u201D will be removed from your library, playlists and storage. This can\u2019t be undone.',
    'Delete', true);
  if (!ok) return;

  const res = await fnCall('songs', 'POST', { op: 'delete', id: s.id });
  if (!res.ok) { toast(fnErrText(res), 'error', 7000); return; }

  state.songs = state.songs.filter(x => x.id !== s.id);
  state.plLinks = state.plLinks.filter(l => l.song_id !== s.id);
  streamUrls && streamUrls.delete && streamUrls.delete(s.id);

  if (playingId() === s.id) {
    /* Deleting the song that is playing STOPS playback (pause +
       clear the queue). It must never skip to the next song. */
    stopPlayback();
    toast('Deleted \u201C' + esc(s.title) + '\u201D \u2014 playback stopped');
  } else {
    removeFromQueue(s.id);   // dead entry out of the queue; current song keeps playing
    toast('Deleted \u201C' + esc(s.title) + '\u201D');
  }
  refreshAll();
}

/* ============================================================
   UPLOADS:  browser -> private staging bucket (with progress)
             staging -> GitHub -> library  (Edge Function)
   ============================================================ */
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');

uploadZone.addEventListener('click', e => {
  if (e.target.closest('#upload-list')) return;
  fileInput.click();
});
fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

uploadZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); uploadZone.classList.add('dragging'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragging'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation();
  uploadZone.classList.remove('dragging');
  handleFiles(e.dataTransfer.files);
});

let uploading = false;
function handleFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|flac|wav|ogg|aac|opus|webm)$/i.test(f.name));
  if (!files.length) { toast('Those files aren\u2019t audio \u2014 pick mp3 / m4a / wav / ogg files.', 'warn'); return; }

  /* Skip duplicates of files that are already waiting or uploading
     (same name + size) \u2014 dragging the same songs in twice used to
     upload them twice. */
  const inFlight = new Set(state.uploads
    .filter(u => ['waiting', 'reading', 'uploading', 'saving'].includes(u.status))
    .map(u => u.name + ':' + u.size));
  const fresh = [];
  let skipped = 0;
  for (const f of files) {
    const key = f.name + ':' + f.size;
    if (inFlight.has(key)) { skipped++; continue; }
    inFlight.add(key);
    fresh.push(f);
  }
  if (skipped) {
    toast(skipped + (skipped === 1 ? ' file was' : ' files were') + ' already in the upload list \u2014 skipped.', 'warn', 5000);
  }
  if (!fresh.length) return;

  const pendingCount = state.uploads.filter(u => u.status !== 'done' && u.status !== 'error').length;
  const cap = state.cfg.max_songs_per_user || 200;
  if (state.songs.length + pendingCount + fresh.length > cap) {
    toast('That would pass your limit of ' + cap + ' songs per person. Delete a few first.', 'warn', 6000);
    return;
  }
  for (const f of fresh) {
    state.uploads.push({ file: f, name: f.name, size: f.size, status: 'waiting', pct: 0, err: '' });
  }
  renderUploadList();
  processUploadQueue();
}

function renderUploadList() {
  const wrap = document.getElementById('upload-list');
  wrap.innerHTML = '';
  for (const it of state.uploads) {
    const d = document.createElement('div');
    d.className = 'up-item ' + it.status;
    let meta;
    if (it.status === 'uploading') meta = Math.round(it.pct * 100) + '% \u00B7 uploading...';
    else if (it.status === 'reading') meta = 'Reading tags...';
    else if (it.status === 'saving') meta = 'Saving to your library...';
    else if (it.status === 'done') meta = 'Added to your library';
    else if (it.status === 'error') meta = 'Failed';
    else meta = fmtBytes(it.size) + ' \u00B7 waiting';
    d.innerHTML =
      '<div class="up-name">' + esc(it.name) + '</div>' +
      '<div class="up-meta"><span>' + meta + '</span></div>' +
      '<div class="up-bar"><i style="width:' + Math.round(it.pct * 100) + '%"></i></div>' +
      (it.err ? '<div class="up-err">' + it.err + '</div>' : '') +
      (it.status === 'error'
        ? '<button class="linklike up-retry">Retry</button><button class="linklike up-dismiss">Dismiss</button>'
        : '');
    if (it.status === 'error') {
      const rb = d.querySelector('.up-retry');
      if (rb) rb.addEventListener('click', () => {
        it.status = 'waiting'; it.pct = 0; it.err = '';
        renderUploadList();
        processUploadQueue();
      });
      const db = d.querySelector('.up-dismiss');
      if (db) db.addEventListener('click', () => {
        state.uploads = state.uploads.filter(u => u !== it); renderUploadList();
      });
    }
    wrap.appendChild(d);
  }
}

async function processUploadQueue() {
  if (uploading) return;
  uploading = true;
  try {
    while (true) {
      const it = state.uploads.find(u => u.status === 'waiting');
      if (!it) break;
      await uploadOne(it);
    }
  } finally { uploading = false; }
}

async function uploadOne(it) {
  const f = it.file;
  const maxMb = state.cfg.max_upload_mb || 20;
  if (f.size > maxMb * 1024 * 1024) {
    it.status = 'error'; it.err = 'File is ' + fmtBytes(f.size) + ' \u2014 the limit is ' + maxMb + ' MB per song.';
    renderUploadList(); return;
  }

  /* 1) read tags + duration locally (nothing uploaded yet) */
  it.status = 'reading'; renderUploadList();
  let tags = null;
  try { tags = await readTags(f); } catch { /* tags are optional */ }
  const dur = await readDuration(f);
  const title = (tags && tags.title) || f.name.replace(/\.[^.]+$/, '');
  const thumb = (tags && tags.picture) ? await makeThumb(tags.picture) : null;

  /* 2) upload to the private staging bucket (progress bar) */
  const stagingPath = state.user.id + '/' + Date.now() + '-' + slugify(f.name) +
                      (f.name.match(/\.[a-z0-9]{1,5}$/i) ? f.name.match(/\.[a-z0-9]{1,5}$/i)[0] : '.mp3');
  it.status = 'uploading'; it.pct = 0.02; renderUploadList();
  try {
    await stagingUpload(stagingPath, f, pct => {
      it.pct = Math.max(it.pct, pct * 0.88); renderUploadList();
    });
  } catch (e) {
    it.status = 'error'; it.err = esc(e.message); renderUploadList(); return;
  }

  /* 3) ask the Edge Function to move it to GitHub + save the row */
  it.status = 'saving'; it.pct = 0.92; renderUploadList();
  const res = await fnCall('upload-song', 'POST', {
    staging_path: stagingPath,
    file_name: f.name,
    file_size: f.size,
    duration_sec: dur,
    title: title.slice(0, 300),
    artist: ((tags && tags.artist) || '').slice(0, 200) || null,
    album: ((tags && tags.album) || '').slice(0, 200) || null,
    cover_data: thumb,
  });

  if (!res.ok || !res.data || !res.data.song) {
    it.status = 'error'; it.err = fnErrText(res); renderUploadList(); return;
  }

  state.songs.unshift(res.data.song);
  it.status = 'done'; it.pct = 1; renderUploadList();
  refreshAll();
  setTimeout(() => {
    state.uploads = state.uploads.filter(u => u !== it);
    if (state.uploads.length) renderUploadList(); else document.getElementById('upload-list').innerHTML = '';
  }, 5000);
}

/* ---------- helpers ---------- */
function slugify(name) {
  const base = name.toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'song';
}

function readTags(file) {
  return new Promise((resolve, reject) => {
    if (!window.jsmediatags) { reject(new Error('no lib')); return; }
    const timer = setTimeout(() => reject(new Error('timeout')), 6000);
    try {
      window.jsmediatags.read(file, {
        onSuccess: t => { clearTimeout(timer); resolve(t.tags || {}); },
        onError: () => { clearTimeout(timer); reject(new Error('no tags')); },
      });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

function readDuration(file) {
  return new Promise(resolve => {
    const a = document.createElement('audio');
    const u = URL.createObjectURL(file);
    const done = v => { URL.revokeObjectURL(u); a.src = ''; resolve(v); };
    const t = setTimeout(() => done(null), 5000);
    a.onloadedmetadata = () => { clearTimeout(t); done(isFinite(a.duration) ? Math.round(a.duration) : null); };
    a.onerror = () => { clearTimeout(t); done(null); };
    a.src = u;
  });
}

async function makeThumb(picture) {
  try {
    const blob = new Blob([new Uint8Array(picture.data)], { type: picture.format || 'image/jpeg' });
    let w, h, src;
    if (window.createImageBitmap) {
      const bmp = await createImageBitmap(blob);
      w = bmp.width; h = bmp.height; src = bmp;
    } else {
      const img = await new Promise((res, rej) => {
        const u = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(u); res(im); };
        /* revoke even on failure \u2014 otherwise the blob URL leaks */
        im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('image decode failed')); };
        im.src = u;
      });
      w = img.width; h = img.height; src = img;
    }
    const size = 200;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    const sc = size / Math.max(w, h);
    ctx.drawImage(src, (size - w * sc) / 2, (size - h * sc) / 2, w * sc, h * sc);
    return c.toDataURL('image/jpeg', 0.78);
  } catch { return null; }
}
