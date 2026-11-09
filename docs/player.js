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
let history = [];        // previously-played song IDs (for "previous", esp. in shuffle)
let shuffleDeck = [];    // Fisher-Yates deck of unplayed song IDs (shuffle mode)
let shuffle = false;
let repeat = 0;          // 0 = off, 1 = repeat all, 2 = repeat one
let seekDragging = false;
let srcTry = { songId: null, n: 0 };   // retry state for playback links
let playToken = 0;       // guards against a stale playback URL response overwriting a newer selection
let audioPrimed = false; // mobile: the audio element has been unlocked by a real user gesture
let priming = false;     // true while the silent primer clip is playing (mobile unlock)

const streamUrls = new Map();          // songId -> { url, exp }

function currentSong() { return queue[qpos] || null; }
function playingId() { const s = currentSong(); return s ? s.id : null; }

/* ---------- queue ---------- */
function setQueue(list, startIndex = 0) {
  queue = list.slice();
  history = [];
  qpos = Math.max(0, Math.min(startIndex, queue.length - 1));
  rebuildShuffleDeck();
  playCurrent();
}

/* Shuffle uses a pre-shuffled deck of song IDs instead of rolling dice.
   Every song plays exactly once before anything repeats; when the deck
   runs out, repeat-all reshuffles and repeat-off simply stops. */
