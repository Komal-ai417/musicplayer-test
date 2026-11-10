'use strict';
/* ============================================================
   admin.js - administrator user management.
   The frontend NEVER decides who is an admin: after sign-in it
   asks the delete-user Edge Function (GET). Only that function's
   200 response reveals admin status; a 403 simply hides the UI.
   The server-side ADMIN_USER_ID secret stays authoritative for
   every request, whatever this UI shows.
   Deletion runs in stages with a progress checklist, resuming
   automatically when the server reports a partial batch.
   ============================================================ */

let adminCheckedFor = null;   // user.id we already asked the server about

/* Called from app.js after the Supabase client exists. */
function initAdmin() {
  if (!state.sb) return;
  state.sb.auth.onAuthStateChange((evt, session) => {
    if ((evt === 'INITIAL_SESSION' || evt === 'SIGNED_IN') && session) {
      checkAdmin(session.user);
    } else if (evt === 'SIGNED_OUT') {
      state.isAdmin = false;
      adminCheckedFor = null;
      const nav = document.getElementById('nav-users');
      if (nav) nav.hidden = true;
      if (state.view.type === 'admin-users') showView({ type: 'all' });
    }
  });
}

async function checkAdmin(user) {
  if (!user || adminCheckedFor === user.id) return;
  adminCheckedFor = user.id;
  const res = await fnCall('delete-user', 'GET');
  if (res.status === 401) return;              // session hiccup — fnCall already retried once
  state.isAdmin = res.ok;                      // 403 or network error -> not admin here
  if (res.ok && res.data && Array.isArray(res.data.users)) {
    state.adminUsers = res.data.users;
  }
  const nav = document.getElementById('nav-users');
  if (nav) nav.hidden = !state.isAdmin;
}

document.getElementById('nav-users').addEventListener('click', () => {
  if (state.isAdmin) showView({ type: 'admin-users' });
});

function updateAdminNav(view) {
  const nav = document.getElementById('nav-users');
  if (nav) nav.classList.toggle('active', view.type === 'admin-users');
}

/* ---------- the users view (hooked into renderSongList) ---------- */
function renderAdminView() {
  if (state.view.type !== 'admin-users') return false;
  if (!state.isAdmin) { showView({ type: 'all' }); return true; }
  renderAdminViewAsync();   // fire-and-forget async load
  return true;
}

async function renderAdminViewAsync() {
  document.getElementById('table-head').hidden = true;
  document.getElementById('empty-state').hidden = true;
  document.getElementById('search-empty').hidden = true;
  document.getElementById('view-title').textContent = 'Users';
  document.getElementById('view-sub').textContent = 'Administrator \u00B7 account management';
  const actions = document.getElementById('view-actions');
  actions.innerHTML = '';

  const wrap = document.getElementById('song-list');
  wrap.innerHTML = '<div class="state-block"><div class="spinner" aria-hidden="true"></div><p class="muted">Loading users...</p></div>';

  const res = await fnCall('delete-user', 'GET');
  if (!res.ok) {
    wrap.innerHTML =
      '<div class="state-block"><div class="state-icon moon" aria-hidden="true"></div>' +
      '<h3>Couldn\u2019t load the user list</h3>' +
      '<p class="muted">' + fnErrText(res) + '</p>' +
      '<button class="btn btn-primary" id="admin-retry">Try again</button></div>';
    const b = document.getElementById('admin-retry');
    if (b) b.addEventListener('click', () => renderAdminView());
    return true;
  }
  state.adminUsers = (res.data && res.data.users) || [];
  renderAdminTable(state.adminUsers);
  return true;
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return '\u2014'; }
}

function renderAdminTable(users) {
  const wrap = document.getElementById('song-list');
  wrap.innerHTML = '';

  const tbl = document.createElement('div');
  tbl.className = 'admin-table';
  tbl.innerHTML =
    '<div class="admin-row head">' +
      '<span>Email</span><span>Songs</span><span>Playlists</span>' +
      '<span>Joined</span><span>Last seen</span><span></span>' +
    '</div>';

  const frag = document.createDocumentFragment();
  frag.appendChild(tbl);
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.dataset.id = u.id;
    row.innerHTML =
      '<span class="a-email">' + esc(u.email || '(no email)') +
        (u.is_admin ? ' <span class="badge">admin</span>' : '') + '</span>' +
      '<span>' + (u.song_count ?? 0) + '</span>' +
      '<span>' + (u.playlist_count ?? 0) + '</span>' +
      '<span>' + fmtDate(u.created_at) + '</span>' +
      '<span>' + fmtDate(u.last_sign_in_at) + '</span>' +
      '<span class="a-actions">' +
        (u.is_admin
          ? '<button class="btn btn-ghost" disabled title="This is the administrator account">Protected</button>'
          : '<button class="btn btn-danger btn-sm" data-del="' + esc(u.id) + '">Delete\u2026</button>') +
      '</span>';
    frag.appendChild(row);
  }
  wrap.appendChild(frag);

  wrap.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const u = users.find(x => x.id === btn.dataset.del);
      if (u) confirmDeleteUser(u);
    });
  });
}

