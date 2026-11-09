'use strict';
/* ============================================================
   player.js - the audio engine + bottom player bar
   Songs now play through short-lived signed links minted by
   the "songs" Edge Function - the browser never sees GitHub
   URLs or any token.
   ============================================================ */

const audioEl = document.getElementById('audio');

let queue = [];          // songs in the current play order
let qpos = -1;           // index in queue
let history = [];        // played indexes (for "previous" in shuffle mode)
let shuffle = false;
let repeat = 0;          // 0 = off, 1 = repeat all, 2 = repeat one
let seekDragging = false;
let srcTry = { songId: null, n: 0 };   // retry state for playback links

const streamUrls = new Map();          // songId -> { url, exp }

function currentSong() { return queue[qpos] || null; }
function playingId() { const s = currentSong(); return s ? s.id : null; }

/* ---------- queue ---------- */
function setQueue(list, startIndex = 0) {
  queue = list.slice();
  history = [];
  qpos = Math.max(0, Math.min(startIndex, queue.length - 1));
  playCurrent();
}

function nextIndex() {
  if (!queue.length) return -1;
  if (!shuffle) return qpos + 1 < queue.length ? qpos + 1 : (repeat === 1 ? 0 : -1);
  if (queue.length === 1) return repeat === 1 ? 0 : -1;
  let i;
  do { i = Math.floor(Math.random() * queue.length); } while (i === qpos);
  return i;
}

function playNext(auto = false) {
  if (!queue.length) return;
  if (auto && repeat === 2) { audioEl.currentTime = 0; audioEl.play().catch(() => {}); return; }
  const i = nextIndex();
  if (i < 0) { audioEl.pause(); setPlayIcon(false); return; }
  history.push(qpos);
  qpos = i;
  playCurrent();
}

function playPrev() {
  if (!queue.length) return;
  if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
  if (history.length) qpos = history.pop();
  else if (qpos > 0) qpos--;
  else { audioEl.currentTime = 0; return; }
  playCurrent();
}

function togglePlay() {
  if (!currentSong()) {
    const list = (typeof visibleSongs === 'function') ? visibleSongs() : [];
    if (list.length) setQueue(list, 0);
    return;
  }
  if (audioEl.paused) audioEl.play().catch(() => {}); else audioEl.pause();
}

function stopPlayback() {
  queue = []; qpos = -1; history = [];
  audioEl.pause();
  audioEl.removeAttribute('src'); audioEl.load();
  updatePlayerBar(null);
  if (typeof refreshRowMarks === 'function') refreshRowMarks();
}

/* Drop a deleted song from the queue without touching whatever is
   currently playing. Deleting the PLAYING song is the caller's
   business: it must call stopPlayback() — playback never
   auto-advances in that case. */
function removeFromQueue(songId) {
  const idx = queue.findIndex(x => x.id === songId);
  if (idx < 0 || idx === qpos) return;
  queue.splice(idx, 1);
  if (idx < qpos) qpos--;
  history = history.filter(i => i !== idx).map(i => i > idx ? i - 1 : i);
}

/* ---------- playback link (Edge Function) ---------- */
async function getStreamUrl(song) {
  const c = streamUrls.get(song.id);
  if (c && c.exp - Math.floor(Date.now() / 1000) > 300) return { ok: true, ...c };
  const res = await fnCall('songs', 'POST', { op: 'stream-url', id: song.id });
  if (res.ok && res.data && res.data.url) {
    const entry = { url: res.data.url, exp: res.data.expires_at || 0 };
    streamUrls.set(song.id, entry);
    return { ok: true, ...entry };
  }
  return { ok: false, error: fnErrText(res) };
}

/* ---------- play current ---------- */
async function playCurrent() {
  const s = currentSong();
  if (!s) return;
  updatePlayerBar(s);
  if (typeof refreshRowMarks === 'function') refreshRowMarks();
  const link = await getStreamUrl(s);
  if (!link.ok) {
    toast('Could not get a playback link for <b>' + esc(s.title) + '</b>: ' + link.error, 'error', 7000);
    setPlayIcon(false);
    return;
  }
  audioEl.src = link.url;
  audioEl.play().catch(() => {});
  setMediaSession(s);
}

/* If the signed link went stale mid-session, mint a fresh one and retry once. */
audioEl.addEventListener('error', () => {
  const s = currentSong();
  if (!s || !audioEl.src) return;
  if (srcTry.songId === s.id && srcTry.n >= 1) {
    toast('Could not load <b>' + esc(s.title) + '</b>. Check your connection and try again.', 'error', 6000);
    return;
  }
  srcTry = { songId: s.id, n: srcTry.songId === s.id ? srcTry.n + 1 : 1 };
  streamUrls.delete(s.id);
  playCurrent();
});

