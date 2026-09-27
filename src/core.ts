/**
 * @banfimatei/video-kit/core — schemas and timing with no browser assets, so
 * they load in Node (to validate or prepare props) and in a Remotion bundle.
 */
export {
  fitScenesToVoice,
  type FitOptions,
  type SceneSpec,
  type SceneTimeline,
} from "./timing/fitScenesToVoice.js";
export {
  audioPropsSchema,
  narrationSchema,
  sfxCueSchema,
  voiceClipSchema,
  voiceoverSchema,
  type AudioProps,
  type Narration,
  type SfxCue,
  type VoiceClip,
  type Voiceover,
} from "./schema.js";
