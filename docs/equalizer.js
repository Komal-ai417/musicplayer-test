'use strict';
/* ============================================================
   equalizer.js - 10-band Web Audio equalizer.
   Audio must be routed through an AudioContext graph:
     <audio> -> preamp gain -> 10 peaking filters -> destination
   The graph is created lazily, the FIRST time the user turns the
   EQ on (creating it earlier would needlessly route playback
   through Web Audio on every device).
   The stream Edge Function already sends CORS headers on every
   response, so the audio element can fetch cross-origin bytes in
   CORS mode and Web Audio stays untainted:
   ============================================================ */

const eqAudioEl = document.getElementById('audio');
/* Must be set before any src is assigned (this script loads before
   playback ever starts) or the Web Audio graph would output silence
   for cross-origin media. */
eqAudioEl.crossOrigin = 'anonymous';

/* ---------- state (persisted) ---------- */
const EQ_KEY = 'om-eq';
let eqState = { on: false, preamp: 0, gains: new Array(10).fill(0), preset: 'flat' };
try {
  const saved = JSON.parse(localStorage.getItem(EQ_KEY) || 'null');
  if (saved && Array.isArray(saved.gains)) {
    eqState = {
      on: !!saved.on,
      preamp: Math.max(-12, Math.min(12, Number(saved.preamp) || 0)),
      gains: EQ_BANDS.map((_, i) => Math.max(-12, Math.min(12, Number(saved.gains[i]) || 0))),
      preset: typeof saved.preset === 'string' ? saved.preset : 'flat',
    };
  }
} catch { /* corrupted entry — keep defaults */ }

