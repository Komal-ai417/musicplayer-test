'use strict';
/* ============================================================
   app.js - Supabase auth, screens, bootstrapping.
   The browser only uses the anon key + the user's own session.
   The invite code is validated INSIDE the database (trigger),
   not in JavaScript.
   ============================================================ */

/* ---------- configuration check ---------- */
function isConfigured() {
  const all = String(SUPABASE_URL || '') + String(SUPABASE_ANON_KEY || '');
  return !/PASTE|YOUR-PROJECT|YOUR-ANON/i.test(all);
}

function show(id) {
  for (const s of ['setup-screen', 'auth-screen', 'app-screen']) {
    document.getElementById(s).hidden = (s !== id);
  }
}

/* ---------- auth screen tabs/forms ---------- */
function authTab(which) {
  document.getElementById('tab-login').classList.toggle('active', which === 'login');
  document.getElementById('tab-signup').classList.toggle('active', which === 'signup');
  document.getElementById('login-form').hidden = which !== 'login';
  document.getElementById('signup-form').hidden = which !== 'signup';
  document.getElementById('forgot-form').hidden = true;
  document.getElementById('recover-form').hidden = true;
}
document.getElementById('tab-login').addEventListener('click', () => authTab('login'));
document.getElementById('tab-signup').addEventListener('click', () => authTab('signup'));
document.getElementById('forgot-link').addEventListener('click', () => {
  document.getElementById('login-form').hidden = true;
  document.getElementById('forgot-form').hidden = false;
  document.getElementById('forgot-email').value = document.getElementById('login-email').value;
});
document.getElementById('forgot-back').addEventListener('click', () => authTab('login'));

function formError(id, msg) {
  const el = document.getElementById(id);
  el.innerHTML = msg || '';
  el.hidden = !msg;
}

function authErrText(e) {
  const m = (e && e.message) || '';
  if (/Failed to fetch|NetworkError|fetch failed/i.test(m))
    return 'Can\u2019t reach the login service. If this keeps happening, your free Supabase project may be paused \u2014 open supabase.com, go to your project and press <b>Restore</b>, then try again.';
  if (/Database error saving new user/i.test(m))
    return 'Sign-up was rejected \u2014 most likely the invite code is wrong. Double-check it!';
  if (/Invalid login credentials/i.test(m)) return 'Wrong email or password.';
  if (/Email not confirmed/i.test(m)) return 'Your email isn\u2019t confirmed yet \u2014 check your inbox.';
  if (/at least 6/i.test(m)) return 'Passwords need at least 6 characters.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts \u2014 wait a minute and try again.';
  return esc(m || 'Something went wrong. Try again.');
}

/* login */
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  formError('login-error');
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-password').value;
  if (!email || !pass) { formError('login-error', 'Fill in both fields.'); return; }
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Logging in...';
  try {
    const { error } = await state.sb.auth.signInWithPassword({ email, password: pass });
    if (error) formError('login-error', authErrText(error));
  } catch (err) {
    formError('login-error', authErrText(err));
  } finally {
    btn.disabled = false; btn.textContent = 'Log in';
  }
});

/* signup - the invite code travels in signup metadata and is
   checked by a database trigger on auth.users. The JS check
   below is only for quick feedback. */
document.getElementById('signup-form').addEventListener('submit', async e => {
  e.preventDefault();
  formError('signup-error');
  const email = document.getElementById('signup-email').value.trim();
  const pass = document.getElementById('signup-password').value;
  const invite = document.getElementById('signup-invite').value.trim();
  if (!email || !pass || !invite) { formError('signup-error', 'Fill in all three fields.'); return; }
  if (pass.length < 6) { formError('signup-error', 'Passwords need at least 6 characters.'); return; }
  if (invite !== INVITE_CODE) { formError('signup-error', 'That invite code isn\u2019t right. Ask for the current code!'); return; }
  const btn = document.getElementById('signup-btn');
  btn.disabled = true; btn.textContent = 'Creating account...';
  try {
    const { data, error } = await state.sb.auth.signUp({
      email,
      password: pass,
      options: { data: { invite_code: invite } },   // <- read by the DB trigger
    });
    if (error) { formError('signup-error', authErrText(error)); return; }
    if (!data.session) {
      formError('signup-error', 'Account created \u2014 check your inbox for a confirmation email, then log in.');
      authTab('login');
      document.getElementById('login-email').value = email;
    }
    /* if a session came back we are signed in automatically */
  } catch (err) {
    formError('signup-error', authErrText(err));
  } finally {
    btn.disabled = false; btn.textContent = 'Create my account';
  }
});

/* forgot password */
document.getElementById('forgot-form').addEventListener('submit', async e => {
  e.preventDefault();
  formError('forgot-error');
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) return;
  const btn = document.getElementById('forgot-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    const { error } = await state.sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    if (error) formError('forgot-error', authErrText(error));
    else formError('forgot-error', 'Sent! Check your inbox (and spam folder). If it doesn\u2019t arrive, wait an hour \u2014 the free email limit is about 2 per hour.');
  } catch (err) {
    formError('forgot-error', authErrText(err));
  } finally {
    btn.disabled = false; btn.textContent = 'Send reset link';
  }
});

