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
  alignToTranscript,
  alignWords,
  DEEPGRAM_LISTEN_URL,
  estimateWords,
  scriptTokens,
  wordKey,
  type AlignWordsOptions,
  type SttWord,
} from "./words.js";
export type { VoiceWord, WordTiming } from "../schema.js";
export {
  renderComposition,
  type RenderCompositionOptions,
  type RenderCompositionResult,
  type RenderStage,
} from "./render.js";
export { bundleSite, packSite } from "./site.js";
