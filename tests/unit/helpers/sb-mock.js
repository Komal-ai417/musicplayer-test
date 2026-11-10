/* Shared Supabase mock for Edge Function unit tests.
   Builds a fixture (auth users, songs, playlists, storage tree,
   GitHub file set) and a createClient() factory the aliased
   supabase-js mock calls. Query chains are thenables that filter
   the fixture — the REAL Edge Function code runs unchanged. */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createFixture() {
  const f = {
    authUsers: new Map(),
    tokens: new Map(),          // bearer token -> user id
    songs: [],
    playlists: [],
    playlistSongs: [],
    storageTree: {},            // bucket -> { name: null | subtree }
    appConfig: { id: 1, invite_code: 'TESTCODE', max_songs_per_user: 200, max_upload_mb: 20 },
    calls: {
      gh: [], authDeletes: [], rpc: [], storageList: [], storageRemove: [],
    },
    errors: { rpc: null, storageRemove: null, storageList: null, authDelete: null, listUsers: null },
    gh: { files: new Set(), failMethod: null, failStatus: 0 },
    rpcImpl: null,              // optional custom rpc override
  };
  f.client = () => makeClient(f);
  return f;
}

/* ---------- query chain ---------- */
function makeClient(f) {
  const from = (table) => {
    const st = { table, filters: [], cols: null, opts: {}, maybeSingle: false, isDelete: false, isInsert: null, isUpdate: null };
    const chain = {
      select(cols, opts = {}) {
        st.cols = cols; st.opts = opts || {};
        return chain;
      },
      eq(col, val) { st.filters.push([col, val, true]); return chain; },
      neq(col, val) { st.filters.push([col, val, false]); return chain; },
      order() { return chain; },
      maybeSingle() { st.maybeSingle = true; return chain; },
      delete() { st.isDelete = true; return chain; },
      insert(row) { st.isInsert = row; return chain; },
      update(vals) { st.isUpdate = vals; return chain; },
      then(resolve, reject) {
        try { resolve(runQuery(f, st)); } catch (e) { reject(e); }
      },
    };
    return chain;
  };

  return {
    auth: {
      getUser: async (token) => {
        const uid = f.tokens.get(String(token || ''));
        return { data: { user: uid ? f.authUsers.get(uid) ?? null : null } };
      },
      admin: {
        listUsers: async () => {
          if (f.errors.listUsers) return { data: null, error: { message: f.errors.listUsers } };
          return { data: { users: [...f.authUsers.values()], nextPage: null } };
        },
        getUserById: async (id) => {
          const u = f.authUsers.get(id);
          if (!u) return { data: { user: null }, error: { message: `User with id "${id}" not found` } };
          return { data: { user: u } };
        },
        deleteUser: async (id) => {
          f.calls.authDeletes.push(id);
          if (f.errors.authDelete) return { error: { message: f.errors.authDelete } };
          f.authUsers.delete(id);
          return { error: null };
        },
      },
    },
    from,
    rpc: async (name, params) => {
      f.calls.rpc.push({ name, params });
      if (f.errors.rpc) return { data: null, error: { message: f.errors.rpc } };
      if (f.rpcImpl) return f.rpcImpl(name, params);
      if (name === 'delete_user_data') return { data: emulateDeleteUserData(f, params.p_target) };
      return { data: null, error: { message: 'unknown rpc ' + name } };
    },
    storage: {
      from: (bucket) => ({
        list: async (folder, opts = {}) => {
          f.calls.storageList.push({ folder, opts });
          if (f.errors.storageList) return { data: null, error: { message: f.errors.storageList } };
          const node = treeNode(f.storageTree[bucket], String(folder || ''));
          if (!node) return { data: [] };
          const items = Object.entries(node).map(([name, val]) =>
            val && typeof val === 'object' ? { name } : { name, id: 'obj:' + folder + '/' + name });
          return { data: items };
        },
        remove: async (paths) => {
          f.calls.storageRemove.push([...paths]);
          if (f.errors.storageRemove) return { error: { message: f.errors.storageRemove } };
          removeFromTree(f.storageTree[bucket], paths);
          return { error: null };
        },
        download: async () => ({ data: null, error: { message: 'not used in these tests' } }),
        upload: async () => ({ data: null, error: { message: 'not used in these tests' } }),
      }),
    },
  };
}