const EQ_PRESETS = {
  flat:       { label: 'Flat',       gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass:       { label: 'Bass boost', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  vocal:      { label: 'Vocal boost',gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  treble:     { label: 'Treble boost',gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  electronic: { label: 'Electronic', gains: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
  acoustic:   { label: 'Acoustic',   gains: [3, 2, 1, 1, -1, 0, 1, 2, 3, 3] },
  rock:       { label: 'Rock',       gains: [4, 3, 1, 0, -1, 0, 2, 3, 4, 4] },
};

/* ---------- audio graph ---------- */
let eqCtx = null;
let eqSource = null;
let eqPreampNode = null;
let eqFilterNodes = [];

function eqInitGraph() {
  if (eqCtx) return true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    eqCtx = new AC();
    eqSource = eqCtx.createMediaElementSource(eqAudioEl);
    eqPreampNode = eqCtx.createGain();
    eqPreampNode.gain.value = 1;

    eqFilterNodes = EQ_BANDS.map(hz => {
      const f = eqCtx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = hz;
      f.Q.value = 1.0;
      f.gain.value = 0;
      return f;
    });
    // series chain: preamp -> f0 -> f1 -> ... -> f9 -> destination
    eqPreampNode.connect(eqFilterNodes[0]);
    for (let i = 1; i < eqFilterNodes.length; i++) eqFilterNodes[i - 1].connect(eqFilterNodes[i]);
    eqFilterNodes[eqFilterNodes.length - 1].connect(eqCtx.destination);
    return true;
  } catch {
    eqCtx = null;
    return false;
  }
}

function eqApply() {
  if (!eqCtx) return;
  try {
    eqPreampNode.gain.value = eqState.on ? eqDbToGain(eqState.preamp) : 1;
    eqFilterNodes.forEach((f, i) => {
      f.gain.value = eqState.on ? (eqState.gains[i] || 0) : 0;
    });
  } catch { /* param race — harmless */ }
}

function eqSave() {
  try {
    localStorage.setItem(EQ_KEY, JSON.stringify({
      on: eqState.on, preamp: eqState.preamp, gains: eqState.gains, preset: eqState.preset,
    }));
  } catch { /* storage full / private mode — non-fatal */ }
}

async function eqSetOn(on) {
  if (on) {
    if (!eqInitGraph()) {
      toast('This browser doesn\u2019t support the equalizer.', 'warn', 5000);
      return;
    }
    // fire-and-forget: resume() can stay pending on devices without an
    // audio output; the UI must never block on it (a later gesture
    // retries via the pointerdown listener below)
    eqCtx.resume().catch(() => {});
  }
  eqState.on = !!on;
  eqApply();
  eqSave();
  eqRenderPanel();
  document.getElementById('btn-eq').classList.toggle('on', eqState.on);
}

function eqSetPreset(name) {
  const p = EQ_PRESETS[name];
  if (!p) return;
  eqState.preset = name;
  eqState.gains = p.gains.slice();
  eqApply();
  eqSave();
  eqRenderPanel();
}

/* ---------- panel ---------- */
const eqPanel = document.getElementById('eq-panel');

function eqRenderPanel() {
  if (!eqPanel) return;
  const head = eqPanel.querySelector('.eq-head');
  const body = eqPanel.querySelector('.eq-body');
  if (!body) return;

  const onoff = head.querySelector('.eq-toggle');
  if (onoff) {
    onoff.classList.toggle('on', eqState.on);
    onoff.textContent = eqState.on ? 'ON' : 'OFF';
  }

  body.innerHTML =
    '<div class="eq-row eq-preamp">' +
      '<span class="eq-lbl">Pre-amp</span>' +
      '<input type="range" min="-12" max="12" step="0.5" value="' + eqState.preamp + '" data-eq="preamp" aria-label="Pre-amp" />' +
      '<span class="eq-val" data-v="preamp">' + (eqState.preamp > 0 ? '+' : '') + eqState.preamp + ' dB</span>' +
    '</div>' +
    '<div class="eq-bands">' +
      EQ_BANDS.map((hz, i) =>
        '<div class="eq-band">' +
          '<span class="eq-val" data-v="' + i + '">' + (eqState.gains[i] > 0 ? '+' : '') + eqState.gains[i] + '</span>' +
          '<input type="range" min="-12" max="12" step="0.5" value="' + eqState.gains[i] + '" data-eq="' + i + '" aria-label="' + eqBandLabel(hz) + ' Hz" />' +
          '<span class="eq-lbl">' + eqBandLabel(hz) + '</span>' +
        '</div>').join('') +
    '</div>' +
    '<div class="eq-row">' +
      '<span class="eq-lbl">Preset</span>' +
      '<select class="eq-select" data-eq="preset">' +
        Object.entries(EQ_PRESETS).map(([k, p]) =>
          '<option value="' + k + '"' + (k === eqState.preset ? ' selected' : '') + '>' + p.label + '</option>').join('') +
      '</select>' +
      '<button class="linklike" data-eq="reset">Reset</button>' +
    '</div>' +
    '<p class="eq-note tiny muted">Custom slider moves switch the preset to &ldquo;flat&rdquo; values you can keep editing.</p>';

  body.querySelectorAll('input[type=range]').forEach(inp => {
    paintRange(inp, ((+inp.value + 12) / 24) * 100);
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      paintRange(inp, ((v + 12) / 24) * 100);
      if (inp.dataset.eq === 'preamp') eqState.preamp = v;
      else {
        eqState.gains[+inp.dataset.eq] = v;
        eqState.preset = 'flat';
      }
      const val = body.querySelector('[data-v="' + inp.dataset.eq + '"]');
      if (val) val.textContent = (v > 0 ? '+' : '') + v + (inp.dataset.eq === 'preamp' ? ' dB' : '');
      eqApply();
      eqSave();
    });
  });

  const sel = body.querySelector('[data-eq="preset"]');
  if (sel) sel.addEventListener('change', () => eqSetPreset(sel.value));

  const reset = body.querySelector('[data-eq="reset"]');
  if (reset) reset.addEventListener('click', () => {
    eqState.preset = 'flat';
    eqState.gains = new Array(10).fill(0);
    eqState.preamp = 0;
    eqApply(); eqSave(); eqRenderPanel();
  });
}

document.getElementById('btn-eq').addEventListener('click', async () => {
  eqPanel.hidden = !eqPanel.hidden;
  if (!eqPanel.hidden) {
    if (queuePanel && !queuePanel.hidden) queuePanel.hidden = true;
    if (lyricsPanel && !lyricsPanel.hidden) lyricsPanel.hidden = true;
    eqRenderPanel();
  }
});
const eqClose = eqPanel ? eqPanel.querySelector('.eq-close') : null;
if (eqClose) eqClose.addEventListener('click', () => { eqPanel.hidden = true; });
const eqToggleBtn = eqPanel ? eqPanel.querySelector('.eq-toggle') : null;
if (eqToggleBtn) eqToggleBtn.addEventListener('click', () => eqSetOn(!eqState.on));

/* If the context exists and was suspended by the OS (tab background),
   resume it on a user gesture so the EQ keeps working. */
document.addEventListener('pointerdown', () => {
  if (eqState.on && eqCtx && eqCtx.state === 'suspended') {
    eqCtx.resume().catch(() => {});
  }
}, true);
