/**
 * @banfimatei/video-kit/core — schemas and timing with no browser assets, so
 * they load in Node (to validate or prepare props) and in a Remotion bundle.
 */
export {
  fitScenesToVoice,
  own,
  type FitOptions,
  type SceneSpec,
  type SceneTimeline,
} from "./timing/fitScenesToVoice.js";
export {
  audioPropsSchema,
  HOUSE_SOUNDS,
  narrationSchema,
  sfxCueSchema,
  voiceClipSchema,
  voiceoverSchema,
  type AudioProps,
  type HouseSound,
  type Narration,
  type SfxCue,
  type VoiceClip,
  type Voiceover,
} from "./schema.js";
