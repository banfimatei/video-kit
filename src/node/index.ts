/** @banfimatei/video-kit/node — TTS, rendering and site packaging (Node only). */
export {
  TTS_PROVIDERS,
  audioDuration,
  createSynthesizer,
  pcmToWav,
  pickTtsProvider,
  voiceNarration,
  type Synthesizer,
  type TtsProvider,
  type VoiceNarrationOptions,
} from "./tts.js";
export {
  renderComposition,
  type RenderCompositionOptions,
  type RenderCompositionResult,
  type RenderStage,
} from "./render.js";
export { bundleSite, packSite } from "./site.js";
