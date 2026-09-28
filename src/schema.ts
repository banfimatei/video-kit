import { z } from "zod";

/** When one word of a voice line is spoken: seconds from the start of its clip's audio. */
export const voiceWordSchema = z.object({
  text: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type VoiceWord = z.infer<typeof voiceWordSchema>;

/** Where a clip's word timings came from: speech-to-text alignment, or its length spread by spoken length. */
export const wordTimingSchema = z.enum(["aligned", "estimated"]);
export type WordTiming = z.infer<typeof wordTimingSchema>;

/** One rendered voice line: a URL (or a path under the project's public/) and its measured length. */
export const voiceClipSchema = z.object({
  src: z.string().min(1),
  durationInSeconds: z.number().positive(),
  /**
   * One entry per token of the line (`text.trim().split(/\s+/)`), in order,
   * spelled as in the script with punctuation ("Alphabet," "2,110"), so a
   * composition can find the word where a name is spoken.
   */
  words: z.array(voiceWordSchema).optional(),
  wordTiming: wordTimingSchema.optional(),
});
export type VoiceClip = z.infer<typeof voiceClipSchema>;

/**
 * What the voice says, keyed by scene id. A composition that wants a voice
 * takes this as its `narration` prop; the renderer (renderComposition, the
 * render service) turns it into `voiceover` with the same keys.
 */
export const narrationSchema = z.record(z.string(), z.string().nullable());
export type Narration = z.infer<typeof narrationSchema>;

/** Rendered voice per scene id, as produced by voiceNarration(). */
export const voiceoverSchema = z.record(z.string(), voiceClipSchema.nullable());
export type Voiceover = z.infer<typeof voiceoverSchema>;

/** The house cues shipped in assets/sfx (see resolveSound). */
export const HOUSE_SOUNDS = ["tick", "whoosh", "thud", "chime", "riser", "page"] as const;
export type HouseSound = (typeof HOUSE_SOUNDS)[number];

/**
 * A sound placed on the timeline. `sound` is anything resolveSound() takes:
 * a house cue ("tick", "whoosh", "thud", "chime", "riser", "page"), an
 * @remotion/sfx name ("remotion:vineBoom"), an http(s) URL, or a path under
 * public/. `at` is seconds from the start of `scene`, or of the video.
 */
export const sfxCueSchema = z.object({
  sound: z.string().min(1),
  at: z.number().nonnegative(),
  scene: z.string().optional(),
  volume: z.number().min(0).max(1).optional(),
  playbackRate: z.number().positive().optional(),
});
export type SfxCue = z.infer<typeof sfxCueSchema>;

/**
 * The audio props a composition can adopt as-is: spread `audioPropsSchema.shape`
 * into its own schema to get narration, voiceover, soundDesign and sfx.
 */
export const audioPropsSchema = z.object({
  narration: narrationSchema.nullable().optional(),
  voiceover: voiceoverSchema.nullable().optional(),
  /** "house" lays the composition's built-in cues; "none" leaves voice and `sfx` only. */
  soundDesign: z.enum(["house", "none"]).optional(),
  sfx: z.array(sfxCueSchema).optional(),
});
export type AudioProps = z.infer<typeof audioPropsSchema>;
