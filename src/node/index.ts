/** @banfimatei/video-kit/node — TTS, rendering and site packaging (Node only). */
export {
  TTS_PROVIDERS,
  audioDuration,
  createSynthesizer,
  elevenLabsKey,
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
export {
  composeMusic,
  DEFAULT_MUSIC_PROMPT,
  MUSIC_PROMPT_MAX,
  MUSIC_PROVIDERS,
  type ComposeMusicOptions,
  type MusicProvider,
  type MusicRequest,
  type MusicTrack,
} from "./music.js";
export { bundleSite, packSite } from "./site.js";