function runQuery(f, st) {
  const rows = f[st.table] ?? [];
  const filtered = rows.filter((r) => st.filters.every(([col, val, wantEq]) =>
    wantEq ? r[col] === val : r[col] !== val));

  if (st.isDelete) {
    const ids = new Set(filtered.map((r) => r.id));
    f[st.table] = rows.filter((r) => !ids.has(r.id));
    // cascade like the real FKs
    if (st.table === 'songs') {
      f.playlistSongs = f.playlistSongs.filter((l) => !ids.has(l.song_id));
    }
    if (st.table === 'playlists') {
      f.playlistSongs = f.playlistSongs.filter((l) => !ids.has(l.playlist_id));
    }
    return { data: null, error: null };
  }
  if (st.isInsert) {
    const row = { ...st.isInsert };
    f[st.table] = [...rows, row];
    return { data: [row], error: null };
  }
  if (st.isUpdate) {
    const upd = filtered.map((r) => ({ ...r, ...st.isUpdate }));
    f[st.table] = rows.map((r) => (upd.find((u) => u.id === r.id) ? { ...r, ...st.isUpdate } : r));
    return { data: upd, error: null };
  }
  if (st.opts.count === 'exact' && st.opts.head) {
    return { count: filtered.length };
  }
  // project onto the requested columns (mirrors the real select)
  const cols = typeof st.cols === 'string'
    ? st.cols.split(',').map((c) => c.trim()).filter(Boolean)
    : null;
  const project = (r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : r);
  const data = filtered.map(project);
  return st.maybeSingle ? { data: data[0] ?? null } : { data };
}

/* emulate the delete_user_data SQL function (same order & counts) */
function emulateDeleteUserData(f, target) {
  const ownPl = new Set(f.playlists.filter((p) => p.user_id === target).map((p) => p.id));
  const targetSongs = new Set(f.songs.filter((s) => s.user_id === target).map((s) => s.id));
  let linksOwn = 0, linksOther = 0;
  for (const l of f.playlistSongs) {
    if (ownPl.has(l.playlist_id)) linksOwn++;
    else if (targetSongs.has(l.song_id)) linksOther++;
  }
  f.playlistSongs = f.playlistSongs.filter(
    (l) => !ownPl.has(l.playlist_id) && !targetSongs.has(l.song_id));
  f.playlists = f.playlists.filter((p) => p.user_id !== target);
  f.songs = f.songs.filter((s) => s.user_id !== target);
  return {
    links_own_deleted: linksOwn,
    links_other_deleted: linksOther,
    playlists_deleted: ownPl.size,
    songs_deleted: targetSongs.size,
  };
}

/* ---------- storage tree helpers ---------- */
function treeNode(root, path) {
  if (!root) return null;
  const parts = path.split('/').filter(Boolean);
  let node = root;
  for (const p of parts) {
    if (!node || typeof node !== 'object' || !(p in node)) return null;
    node = node[p];
  }
  return node && typeof node === 'object' ? node : null;
}

function removeFromTree(root, paths) {
  if (!root) return;
  for (const p of paths) {
    const parts = String(p).split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node = node?.[parts[i]];
      if (!node || typeof node !== 'object') break;
    }
    if (node && typeof node === 'object') delete node[parts[parts.length - 1]];
  }
}

/* ---------- GitHub fetch mock ---------- */
export function ghFetchFactory(f) {
  return async function ghFetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const u = String(url);
    f.calls.gh.push({ method, url: u, body: opts.body ?? null });

    if (f.gh.failMethod === method && f.gh.failStatus) {
      return json({ message: 'simulated GitHub failure (' + f.gh.failStatus + ')' }, f.gh.failStatus);
    }
    const m = u.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+?)(?:\?|$)/);
    if (!m) return json({ message: 'unexpected url ' + u }, 500);
    const p = decodeURIComponent(m[3]);

    if (method === 'GET') {
      if (!f.gh.files.has(p)) return json({ message: 'Not Found' }, 404);
      return json({ name: p, sha: 'sha:' + p }, 200);
    }
    if (method === 'DELETE') {
      if (!f.gh.files.has(p)) return json({ message: 'Not Found' }, 404);
      f.gh.files.delete(p);
      return json({ commit: { sha: 'commit-1' } }, 200);
    }
    return json({ message: 'unsupported method' }, 500);
  };
}

/* ---------- Deno runtime stub ---------- */
export function installDeno(envMap) {
  globalThis.__handler = null;
  globalThis.Deno = {
    serve: (h) => { globalThis.__handler = h; return { fetch: h }; },
    env: { get: (k) => (k in envMap ? envMap[k] : undefined) },
  };
}

/* load the Edge Function module once the stubs are in place.
   `fnPath` is relative to the repo root (vitest's cwd). */
export async function importFunction(fnPath) {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const mod = await import(pathToFileURL(resolve(process.cwd(), fnPath)).href);
  void mod;
  if (typeof globalThis.__handler !== 'function') {
    throw new Error('Deno.serve was not called by ' + fnPath);
  }
  return globalThis.__handler;
}

export function resetRateLimiters() {
  if (globalThis.__om_rl instanceof Map) globalThis.__om_rl.clear();
}

export function resetInFlight() {
  if (globalThis.__om_del instanceof Set) globalThis.__om_del.clear();
}

export function makeRequest(method, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Request('https://test.supabase.co/functions/v1/x', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
