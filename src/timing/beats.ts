import type { MusicCue } from "../schema.js";

/**
 * A beat grid for a music bed, so a composition can land a picture on the
 * music without the music deciding the edit.
 *
 * Major reveals may move onto a strong cue when they are already within
 * STRONG_CUE_WINDOW (0.15s). Smaller entrances may move onto a beat within
 * BEAT_WINDOW (0.1s). Farther than that, the planned time stands: readability
 * and the story outrank the pulse. One video wants only a few strong-cue
 * locks; the grid is a hint, not a cue sheet.
 *
 * The tracker is an energy envelope and its autocorrelation. It needs no
 * extra library, and the same samples always give the same grid.
 */

/** How far a small entrance may move to meet a beat, in seconds. */
export const BEAT_WINDOW = 0.1;
/** How far a major reveal may move to meet a strong cue, in seconds. */
export const STRONG_CUE_WINDOW = 0.15;

const HOP_SEC = 0.01;
const MIN_BPM = 70;
const MAX_BPM = 180;

export interface BeatAnalysis {
  /** Beats per minute, or null when the bed has no pulse worth locking to. */
  tempo: number | null;
  beats: MusicCue[];
  strongCues: MusicCue[];
}

const empty = (): BeatAnalysis => ({ tempo: null, beats: [], strongCues: [] });

/**
 * Beat grid of a mono buffer. Silence, noise and anything under half a second
 * come back with a null tempo and no cues, which a composition treats as
 * "keep the planned time".
 */
export function analyzeBeats(samples: Float32Array, sampleRate: number): BeatAnalysis {
  if (!(sampleRate >= 1000) || samples.length < sampleRate * 0.5) return empty();
  const hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
  const win = hop * 2;
  const flux: number[] = [];
  const times: number[] = [];
  let prev = 0;
  for (let i = 0; i + win <= samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const v = samples[i + j];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / win);
    const rise = rms - prev;
    flux.push(rise > 0 ? rise : 0);
    times.push((i + win / 2) / sampleRate);
    prev = rms;
  }
  if (flux.length < 8) return empty();

  const minLag = Math.max(1, Math.round(60 / MAX_BPM / HOP_SEC));
  const maxLag = Math.min(flux.length - 2, Math.round(60 / MIN_BPM / HOP_SEC));
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = correlate(flux, lag);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  // A click every beat also correlates at every other beat. When the shorter
  // period agrees, that is the pulse, not the half-time one.
  const half = Math.round(bestLag / 2);
  if (half >= minLag) {
    const score = correlate(flux, half);
    if (score >= best * 0.85) {
      best = score;
      bestLag = half;
    }
  }
  let energy = 0;
  for (const v of flux) energy += v * v;
  energy /= flux.length;
  if (bestLag === 0 || energy === 0 || best < energy * 0.15) return empty();

  let bestPhase = 0;
  let bestScore = -1;
  for (let phase = 0; phase < bestLag; phase++) {
    let score = 0;
    let n = 0;
    for (let i = phase; i < flux.length; i += bestLag) {
      score += flux[i];
      n++;
    }
    score /= n || 1;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  const raw: { time: number; flux: number }[] = [];
  let maxFlux = 0;
  for (let i = bestPhase; i < flux.length; i += bestLag) {
    raw.push({ time: times[i], flux: flux[i] });
    if (flux[i] > maxFlux) maxFlux = flux[i];
  }
  if (maxFlux <= 0) return empty();

  const beats = raw.slice(0, 2000).map((b) => ({
    time: round3(Math.max(0, b.time)),
    intensity: clamp01(b.flux / maxFlux),
  }));
  return { tempo: round1(60 / (bestLag * HOP_SEC)), beats, strongCues: pickStrong(beats) };
}

function correlate(flux: number[], lag: number): number {
  const n = flux.length - lag;
  if (n <= 0) return 0;
  let score = 0;
  for (let i = 0; i < n; i++) score += flux[i] * flux[i + lag];
  return score / n;
}

/** The loudest beats, at least 0.8s apart, loudest first then put back in time order. */
function pickStrong(beats: MusicCue[]): MusicCue[] {
  const peaks = beats.filter((b, i) => {
    if (b.intensity < 0.55) return false;
    const prev = i > 0 ? beats[i - 1].intensity : -1;
    const next = i + 1 < beats.length ? beats[i + 1].intensity : -1;
    return b.intensity >= prev && b.intensity >= next;
  });
  const sorted = [...peaks].sort((a, b) => b.intensity - a.intensity || a.time - b.time);
  const picked: MusicCue[] = [];
  for (const cue of sorted) {
    if (picked.every((p) => Math.abs(p.time - cue.time) >= 0.8)) picked.push(cue);
    if (picked.length >= 24) break;
  }
  picked.sort((a, b) => a.time - b.time);
  return picked;
}

/**
 * Move `time` onto the nearest cue that is already inside `windowSec`.
 * A tie keeps the earlier cue. Outside the window, `time` is unchanged.
 */
export function nudgeToCue(time: number, cues: readonly { time: number }[] | null | undefined, windowSec: number): number {
  if (!cues?.length || !(windowSec > 0) || !Number.isFinite(time)) return time;
  let best = time;
  let bestDist = windowSec + 1;
  for (const cue of cues) {
    if (!Number.isFinite(cue.time)) continue;
    const dist = Math.abs(cue.time - time);
    if (dist <= windowSec && dist < bestDist) {
      bestDist = dist;
      best = cue.time;
    }
  }
  return best;
}

/** A small entrance: onto the nearest beat, within {@link BEAT_WINDOW}. */
export function nudgeToBeat(
  time: number,
  beats: readonly { time: number }[] | null | undefined,
  windowSec = BEAT_WINDOW,
): number {
  return nudgeToCue(time, beats, windowSec);
}

/** A major reveal: onto the nearest strong cue, within {@link STRONG_CUE_WINDOW}. */
export function nudgeToStrongCue(
  time: number,
  cues: readonly { time: number }[] | null | undefined,
  windowSec = STRONG_CUE_WINDOW,
): number {
  return nudgeToCue(time, cues, windowSec);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
