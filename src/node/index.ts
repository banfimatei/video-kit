/** @banfimatei/video-kit/node — TTS, rendering and site packaging (Node only). */
export {
  TTS_PROVIDERS,
  audioDuration,
  createSynthesizer,
  pcmToWav,
  pickTtsProvider,
  TTS_OPTION_PATTERN,
  voiceNarration,
  withTtsOptions,
  type Synthesizer,
  type TtsOptions,
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