function updatePlayerBar(s) {
  const cover = document.getElementById('pc-cover');
  const title = document.getElementById('pc-title');
  const artist = document.getElementById('pc-artist');
  if (!s) {
    cover.style.cssText = '';
    cover.innerHTML = '<span class="pc-cover-note"></span>';
    title.textContent = 'Nothing playing';
    artist.textContent = 'Pick a song to start';
    document.title = APP_NAME;
    return;
  }
  cover.style.cssText = coverTileStyle(s.id);
  cover.innerHTML = s.cover_data
    ? '<img src="' + s.cover_data + '" alt="" />'
    : '<span class="pc-cover-note"></span>';
  title.textContent = s.title;
  artist.textContent = s.artist || 'Unknown artist';
  document.title = '\u25B6 ' + s.title + ' \u00B7 ' + APP_NAME;
}

function setPlayIcon(playing) {
  document.querySelector('#btn-play .ico-play').hidden = playing;
  document.querySelector('#btn-play .ico-pause').hidden = !playing;
  document.getElementById('btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/* ---------- media session (lock screen / media keys) ---------- */
function setMediaSession(s) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title,
      artist: s.artist || 'Unknown artist',
      album: s.album || '',
      artwork: [{ src: s.cover_data || svgArtwork(s.id), sizes: '200x200',
                  type: s.cover_data ? 'image/jpeg' : 'image/svg+xml' }],
    });
  } catch { /* ignore */ }
}

/* ---------- wire up the bar ---------- */
document.getElementById('btn-play').addEventListener('click', togglePlay);
document.getElementById('btn-next').addEventListener('click', () => playNext(false));
document.getElementById('btn-prev').addEventListener('click', playPrev);

const btnShuffle = document.getElementById('btn-shuffle');
btnShuffle.addEventListener('click', () => {
  shuffle = !shuffle;
  btnShuffle.classList.toggle('on', shuffle);
  localStorage.setItem('om-shuffle', shuffle ? '1' : '0');
  toast(shuffle ? 'Shuffle on' : 'Shuffle off', 'ok', 1600);
});

const btnRepeat = document.getElementById('btn-repeat');
btnRepeat.addEventListener('click', () => {
  repeat = (repeat + 1) % 3;
  btnRepeat.classList.toggle('on', repeat > 0);
  btnRepeat.title = repeat === 2 ? 'Repeat: this song' : (repeat === 1 ? 'Repeat: all' : 'Repeat: off');
  localStorage.setItem('om-repeat', String(repeat));
  toast(repeat === 2 ? 'Repeating this song' : repeat === 1 ? 'Repeating all' : 'Repeat off', 'ok', 1600);
});

/* seek */
const seekEl = document.getElementById('seek');
seekEl.addEventListener('pointerdown', () => { seekDragging = true; });
seekEl.addEventListener('pointerup', () => { seekDragging = false; });
seekEl.addEventListener('input', () => {
  paintRange(seekEl, (seekEl.value / 1000) * 100);
  if (audioEl.duration) document.getElementById('time-cur').textContent = fmtTime(audioEl.duration * seekEl.value / 1000);
});
seekEl.addEventListener('change', () => {
  if (audioEl.duration) audioEl.currentTime = audioEl.duration * seekEl.value / 1000;
});

audioEl.addEventListener('timeupdate', () => {
  if (!seekDragging && audioEl.duration) {
    seekEl.value = Math.round(audioEl.currentTime / audioEl.duration * 1000);
    paintRange(seekEl, (seekEl.value / 1000) * 100);
  }
  document.getElementById('time-cur').textContent = fmtTime(audioEl.currentTime);
});
audioEl.addEventListener('loadedmetadata', () => {
  document.getElementById('time-dur').textContent = fmtTime(audioEl.duration);
});
audioEl.addEventListener('play', () => setPlayIcon(true));
audioEl.addEventListener('pause', () => setPlayIcon(false));
audioEl.addEventListener('ended', () => playNext(true));

/* volume */
const volEl = document.getElementById('vol');
const btnMute = document.getElementById('btn-mute');
let lastVol = 90;
function applyVolume(v, quiet) {
  audioEl.volume = v / 100;
  volEl.value = v;
  paintRange(volEl, v);
  btnMute.innerHTML = icon(v == 0 ? 'volOff' : 'vol');
  if (!quiet) localStorage.setItem('om-vol', String(v));
  if (v > 0) lastVol = v;
}
volEl.addEventListener('input', () => applyVolume(+volEl.value));
btnMute.addEventListener('click', () => applyVolume(+volEl.value == 0 ? lastVol || 90 : 0));

/* keyboard: space = play/pause, arrows = seek */
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight' && audioEl.duration) audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + 10);
  if (e.code === 'ArrowLeft' && audioEl.duration) audioEl.currentTime = Math.max(0, audioEl.currentTime - 10);
});

/* media session action handlers */
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => audioEl.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => audioEl.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext(false));
  } catch { /* ignore */ }
}

/* restore prefs */
(function restorePrefs() {
  const v = parseInt(localStorage.getItem('om-vol') ?? '90', 10);
  applyVolume(isFinite(v) ? v : 90, true);
  shuffle = localStorage.getItem('om-shuffle') === '1';
  btnShuffle.classList.toggle('on', shuffle);
  const r = parseInt(localStorage.getItem('om-repeat') ?? '0', 10);
  if (isFinite(r)) repeat = r;
  btnRepeat.classList.toggle('on', repeat > 0);
})();
