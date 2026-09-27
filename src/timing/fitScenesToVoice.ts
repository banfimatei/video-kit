import type { Voiceover } from "../schema.js";

export interface SceneSpec {
  /** Unique within the list. */
  id: string;
  /**
   * The scene's visual length in frames; null skips the scene. A scene is
   * never shorter than `transitionFrames + 1` (a transition can't be longer
   * than the sequences it joins).
   */
  frames: number | null;
}

export interface FitOptions {
  fps: number;
  voiceover?: Voiceover | null;
  /** Overlap between consecutive scenes (a TransitionSeries transition). Default 0. */
  transitionFrames?: number;
  /** Frames into its scene before a line starts. Default: transitionFrames, so a line starts once the fade is over. */
  leadFrames?: number;
  /** Breath after a line before the scene may end. Default 0.7s. */
  tailSeconds?: number;
}

export interface SceneTimeline {
  /** Each scene's length after fitting its line; null for a skipped scene. */
  durations: Record<string, number | null>;
  /** First frame of each scene on the video's timeline. */
  starts: Record<string, number | null>;
  /** Frame where each scene's voice line starts, or null without one. */
  voiceStarts: Record<string, number | null>;
  durationInFrames: number;
}

/** A record with no prototype, so ids like "constructor" or "__proto__" are plain keys. */
const record = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** Read `key` only if it is the record's own entry (never an Object.prototype member). */
export function own<T>(rec: Record<string, T> | null | undefined, key: string): T | undefined {
  return rec && Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined;
}

/**
 * Lay scenes end to end (overlapping by `transitionFrames`) and stretch any
 * scene whose voice line would not fit: line start (`leadFrames` in) + line +
 * a breath. With the default lead equal to the transition, the next scene's
 * line cannot start before this one's has ended, so lines never overlap.
 * Read it in calculateMetadata (for the length) and in the component (for
 * the cuts and the audio) so the two cannot drift apart.
 */
export function fitScenesToVoice(scenes: SceneSpec[], opts: FitOptions): SceneTimeline {
  const transition = opts.transitionFrames ?? 0;
  const lead = opts.leadFrames ?? transition;
  const tail = Math.round((opts.tailSeconds ?? 0.7) * opts.fps);
  const durations = record<number | null>();
  const starts = record<number | null>();
  const voiceStarts = record<number | null>();
  const minimum = Math.max(1, transition + 1);

  let cursor = 0;
  let durationInFrames = 0;
  for (const scene of scenes) {
    if (Object.prototype.hasOwnProperty.call(durations, scene.id)) {
      throw new Error(`fitScenesToVoice: scene id "${scene.id}" is used twice; ids must be unique.`);
    }
    if (scene.frames === null) {
      durations[scene.id] = null;
      starts[scene.id] = null;
      voiceStarts[scene.id] = null;
      continue;
    }
    const clip = own(opts.voiceover ?? undefined, scene.id) ?? null;
    const visual = Math.max(minimum, Math.round(scene.frames) || 0);
    const length = clip ? Math.max(visual, lead + Math.ceil(clip.durationInSeconds * opts.fps) + tail) : visual;
    durations[scene.id] = length;
    starts[scene.id] = cursor;
    voiceStarts[scene.id] = clip ? cursor + lead : null;
    durationInFrames = cursor + length;
    cursor += length - transition;
  }
  return { durations, starts, voiceStarts, durationInFrames: Math.max(1, durationInFrames) };
}