function rebuildShuffleDeck() {
  const cur = currentSong();
  const ids = queue.filter(s => !cur || s.id !== cur.id).map(s => s.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  shuffleDeck = ids;
}

function nextIndex() {
  if (!queue.length) return -1;
  if (!shuffle) return qpos + 1 < queue.length ? qpos + 1 : (repeat === 1 ? 0 : -1);
  while (shuffleDeck.length) {
    const i = queue.findIndex(s => s.id === shuffleDeck[0]);
    shuffleDeck.shift();
    if (i >= 0) return i;
  }
  if (repeat !== 1) return -1;          // every song played once -> stop (repeat off)
  rebuildShuffleDeck();                  // repeat all: a fresh shuffled cycle
  while (shuffleDeck.length) {
    const i = queue.findIndex(s => s.id === shuffleDeck[0]);
    shuffleDeck.shift();
    if (i >= 0) return i;
  }
  return queue.length === 1 ? 0 : -1;   // single-song queue, repeat on
}

function playNext(auto = false) {
  if (!queue.length) return;
  if (auto && repeat === 2) { audioEl.currentTime = 0; audioEl.play().catch(() => {}); return; }
  const cur = currentSong();
  const i = nextIndex();
  if (i < 0) { audioEl.pause(); setPlayIcon(false); return; }
  if (cur) {
    history.push(cur.id);
    if (history.length > 300) history.shift();  // cap memory on long sessions
  }
  qpos = i;
  playCurrent();
}

function playPrev() {
  if (!queue.length) return;
  if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
  let target = -1;
  while (history.length) {               // history stores song IDs, not indexes:
    const id = history.pop();             // deleting a song can never corrupt it
    const i = queue.findIndex(x => x.id === id);
    if (i >= 0) { target = i; break; }
  }
  if (target < 0 && qpos > 0) target = qpos - 1;
  if (target < 0) { audioEl.currentTime = 0; return; }
  qpos = target;
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
  queue = []; qpos = -1; history = []; shuffleDeck = [];
  audioEl.pause();
  audioEl.removeAttribute('src'); audioEl.load();
  updatePlayerBar(null);
  if (typeof refreshRowMarks === 'function') refreshRowMarks();
}

/* Drop a deleted song from the queue without touching whatever is
   currently playing. Deleting the PLAYING song is the caller's
   business: it must call stopPlayback() — playback never
   auto-advances in that case. Works on song IDs, so it also prunes
   the shuffle deck and the history cleanly. */
function removeFromQueue(songId) {
  const idx = queue.findIndex(x => x.id === songId);
  if (idx < 0 || idx === qpos) return;
  queue.splice(idx, 1);
  if (idx < qpos) qpos--;
  history = history.filter(id => id !== songId);
  shuffleDeck = shuffleDeck.filter(id => id !== songId);
  renderQueuePanel();
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
async function playCurrent(resumeAt = 0) {
  const s = currentSong();
  if (!s) return;
  const token = ++playToken;          // if a newer selection starts while we
  updatePlayerBar(s);                  // fetch, this response gets dropped
  if (typeof refreshRowMarks === 'function') refreshRowMarks();
  const link = await getStreamUrl(s);
  if (token !== playToken) return;     // a newer song was selected — stand down
  if (!link.ok) {
    toast('Could not get a playback link for <b>' + esc(s.title) + '</b>: ' + link.error, 'error', 7000);
    setPlayIcon(false);
    return;
  }
  audioEl.src = link.url;
  /* If we are re-fetching after an error (e.g. the signed link expired
     mid-song), resume from where the song was instead of restarting. */
  if (resumeAt > 1 && isFinite(resumeAt)) {
    const pos = resumeAt;
    audioEl.addEventListener('loadedmetadata', () => {
      if (audioEl.duration && pos < audioEl.duration - 1) {
        try { audioEl.currentTime = pos; } catch { /* seek not ready yet */ }
      }
    }, { once: true });
  }
  audioEl.play().catch(() => {});
  setMediaSession(s);
}

/* If the signed link went stale mid-session, mint a fresh one and retry
   once — RESUMING the position instead of restarting the song. */
audioEl.addEventListener('error', () => {
  if (priming) return;                 // the mobile primer clip is allowed to fail
  const s = currentSong();
  if (!s || !audioEl.src) return;
  if (srcTry.songId === s.id && srcTry.n >= 1) {
    toast('Could not load <b>' + esc(s.title) + '</b>. Check your connection and try again.', 'error', 6000);
    return;
  }
  srcTry = { songId: s.id, n: srcTry.songId === s.id ? srcTry.n + 1 : 1 };
  streamUrls.delete(s.id);
  const pos = audioEl.currentTime || 0;   // remember where the song was
  playCurrent(pos > 1 ? pos : 0);
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
    renderQueuePanel();
    return;
  }
  cover.style.cssText = coverTileStyle(s.id);
  cover.innerHTML = s.cover_data
    ? safeCoverImg(s.cover_data)             // validated + injection-safe (ui.js)
    : '<span class="pc-cover-note"></span>';
  title.textContent = s.title;
  artist.textContent = s.artist || 'Unknown artist';
  document.title = '\u25B6 ' + s.title + ' \u00B7 ' + APP_NAME;
  renderQueuePanel();
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
      artwork: [{ src: SAFE_COVER_RE.test(s.cover_data || '') ? s.cover_data : svgArtwork(s.id),
                  sizes: '200x200', type: 'image/jpeg' }],
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
  if (shuffle) rebuildShuffleDeck(); else shuffleDeck = [];
  localStorage.setItem('om-shuffle', shuffle ? '1' : '0');
  toast(shuffle ? 'Shuffle on' : 'Shuffle off', 'ok', 1600);
  renderQueuePanel();
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
audioEl.addEventListener('ratechange', updateMediaPosition);
audioEl.addEventListener('ended', () => {
  if (priming || !audioEl.duration) return;   // the 0-duration primer clip must not advance the queue
  playNext(true);
});

/* Playback actually started (not just "play requested"):
   re-arm the error retry and mark the element as gesture-unlocked. */
audioEl.addEventListener('playing', () => {
  audioPrimed = true;
  priming = false;
  srcTry = { songId: null, n: 0 };   // healthy again: a future glitch may retry once
  updateMediaPosition();
});

/* ---------- lock-screen / OS scrubber (Media Session position state) ---------- */
function updateMediaPosition() {
  if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
  const d = audioEl.duration;
  if (!d || !isFinite(d)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: audioEl.playbackRate || 1,
      position: Math.min(audioEl.currentTime, d),
    });
  } catch { /* called in a state the OS rejects — harmless */ }
}
audioEl.addEventListener('timeupdate', updateMediaPosition);

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

/* media session action handlers (including lock-screen seeking) */
if ('mediaSession' in navigator) {
  const handlers = [
    ['play', () => audioEl.play().catch(() => {})],
    ['pause', () => audioEl.pause()],
    ['previoustrack', playPrev],
    ['nexttrack', () => playNext(false)],
    ['seekbackward', () => { audioEl.currentTime = Math.max(0, audioEl.currentTime - 10); }],
    ['seekforward', () => { if (audioEl.duration) audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + 10); }],
    ['seekto', d => {
      if (d && isFinite(d.seekTime) && d.seekTime >= 0 && audioEl.duration) {
        audioEl.currentTime = Math.min(d.seekTime, audioEl.duration);
      }
    }],
  ];
  for (const [name, fn] of handlers) {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* not supported on this device */ }
  }
}

