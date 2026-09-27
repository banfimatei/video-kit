/**
 * @banfimatei/video-kit — the parts that run inside a Remotion composition.
 * Node-side tooling (TTS, rendering, the CLI) is in "@banfimatei/video-kit/node";
 * the render service client is in "@banfimatei/video-kit/client".
 */
export { HOUSE_SFX, HOUSE_SFX_NAMES, REMOTION_SFX, resolveSound, type HouseSfx } from "./audio/library.js";
export { Sfx } from "./audio/Sfx.js";
export { SfxCues } from "./audio/SfxCues.js";
export { VoiceTrack } from "./audio/VoiceTrack.js";
export * from "./core.js";
