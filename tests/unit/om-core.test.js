import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/* om-core.js is a dependency-free classic script; executing it in a
   function scope gives us its real exports to test. */
const src = readFileSync(new URL('../../docs/om-core.js', import.meta.url), 'utf8');
const api = new Function(src + `
  ;return { parseLrc, lrcActiveIndex, lrcFmtTime, sortSongsBy, SORT_KEYS, EQ_BANDS, eqDbToGain, eqBandLabel };
`)();
const { parseLrc, lrcActiveIndex, lrcFmtTime, sortSongsBy, EQ_BANDS, eqDbToGain, eqBandLabel } = api;

/* ---------- LRC parsing ---------- */
describe('parseLrc', () => {
  it('parses synced LRC lines with fractional seconds', () => {
    const out = parseLrc('[00:12.30]First line\n[01:02.5]Second line\n[01:02.00]Third');
    expect(out.synced).toBe(true);
    // sorted by time: 12.3, 62, 62.5
    expect(out.lines.map((l) => l.text)).toEqual(['First line', 'Third', 'Second line']);
    expect(out.lines[0].t).toBeCloseTo(12.3, 5);
    expect(out.lines[1].t).toBeCloseTo(62, 5);
    expect(out.lines[2].t).toBeCloseTo(62.5, 5);
  });

  it('handles multiple timestamps on one line', () => {
    const out = parseLrc('[00:05.00][00:55.00]Chorus');
    expect(out.synced).toBe(true);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toEqual({ t: 5, text: 'Chorus' });
    expect(out.lines[1]).toEqual({ t: 55, text: 'Chorus' });
  });

  it('sorts lines by time', () => {
    const out = parseLrc('[00:30.00]B\n[00:10.00]A');
    expect(out.lines.map((l) => l.text)).toEqual(['A', 'B']);
  });

  it('applies the offset tag (positive shifts earlier)', () => {
    const out = parseLrc('[offset:500]\n[00:10.00]line');
    expect(out.lines[0].t).toBeCloseTo(9.5, 5);
  });

  it('ignores metadata tags and blank lines', () => {
    const out = parseLrc('[ti:Some title]\n[ar:Somebody]\n\n[00:01.00]real');
    expect(out.lines).toEqual([{ t: 1, text: 'real' }]);
  });

  it('treats invalid timestamps as plain text', () => {
    const out = parseLrc('[12:99]nonsense timestamp\n[00:01.00]ok');
    expect(out.synced).toBe(true); // the valid one still syncs
    expect(out.lines).toHaveLength(1);
  });

  it('returns plain (unsynced) lines when there are no stamps', () => {
    const out = parseLrc('la la la\nanother line\n');
    expect(out.synced).toBe(false);
    expect(out.lines).toEqual([
      { t: null, text: 'la la la' },
      { t: null, text: 'another line' },
    ]);
  });

  it('handles empty / null input', () => {
    expect(parseLrc('').lines).toEqual([]);
    expect(parseLrc(null).lines).toEqual([]);
    expect(parseLrc(undefined).lines).toEqual([]);
  });

  it('accepts comma fractional separator ([00:12,30])', () => {
    const out = parseLrc('[00:12,30]european style');
    expect(out.lines[0].t).toBeCloseTo(12.3, 5);
  });
});

describe('lrcActiveIndex', () => {
  const lines = [
    { t: 0, text: 'a' },
    { t: 5, text: 'b' },
    { t: 10, text: 'c' },
    { t: 20, text: 'd' },
  ];
  it('finds the active line at boundaries', () => {
    expect(lrcActiveIndex(lines, -1)).toBe(-1);
    expect(lrcActiveIndex(lines, 0)).toBe(0);
    expect(lrcActiveIndex(lines, 4.9)).toBe(0);
    expect(lrcActiveIndex(lines, 5)).toBe(1);
    expect(lrcActiveIndex(lines, 19.9)).toBe(2);
    expect(lrcActiveIndex(lines, 999)).toBe(3);
  });
  it('handles empty and unsynced lines', () => {
    expect(lrcActiveIndex([], 5)).toBe(-1);
    expect(lrcActiveIndex([{ t: null, text: 'x' }], 5)).toBe(-1);
  });
});

