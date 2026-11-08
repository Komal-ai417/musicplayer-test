'use strict';
/* ============================================================
   functions.js - the ONLY bridge to Supabase Edge Functions.
   The browser never talks to GitHub and never sees the token.
   ============================================================ */

/* Call an edge function with the user's session token.
   Returns { ok, status, data }. Retries once if the token
   had expired in the meantime. */
async function fnCall(name, method, body) {
  const url = SUPABASE_URL + '/functions/v1/' + name;

  const doFetch = token => fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const { data: sData } = await state.sb.auth.getSession();
  const token = sData && sData.session ? sData.session.access_token : '';
  let res;
  try {
    res = await doFetch(token);
  } catch {
    return { ok: false, status: 0, data: null };
  }

  if (res.status === 401 && sData.session) {
    const { data: rData } = await state.sb.auth.refreshSession();
    if (rData && rData.session) {
      try { res = await doFetch(rData.session.access_token); }
      catch { return { ok: false, status: 0, data: null }; }
    }
  }

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data };
}

/* Human-friendly text for a failed fnCall result. */
function fnErrText(res) {
  if (!res) return 'Something went wrong.';
  if (res.status === 0) {
    return 'Can\u2019t reach the server. If this keeps happening, your free Supabase project may be paused \u2014 open supabase.com, press <b>Restore</b>, and reload.';
  }
  if (res.status === 401) return 'Your session expired \u2014 please log in again.';
  const m = res.data && res.data.error ? res.data.error : '';
  if (m) return esc(m);
  return 'Something went wrong (error ' + res.status + '). Try again.';
}

/* ============================================================
   Staging upload: browser -> Supabase Storage (private bucket,
   own uid folder only, enforced by RLS). The Edge Function
   then moves the file to GitHub. Raw-body XHR gives us a
   real progress bar.
   ============================================================ */
function stagingUpload(stagingPath, file, onProgress) {
  return new Promise((resolve, reject) => {
    state.sb.auth.getSession().then(({ data }) => {
      const token = data && data.session ? data.session.access_token : '';
      if (!token) { reject(new Error('Not signed in.')); return; }

      const path = stagingPath.split('/').map(encodeURIComponent).join('/');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', SUPABASE_URL + '/storage/v1/object/song-staging/' + path);
      xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      if (onProgress) {
        xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let msg = 'Upload failed (error ' + xhr.status + ').';
          try {
            const j = JSON.parse(xhr.responseText);
            if (j && j.message) msg = 'Upload failed: ' + j.message;
            if (xhr.status === 401 || xhr.status === 403) msg = 'Upload was rejected \u2014 your session may have expired. Log in again and retry.';
          } catch { /* keep default */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed \u2014 check your internet connection and try again.'));
      xhr.send(file);
    }).catch(() => reject(new Error('Not signed in.')));
  });
}