/* set new password (after reset link) */
document.getElementById('recover-form').addEventListener('submit', async e => {
  e.preventDefault();
  formError('recover-error');
  const pass = document.getElementById('recover-password').value;
  if (pass.length < 6) { formError('recover-error', 'Passwords need at least 6 characters.'); return; }
  const btn = document.getElementById('recover-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const { error } = await state.sb.auth.updateUser({ password: pass });
    if (error) { formError('recover-error', authErrText(error)); return; }
    toast('Password updated. Welcome back!');
    document.getElementById('recover-form').hidden = true;
  } catch (err) {
    formError('recover-error', authErrText(err));
  } finally {
    btn.disabled = false; btn.textContent = 'Save new password';
  }
});

/* logout */
document.getElementById('btn-logout').addEventListener('click', async () => {
  stopPlayback();
  await state.sb.auth.signOut();
});

/* search */
document.getElementById('search-input').addEventListener('input', e => {
  state.search = e.target.value;
  renderSongList();
});

/* retry button */
document.getElementById('btn-retry').addEventListener('click', () => {
  document.getElementById('error-state').hidden = true;
  document.getElementById('loading-state').hidden = false;
  loadData().catch(showLoadError);
});

/* ---------- entering / leaving the app ---------- */
async function enterApp(session) {
  if (state.ready && state.user && session && state.user.id === session.user.id) return;
  state.session = session;
  state.user = session.user;
  state.ready = false;
  show('app-screen');
  document.getElementById('user-email').textContent = state.user.email || '';
  document.getElementById('player-bar').hidden = false;
  document.getElementById('loading-state').hidden = false;
  document.getElementById('empty-state').hidden = true;
  document.getElementById('search-empty').hidden = true;
  document.getElementById('song-list').innerHTML = '';
  await loadData().catch(showLoadError);
}

async function loadData() {
  const [songsRes, plRes] = await Promise.all([
    fnCall('songs', 'GET'),
    fnCall('playlists', 'GET'),
  ]);

  if (songsRes.status === 0 || plRes.status === 0) {
    throw Object.assign(new Error('network'), { kind: 'network' });
  }
  if (songsRes.status === 401 || plRes.status === 401) {
    throw Object.assign(new Error('session'), { kind: 'session' });
  }
  if (!songsRes.ok) {
    throw Object.assign(new Error(fnErrText(songsRes)), { kind: 'api', detail: songsRes.data && songsRes.data.error });
  }
  if (!plRes.ok) {
    throw Object.assign(new Error(fnErrText(plRes)), { kind: 'api' });
  }

  state.songs = songsRes.data.songs || [];
  if (songsRes.data.cfg) state.cfg = { ...state.cfg, ...songsRes.data.cfg };
  state.playlists = plRes.data.playlists || [];
  state.plLinks = plRes.data.links || [];

  state.ready = true;
  document.getElementById('loading-state').hidden = true;
  showView({ type: 'all' });
}

function showLoadError(e) {
  document.getElementById('loading-state').hidden = true;
  const msg = document.getElementById('error-msg');
  if (e && e.kind === 'session') {
    msg.innerHTML = 'Your session expired. Please log in again.';
    state.sb.auth.signOut();
    return;
  }
  if (e && e.kind === 'network') {
    msg.innerHTML = 'Can\u2019t reach your library. Your free Supabase project may be <b>paused</b> (it sleeps after ~1 week without visits).<br>Open <b>supabase.com \u2192 your project \u2192 Restore</b>, then press Try again.';
  } else {
    msg.innerHTML = 'The server said: ' + (e && e.message ? e.message : 'unknown error') +
      '<br><br>If this mentions a missing secret or a GitHub token, finish <b>Step 5</b> of SETUP-GUIDE.html (Edge Functions + secrets).';
  }
  document.getElementById('error-state').hidden = false;
}

function resetState() {
  state.ready = false;
  state.songs = [];
  state.playlists = [];
  state.plLinks = [];
  state.uploads = [];
  state.view = { type: 'all', id: null };
  state.search = '';
  document.getElementById('upload-list').innerHTML = '';
  document.getElementById('playlist-nav').innerHTML = '';
}

function showAuth() {
  resetState();
  authTab('login');
  formError('login-error'); formError('signup-error'); formError('forgot-error'); formError('recover-error');
  show('auth-screen');
}

/* ---------- global drag & drop overlay ---------- */
(function wireGlobalDrop() {
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    if (document.getElementById('app-screen').hidden || !state.ready) return;
    dragDepth++;
    document.getElementById('drop-overlay').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (dragDepth > 0 && --dragDepth === 0) document.getElementById('drop-overlay').hidden = true;
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.getElementById('drop-overlay').hidden = true;
    if (document.getElementById('app-screen').hidden || !state.ready) return;
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
})();

/* ---------- boot ---------- */
(function boot() {
  document.querySelectorAll('[data-ico]').forEach(el => { el.innerHTML = icon(el.dataset.ico, 18); });
  document.title = APP_NAME;

  if (!isConfigured()) { show('setup-screen'); return; }

  state.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  state.sb.auth.onAuthStateChange((evt, session) => {
    if (evt === 'INITIAL_SESSION') {
      if (session) enterApp(session); else showAuth();
    } else if (evt === 'SIGNED_IN' || evt === 'USER_UPDATED') {
      if (session) enterApp(session);
    } else if (evt === 'SIGNED_OUT') {
      showAuth();
    } else if (evt === 'PASSWORD_RECOVERY') {
      show('auth-screen');
      document.getElementById('login-form').hidden = true;
      document.getElementById('signup-form').hidden = true;
      document.getElementById('forgot-form').hidden = true;
      document.getElementById('recover-form').hidden = false;
    }
  });
})();
