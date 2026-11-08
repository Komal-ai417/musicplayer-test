'use strict';
/* ============================================================
   ui.js - shared state + small DOM / formatting helpers
   ============================================================ */

const state = {
  sb: null,          // supabase client
  session: null,
  user: null,
  ghToken: '',       // GitHub token, fetched from app_config after login
  cfg: { max_songs_per_user: 200, max_upload_mb: 20 },
  songs: [],         // my songs, newest first
  playlists: [],
  plLinks: [],       // all playlist_songs rows (mine)
  view: { type: 'all', id: null },
  search: '',
  uploads: [],       // pending upload items
  ready: false,
};

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '\u2013:\u2013\u2013';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

function hueFromString(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

/* ---------- icons ---------- */
const ICONS = {
  note:   '<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>',
  play:   '<path d="M8 5v14l11-7z"/>',
  pause:  '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>',
  prev:   '<path d="M6 6h2v12H6zm12 0v12l-8.5-6z"/>',
  next:   '<path d="M6 6l8.5 6L6 18zM16 6h2v12h-2z"/>',
  shuffle:'<path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
  repeat: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>',
  vol:    '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>',
  volOff: '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/>',
  plus:   '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  trash:  '<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  dots:   '<path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  playCircle: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 14.5v-9l6 4.5-6 4.5z"/>',
  pencil: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
  x:      '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
};

function icon(name, size = 18) {
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size +
         '" fill="currentColor" aria-hidden="true">' + ICONS[name] + '</svg>';
}

/* paint a filled range slider */
function paintRange(el, pct) {
  el.style.background = 'linear-gradient(to right,#1db954 ' + pct + '%,#4d4d4d ' + pct + '%)';
}

/* ---------- toasts ---------- */
function toast(msg, type = 'ok', ms = 4000) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), ms - 350);
  setTimeout(() => t.remove(), ms);
}

/* ---------- context menu ---------- */
let menuCloseHandler = null;
function openMenu(items, x, y) {
  closeMenu();
  const layer = $('#menu-layer');
  const m = document.createElement('ul');
  m.className = 'menu';
  for (const it of items) {
    if (it === '-') { const s = document.createElement('li'); s.className = 'menu-sep'; m.appendChild(s); continue; }
    const li = document.createElement('li');
    if (it.header) { li.className = 'menu-head'; li.textContent = it.header; m.appendChild(li); continue; }
    li.className = (it.danger ? 'danger ' : '') + (it.disabled ? 'dis' : '');
    if (it.icon) li.innerHTML = icon(it.icon, 16) + '<span>' + esc(it.label) + '</span>';
    else li.textContent = it.label;
    if (!it.disabled && it.onclick) li.addEventListener('click', () => { closeMenu(); it.onclick(); });
    m.appendChild(li);
  }
  layer.innerHTML = '';
  layer.appendChild(m);
  layer.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  menuCloseHandler = e => { if (!m.contains(e.target)) closeMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', menuCloseHandler), 0);
}
function closeMenu() {
  $('#menu-layer').hidden = true;
  $('#menu-layer').innerHTML = '';
  if (menuCloseHandler) { document.removeEventListener('pointerdown', menuCloseHandler); menuCloseHandler = null; }
}

/* ---------- modal ---------- */
function closeModal() { $('#modal-layer').hidden = true; $('#modal-card').innerHTML = ''; }

function confirmModal(title, bodyHtml, okText = 'OK', danger = false) {
  return new Promise(resolve => {
    const card = $('#modal-card');
    card.innerHTML =
      '<h3>' + esc(title) + '</h3>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" data-x="0">Cancel</button>' +
        '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-x="1">' + esc(okText) + '</button>' +
      '</div>';
    $('#modal-layer').hidden = false;
    $$('[data-x]', card).forEach(b => b.addEventListener('click', () => {
      closeModal(); resolve(b.dataset.x === '1');
    }));
  });
}

function promptModal(title, bodyHtml, placeholder = '', initial = '') {
  return new Promise(resolve => {
    const card = $('#modal-card');
    card.innerHTML =
      '<h3>' + esc(title) + '</h3>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<input type="text" placeholder="' + esc(placeholder) + '" value="' + esc(initial) + '" />' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" data-x="0">Cancel</button>' +
        '<button class="btn btn-primary" data-x="1">Save</button>' +
      '</div>';
    const inp = $('input', card);
    inp.value = initial;
    $('#modal-layer').hidden = false;
    inp.focus(); inp.select();
    const done = v => { closeModal(); resolve(v); };
    $$('[data-x]', card).forEach(b => b.addEventListener('click', () => done(b.dataset.x === '1' ? inp.value.trim() : null)));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') done(inp.value.trim());
      if (e.key === 'Escape') done(null);
    });
  });
}

/* ---------- cover art helpers ---------- */
function coverTileStyle(id) {
  const h = hueFromString(id);
  return 'background:linear-gradient(135deg,hsl(' + h + ',42%,38%),hsl(' + ((h + 50) % 360) + ',42%,20%))';
}

function coverHtml(song, size) {
  if (song.cover_data) return '<img src="' + song.cover_data + '" alt="" loading="lazy" />';
  return '<span class="note-mark" style="' + (size ? '' : '') + '"></span>';
}

/* small SVG data-uri artwork for the lock screen (when a song has no cover) */
function svgArtwork(id) {
  const h = hueFromString(id);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="hsl(' + h + ',42%,38%)"/>' +
    '<stop offset="1" stop-color="hsl(' + ((h + 50) % 360) + ',42%,20%)"/>' +
    '</linearGradient></defs>' +
    '<rect width="200" height="200" fill="url(#g)"/>' +
    '<path transform="translate(64,50) scale(3)" fill="rgba(255,255,255,.92)" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>' +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