describe('lrcFmtTime', () => {
  it('formats mm:ss', () => {
    expect(lrcFmtTime(0)).toBe('0:00');
    expect(lrcFmtTime(83)).toBe('1:23');
    expect(lrcFmtTime(null)).toBe('');
  });
});

/* ---------- sorting ---------- */
describe('sortSongsBy', () => {
  const songs = [
    { id: '1', title: 'Banana', artist: 'Zed', album: 'Beta', duration_sec: 100, created_at: '2026-01-03T00:00:00Z' },
    { id: '2', title: 'apple', artist: 'Alpha', album: 'gamma', duration_sec: 300, created_at: '2026-01-01T00:00:00Z' },
    { id: '3', title: 'Cherry', artist: null, album: null, duration_sec: 200, created_at: '2026-01-02T00:00:00Z' },
  ];

  it('recent: newest first (desc)', () => {
    expect(sortSongsBy(songs, { key: 'recent', dir: 'desc' }).map((s) => s.id)).toEqual(['1', '3', '2']);
  });
  it('recent asc = oldest first', () => {
    expect(sortSongsBy(songs, { key: 'recent', dir: 'asc' }).map((s) => s.id)).toEqual(['2', '3', '1']);
  });
  it('title: case-insensitive, numeric aware', () => {
    expect(sortSongsBy(songs, { key: 'title', dir: 'asc' }).map((s) => s.id)).toEqual(['2', '1', '3']);
  });
  it('artist: unknown artist sorts last (asc)', () => {
    expect(sortSongsBy(songs, { key: 'artist', dir: 'asc' }).map((s) => s.id)).toEqual(['2', '1', '3']);
  });
  it('album: missing album sorts last (asc)', () => {
    expect(sortSongsBy(songs, { key: 'album', dir: 'asc' }).map((s) => s.id)).toEqual(['1', '2', '3']);
  });
  it('duration desc: longest first; asc reverses', () => {
    expect(sortSongsBy(songs, { key: 'duration', dir: 'desc' }).map((s) => s.id)).toEqual(['2', '3', '1']);
    expect(sortSongsBy(songs, { key: 'duration', dir: 'asc' }).map((s) => s.id)).toEqual(['1', '3', '2']);
  });
  it('unknown key / missing dir returns the list untouched', () => {
    expect(sortSongsBy(songs, { key: 'nope', dir: 'asc' }).map((s) => s.id)).toEqual(['1', '2', '3']);
    expect(sortSongsBy(songs, { key: 'title' }).map((s) => s.id)).toEqual(['1', '2', '3']);
  });
  it('does not mutate the input', () => {
    const copy = [...songs];
    sortSongsBy(songs, { key: 'title', dir: 'asc' });
    expect(songs).toEqual(copy);
  });
});

/* ---------- equalizer math ---------- */
describe('eqDbToGain / EQ_BANDS', () => {
  it('converts dB to linear gain', () => {
    expect(eqDbToGain(0)).toBeCloseTo(1, 6);
    expect(eqDbToGain(6)).toBeCloseTo(1.995, 2);
    expect(eqDbToGain(-6)).toBeCloseTo(0.501, 2);
    expect(eqDbToGain(12)).toBeCloseTo(3.981, 2);
    expect(eqDbToGain(-12)).toBeCloseTo(0.251, 2);
  });
  it('clamps out-of-range values', () => {
    expect(eqDbToGain(99)).toBeCloseTo(eqDbToGain(12), 6);
    expect(eqDbToGain(-99)).toBeCloseTo(eqDbToGain(-12), 6);
    expect(eqDbToGain('NaN')).toBeCloseTo(1, 6);
  });
  it('has 10 bands from 31.25 Hz to 16 kHz', () => {
    expect(EQ_BANDS).toHaveLength(10);
    expect(EQ_BANDS[0]).toBe(31.25);
    expect(EQ_BANDS[9]).toBe(16000);
  });
  it('labels bands compactly', () => {
    expect(eqBandLabel(31.25)).toBe('31');
    expect(eqBandLabel(1000)).toBe('1k');
    expect(eqBandLabel(16000)).toBe('16k');
  });
});
