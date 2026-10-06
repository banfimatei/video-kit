import { describe, expect, it } from "vitest";
import { analyzeBeats, nudgeToBeat, nudgeToStrongCue } from "../src/timing/beats.js";

const RATE = 44_100;

/** Clicks on a grid. `accentEvery` makes every Nth click louder, for strong cues. */
function clicks(bpm: number, seconds: number, accentEvery = 0): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  const step = Math.round((60 / bpm) * RATE);
  let n = 0;
  for (let at = 0; at < samples.length; at += step, n++) {
    const amp = accentEvery > 0 && n % accentEvery === 0 ? 1 : 0.22;
    for (let i = 0; i < 180 && at + i < samples.length; i++) {
      samples[at + i] += Math.sin((2 * Math.PI * 900 * i) / RATE) * Math.exp(-i / 30) * amp;
    }
  }
  return samples;
}

describe("analyzeBeats", () => {
  it("finds the pulse of a click track and locks beats to the clicks", () => {
    const grid = analyzeBeats(clicks(120, 4), RATE);
    expect(grid.tempo).toBeCloseTo(120, 0);
    expect(grid.beats.length).toBeGreaterThanOrEqual(7);
    for (const beat of grid.beats) {
      const nearest = Math.round(beat.time / 0.5) * 0.5;
      expect(Math.abs(beat.time - nearest)).toBeLessThan(0.04);
    }
  });

  it("keeps strong cues on the accents, and at least 0.8s apart", () => {
    const grid = analyzeBeats(clicks(120, 8, 4), RATE);
    expect(grid.strongCues.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < grid.strongCues.length; i++) {
      expect(grid.strongCues[i].time - grid.strongCues[i - 1].time).toBeGreaterThanOrEqual(0.8);
    }
    for (const cue of grid.strongCues) {
      const nearestAccent = Math.round(cue.time / 2) * 2;
      expect(Math.abs(cue.time - nearestAccent)).toBeLessThan(0.08);
    }
  });

  it("returns an empty grid for silence and for noise", () => {
    expect(analyzeBeats(new Float32Array(RATE * 2), RATE)).toEqual({ tempo: null, beats: [], strongCues: [] });
    const noise = new Float32Array(RATE * 3);
    let a = 1;
    for (let i = 0; i < noise.length; i++) {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      noise[i] = (a / 2 ** 32 - 0.5) * 0.05;
    }
    expect(analyzeBeats(noise, RATE).tempo).toBeNull();
    expect(analyzeBeats(noise, RATE).beats).toEqual([]);
  });
});

describe("nudge", () => {
  const beats = [{ time: 1 }, { time: 1.5 }, { time: 2 }];
  const strong = [{ time: 4 }, { time: 8 }];

  it("moves onto a beat only inside the window, and keeps the earlier cue on a tie", () => {
    expect(nudgeToBeat(1.08, beats)).toBe(1);
    expect(nudgeToBeat(1.46, beats)).toBe(1.5);
    expect(nudgeToBeat(1.25, beats)).toBe(1.25);
    expect(nudgeToBeat(1.2, [{ time: 1.1 }, { time: 1.3 }])).toBe(1.1);
    expect(nudgeToBeat(3, undefined)).toBe(3);
  });

  it("moves a reveal onto a strong cue within 0.15s and no further", () => {
    expect(nudgeToStrongCue(4.14, strong)).toBe(4);
    expect(nudgeToStrongCue(4.2, strong)).toBe(4.2);
  });
});