/* ============================================================
   Up-next queue panel (bottom-right, above the player bar)
   ============================================================ */
const queuePanel = document.getElementById('queue-panel');

function renderQueuePanel() {
  if (!queuePanel) return;
  const list = queuePanel.querySelector('#qp-list');
  const count = queuePanel.querySelector('#qp-count');
  const rows = [];
  const cur = currentSong();
  if (cur) rows.push({ s: cur, now: true });
  if (shuffle) {
    for (const id of shuffleDeck) {
      const s = queue.find(x => x.id === id);
      if (s) rows.push({ s, now: false });
    }
  } else {
    for (let i = qpos + 1; i < queue.length; i++) rows.push({ s: queue[i], now: false });
  }
  if (count) count.textContent = rows.length ? (rows.length - 1) + ' queued' : '';
  if (!list) return;
  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="qp-empty">Queue is empty — play something!</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const s = r.s;
    const d = document.createElement('div');
    d.className = 'qp-row' + (r.now ? ' now' : '');
    d.innerHTML =
      '<span class="qp-cover" style="' + coverTileStyle(s.id) + '">' + coverHtml(s) + '</span>' +
      '<span class="qp-meta"><b>' + esc(s.title) + '</b><span>' +
        esc(r.now ? 'Now playing' : (s.artist || 'Unknown artist')) + '</span></span>' +
      '<span class="qp-dur">' + fmtTime(s.duration_sec) + '</span>' +
      (r.now ? '' : '<button class="icon-btn qp-x" title="Remove from queue">' + icon('x', 14) + '</button>');
    d.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      if (r.now) { togglePlay(); return; }        // tap the current song = play/pause
      queueJump(s.id);
    });
    const xb = d.querySelector('.qp-x');
    if (xb) xb.addEventListener('click', e => { e.stopPropagation(); queueRemove(s.id); });
    frag.appendChild(d);
  }
  list.appendChild(frag);
}

function queueJump(songId) {
  const idx = queue.findIndex(x => x.id === songId);
  if (idx < 0) return;
  const cur = currentSong();
  if (cur && cur.id !== songId) history.push(cur.id);
  shuffleDeck = shuffleDeck.filter(id => id !== songId);
  qpos = idx;
  playCurrent();
}

function queueRemove(songId) {
  const idx = queue.findIndex(x => x.id === songId);
  if (idx < 0) return;
  if (idx === qpos) {
    toast('That song is playing — it can\u2019t be removed from the queue.', 'warn');
    return;
  }
  removeFromQueue(songId);
}

document.getElementById('btn-queue').addEventListener('click', () => {
  queuePanel.hidden = !queuePanel.hidden;
  renderQueuePanel();
});
queuePanel.querySelector('#qp-close').addEventListener('click', () => { queuePanel.hidden = true; });

/* ============================================================
   Mobile autoplay unlock: iOS/Android only allow playback that is
   initiated (directly or via an already-unlocked element) by a user
   gesture. playCurrent() awaits a network call before .play(), which
   destroys the gesture context. So on touch devices we "unlock" the
   audio element on the FIRST tap by playing a silent clip inside the
   gesture — after that, programmatic play() is allowed forever.
   ============================================================ */
const SILENCE_SRC = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
(function wireAutoplayUnlock() {
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if (!coarse) { audioPrimed = true; return; }   // desktop/mouse: no gesture restriction
  document.addEventListener('pointerdown', () => {
    if (audioPrimed || priming) return;
    if (audioEl.currentSrc || audioEl.getAttribute('src')) return;  // real track loaded — the play button path already works
    priming = true;
    audioEl.src = SILENCE_SRC;
    const p = audioEl.play();
    if (p && p.then) p.then(() => { if (audioEl.src === SILENCE_SRC) audioEl.pause(); }).catch(() => {});
    setTimeout(() => { priming = false; }, 500);
  }, true);
})();
(function restorePrefs() {
  const v = parseInt(localStorage.getItem('om-vol') ?? '90', 10);
  applyVolume(isFinite(v) ? v : 90, true);
  shuffle = localStorage.getItem('om-shuffle') === '1';
  btnShuffle.classList.toggle('on', shuffle);
  const r = parseInt(localStorage.getItem('om-repeat') ?? '0', 10);
  if (isFinite(r)) repeat = r;
  btnRepeat.classList.toggle('on', repeat > 0);
})();
