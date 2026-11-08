'use strict';
/* ============================================================
   github.js - talks to the GitHub REST API.
   Song files live inside the repo; the token comes from
   Supabase (app_config) so it never sits in public code.
   ============================================================ */

const GH_API = 'https://api.github.com';
const REPO = () => '/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO;

function encPath(p) { return String(p).split('/').map(encodeURIComponent).join('/'); }

/* Playback URLs (repo must be public) */
function rawUrl(path) {
  return 'https://raw.githubusercontent.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/' +
         GITHUB_BRANCH + '/' + encPath(path);
}
function cdnUrl(path) {   /* jsDelivr mirror, used as a fallback */
  return 'https://cdn.jsdelivr.net/gh/' + GITHUB_OWNER + '/' + GITHUB_REPO + '@' +
         GITHUB_BRANCH + '/' + encPath(path);
}

function ghErrorMessage(status, body) {
  switch (status) {
    case 401: return 'GitHub rejected the token (401). Open SETUP-GUIDE.html, Step 1, and make sure the token is valid and pasted into app_config.';
    case 403: return 'GitHub refused the request (403). Check the token has <b>Contents: Read and write</b> permission for this exact repo (SETUP-GUIDE, Step 1). ' +
                    (body && body.message ? '(' + esc(body.message) + ')' : '');
    case 404: return 'GitHub says "not found" (404). Check GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH in config.js.';
    case 409: return 'GitHub reported a conflict (409). The file may already exist - try renaming it.';
    case 413: return 'That file is too large for the GitHub API. Keep songs under 20 MB.';
    default:  return 'GitHub error (' + status + ')' + (body && body.message ? ': ' + esc(body.message) : '');
  }
}

async function ghFetch(path, method = 'GET', body = null) {
  let res;
  try {
    res = await fetch(GH_API + path, {
      method,
      headers: {
        'Authorization': 'Bearer ' + state.ghToken,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach GitHub. Check your internet connection and try again.');
  }
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) { const e = new Error(ghErrorMessage(res.status, json)); e.status = res.status; throw e; }
  return json;
}

/* Upload with progress. base64 = file content without the data: prefix. */
function ghPutFile(path, base64, message, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', GH_API + REPO() + '/contents/' + encPath(path));
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.ghToken);
    xhr.setRequestHeader('Accept', 'application/vnd.github+json');
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (onProgress) {
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); }
      } else {
        let body = null; try { body = JSON.parse(xhr.responseText); } catch { }
        const e = new Error(ghErrorMessage(xhr.status, body)); e.status = xhr.status; reject(e);
      }
    };
    xhr.onerror = () => reject(new Error('Could not reach GitHub. Check your internet connection and try again.'));
    xhr.send(JSON.stringify({ message: message, content: base64, branch: GITHUB_BRANCH }));
  });
}

/* Delete needs the file's current sha - look it up first. */
async function ghDeleteFile(path, message) {
  const meta = await ghFetch(REPO() + '/contents/' + encPath(path) + '?ref=' + encodeURIComponent(GITHUB_BRANCH));
  if (!meta || !meta.sha) throw new Error('File not found on GitHub (already deleted?) - refresh the page.');
  return ghFetch(REPO() + '/contents/' + encPath(path), 'DELETE',
    { message: message, sha: meta.sha, branch: GITHUB_BRANCH });
}