/* ---------- deletion flow ---------- */
const STAGE_LABELS = {
  github: 'Audio files removed from the private GitHub songs repo',
  storage: 'Leftover uploads removed from Supabase Storage',
  database: 'Playlists and library entries deleted',
  auth: 'Login account deleted',
};

async function confirmDeleteUser(u) {
  const ok = await confirmModal('Delete this account forever?',
    'This permanently deletes <b>' + esc(u.email || u.id) + '</b>:<br>' +
    '\u2022 ' + (u.song_count ?? 0) + ' audio file' + ((u.song_count ?? 0) === 1 ? '' : 's') + ' from the songs repository<br>' +
    '\u2022 any leftover uploads, playlists and library entries<br>' +
    '\u2022 the login account itself<br><br>' +
    'There is no undo. The administrator account cannot be deleted.',
    'Delete ' + esc(u.email || 'account'), true);
  if (!ok) return;
  await runDeleteUser(u);
}

async function runDeleteUser(u) {
  const card = $('#modal-card');
  $('#modal-layer').hidden = false;
  const stages = ['github', 'storage', 'database', 'auth'];
  card.innerHTML =
    '<h3>Deleting ' + esc(u.email || 'account') + '</h3>' +
    '<div class="modal-body">' +
      '<div class="del-progress"><i id="del-bar" style="width:8%"></i></div>' +
      '<ul class="del-stages">' +
        stages.map(s => '<li data-stage="' + s + '"><span class="dot"></span>' + STAGE_LABELS[s] + '</li>').join('') +
      '</ul>' +
      '<p class="muted tiny" id="del-note">Working \u2014 this can take a minute for big libraries\u2026</p>' +
    '</div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" id="del-cancel">Stop</button></div>';

  const bar = card.querySelector('#del-bar');
  const note = card.querySelector('#del-note');
  const mark = (stage, stateCls) => {
    const li = card.querySelector('[data-stage="' + stage + '"]');
    if (li) li.className = stateCls;
  };
  const setNote = t => { if (note) note.textContent = t; };

  let cancelled = false;
  card.querySelector('#del-cancel').addEventListener('click', () => {
    cancelled = true;
    closeModal();
    toast('Stopped. Cleanup done so far is kept, and pressing Delete\u2026 again safely resumes where it stopped.', 'warn', 7000);
  });

  const MAX_ROUNDS = 40;   // 40 rounds x 40 files = 1600 files, then we stop and say so
  let cursor = 0;          // resumable github stage: where the last batch stopped
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (cancelled) return;
    const res = await fnCall('delete-user', 'POST', { user_id: u.id, cursor });

    if (!res.ok) {
      closeModal();
      toast('Deletion failed at stage <b>' + esc((res.data && res.data.stage) || 'unknown') +
        '</b>: ' + fnErrText(res) + '<br>Nothing else was deleted after that point \u2014 press Delete again to retry safely.', 'error', 12000);
      renderAdminView();
      return;
    }
    const d = res.data || {};
    if (d.done) {
      bar.style.width = '100%';
      for (const s of stages) mark(s, 'ok');
      setNote('Done.');
      setTimeout(closeModal, 700);
      toast('Deleted <b>' + esc(u.email || u.id) + '</b> \u2014 files, playlists and account.', 'ok', 6000);
      renderAdminView();
      return;
    }
    // partial batch (stage github reports progress) — continue from the cursor
    if (d.stage === 'github' && d.progress) {
      if (typeof d.cursor === 'number') cursor = d.cursor;
      bar.style.width = Math.max(8, Math.round(100 * d.progress.files_done / Math.max(1, d.progress.files_total))) + '%';
      mark('github', 'active');
      setNote('Removing audio files \u2014 ' + d.progress.files_done + ' of ' + d.progress.files_total + ' done\u2026');
    }
  }
  closeModal();
  toast('This library is too large to finish in one sitting. Press Delete\u2026 again to resume \u2014 it continues where it stopped.', 'warn', 10000);
  renderAdminView();
}
