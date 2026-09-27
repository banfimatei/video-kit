import type { Voiceover } from "../schema.js";

export interface SceneSpec {
  id: string;
  /** The scene's visual length in frames; null skips the scene. */
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
  const durations: Record<string, number | null> = {};
  const starts: Record<string, number | null> = {};
  const voiceStarts: Record<string, number | null> = {};

  let cursor = 0;
  let durationInFrames = 0;
  for (const scene of scenes) {
    if (scene.frames === null) {
      durations[scene.id] = null;
      starts[scene.id] = null;
      voiceStarts[scene.id] = null;
      continue;
    }
    const clip = opts.voiceover?.[scene.id] ?? null;
    const length = clip
      ? Math.max(scene.frames, lead + Math.ceil(clip.durationInSeconds * opts.fps) + tail)
      : scene.frames;
    durations[scene.id] = length;
    starts[scene.id] = cursor;
    voiceStarts[scene.id] = clip ? cursor + lead : null;
    durationInFrames = cursor + length;
    cursor += length - transition;
  }
  return { durations, starts, voiceStarts, durationInFrames: Math.max(1, durationInFrames) };
}
