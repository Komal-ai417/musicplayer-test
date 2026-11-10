'use strict';
/* ============================================================
   sort.js - library sorting (header menu).
   Sorting applies to All songs, artist and album views; playlist
   order (position) is deliberately never re-sorted.
   Pure logic lives in om-core.js (sortSongsBy) and is unit-tested.
   ============================================================ */

if (!state.sort) state.sort = { key: 'recent', dir: 'desc' };

try {
  const saved = JSON.parse(localStorage.getItem('om-sort') || 'null');
  if (saved && SORT_KEYS.includes(saved.key) && ['asc', 'desc'].includes(saved.dir)) {
    state.sort = saved;
  }
} catch { /* keep default */ }

const SORT_OPTIONS = [
  { key: 'recent',  dir: 'desc', label: 'Recently added' },
  { key: 'title',   dir: 'asc',  label: 'Title A\u2013Z' },
  { key: 'artist',  dir: 'asc',  label: 'Artist A\u2013Z' },
  { key: 'album',   dir: 'asc',  label: 'Album A\u2013Z' },
  { key: 'duration',dir: 'desc', label: 'Longest first' },
];

function sortSongs(list) {
  if (state.view && state.view.type === 'playlist') return list; // keep positions
  return sortSongsBy(list, state.sort);
}

function sortLabel() {
  const o = SORT_OPTIONS.find(o => o.key === state.sort.key && o.dir === state.sort.dir);
  return o ? o.label : 'Recently added';
}

function setSort(key, dir) {
  state.sort = { key, dir };
  try { localStorage.setItem('om-sort', JSON.stringify(state.sort)); } catch { /* ignore */ }
  renderSongList();
  toast('Sorted by ' + sortLabel(), 'ok', 1800);
}

/* Added to the view header by library.js (updateViewMeta) for
   sortable views. */
function addSortControl(actions) {
  if (!['all', 'artist', 'album'].includes(state.view.type)) return;
  const b = document.createElement('button');
  b.className = 'btn btn-ghost sort-btn';
  b.innerHTML = icon('sort', 15) + ' <span class="sort-lbl">' + esc(sortLabel()) + '</span>';
  b.title = 'Change sorting';
  b.addEventListener('click', e => {
    e.stopPropagation();
    const r = b.getBoundingClientRect();
    openSortMenu(r.left, r.bottom + 4);
  });
  actions.appendChild(b);
}

function openSortMenu(x, y) {
  const items = SORT_OPTIONS.map(o => ({
    label: (o.key === state.sort.key ? '\u2713 ' : '') + o.label,
    icon: o.key === 'recent' ? 'note' : 'sort',
    onclick: () => setSort(o.key, o.dir),
  }));
  // a second tap on the active text key flips direction
  if (state.sort.key !== 'recent') {
    items.push('-');
    items.push({
      label: state.sort.dir === 'asc' ? 'Reverse (Z\u2013A)' : 'Reverse (A\u2013Z)',
      icon: 'sort',
      onclick: () => setSort(state.sort.key, state.sort.dir === 'asc' ? 'desc' : 'asc'),
    });
  }
  openMenu(items, x, y);
}
