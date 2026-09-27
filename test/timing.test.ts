import { describe, expect, it } from "vitest";
import { fitScenesToVoice } from "../src/timing/fitScenesToVoice.js";

const clip = (s: number) => ({ src: "x.wav", durationInSeconds: s });

describe("fitScenesToVoice", () => {
  it("lays scenes end to end with the transition overlap", () => {
    const t = fitScenesToVoice(
      [
        { id: "a", frames: 100 },
        { id: "b", frames: 50 },
        { id: "c", frames: 80 },
      ],
      { fps: 30, transitionFrames: 10 },
    );
    expect(t.starts).toEqual({ a: 0, b: 90, c: 130 });
    expect(t.durationInFrames).toBe(100 + 50 + 80 - 20);
    expect(t.voiceStarts).toEqual({ a: null, b: null, c: null });
  });

  it("skips null scenes without leaving a gap", () => {
    const t = fitScenesToVoice(
      [
        { id: "a", frames: 60 },
        { id: "skip", frames: null },
        { id: "b", frames: 60 },
      ],
      { fps: 30, transitionFrames: 12 },
    );
    expect(t.starts).toEqual({ a: 0, skip: null, b: 48 });
    expect(t.durations.skip).toBeNull();
    expect(t.durationInFrames).toBe(108);
  });

  it("stretches a scene to fit its line plus lead and breath, and keeps short lines at the visual length", () => {
    const t = fitScenesToVoice(
      [
        { id: "a", frames: 60 },
        { id: "b", frames: 300 },
      ],
      { fps: 30, transitionFrames: 12, voiceover: { a: clip(5), b: clip(1) } },
    );
    expect(t.durations.a).toBe(12 + 150 + 21);
    expect(t.durations.b).toBe(300);
    expect(t.voiceStarts.a).toBe(12);
    expect(t.voiceStarts.b).toBe((t.starts.b as number) + 12);
  });

  it("never lets one scene's line overlap the next", () => {
    const lengths = [0.5, 3.2, 7.9, 1.1, 12.4];
    const voiceover = Object.fromEntries(lengths.map((s, i) => [`s${i}`, clip(s)]));
    for (const transitionFrames of [0, 6, 12, 20]) {
      const t = fitScenesToVoice(
        lengths.map((_, i) => ({ id: `s${i}`, frames: 45 })),
        { fps: 30, transitionFrames, voiceover },
      );
      for (let i = 0; i < lengths.length - 1; i++) {
        const end = (t.voiceStarts[`s${i}`] as number) + lengths[i] * 30;
        expect(t.voiceStarts[`s${i + 1}`] as number).toBeGreaterThan(end);
      }
      const last = lengths.length - 1;
      expect(t.durationInFrames).toBeGreaterThanOrEqual((t.voiceStarts[`s${last}`] as number) + lengths[last] * 30);
    }
  });

  it("never returns a zero-length video", () => {
    expect(fitScenesToVoice([{ id: "a", frames: null }], { fps: 30 }).durationInFrames).toBe(1);
  });
});

describe("fitScenesToVoice guards", () => {
  it("refuses duplicate scene ids instead of silently merging them", () => {
    expect(() => fitScenesToVoice([{ id: "a", frames: 90 }, { id: "a", frames: 300 }], { fps: 30 })).toThrow(/used twice/);
  });

  it("treats prototype names as ordinary ids", () => {
    const voiceover = { constructor: { src: "v.wav", durationInSeconds: 2 } } as never;
    const t = fitScenesToVoice([{ id: "__proto__", frames: 60 }, { id: "constructor", frames: 30 }], { fps: 30, voiceover });
    expect(t.durations.__proto__).toBe(60);
    expect(t.starts.constructor).toBe(60);
    expect(t.voiceStarts.constructor).toBe(60);
    expect(t.starts.toString).toBeUndefined();
  });

  it("never makes a scene shorter than the transition that joins it", () => {
    const t = fitScenesToVoice([{ id: "a", frames: 60 }, { id: "b", frames: 8 }, { id: "c", frames: 0 }], { fps: 30, transitionFrames: 12 });
    expect(t.durations).toEqual({ a: 60, b: 13, c: 13 });
    expect(t.starts.b! < t.starts.c!).toBe(true);
  });
});

