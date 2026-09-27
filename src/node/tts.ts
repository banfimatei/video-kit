/**
 * Text to speech: voice a composition's narration into audio files and
 * measure them, producing the `voiceover` prop that fitScenesToVoice() and
 * <VoiceTrack> read.
 *
 * Providers, picked by name or else by whichever key is set, in this order:
 *   elevenlabs  ELEVENLABS_API_KEY  [ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL]
 *   openai      OPENAI_API_KEY      [OPENAI_TTS_MODEL, OPENAI_TTS_VOICE, OPENAI_TTS_INSTRUCTIONS]
 *   gemini      GEMINI_API_KEY      [GEMINI_TTS_MODEL, GEMINI_TTS_VOICE]
 *   espeak      espeak-ng on PATH, no key: robotic, for offline tests and CI only
 *   none        no voice
 *
 * Files are named by a hash of provider, voice and text, so voicing the same
 * line again is free.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
import type { Narration, VoiceClip, Voiceover } from "../schema.js";

const execFileAsync = promisify(execFile);

export const TTS_PROVIDERS = ["elevenlabs", "openai", "gemini", "espeak"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];
type Env = Record<string, string | undefined>;

/** The requested provider ("none" means no voice), else the first one with a key; null means no voice. */
export function pickTtsProvider(requested?: string | null, env: Env = process.env): TtsProvider | null {
  const want = (requested || env.TTS_PROVIDER || "").trim().toLowerCase();
  if (want === "none") return null;
  if (want) {
    if (!(TTS_PROVIDERS as readonly string[]).includes(want)) {
      throw new Error(`Unknown TTS provider "${want}". Use one of: ${TTS_PROVIDERS.join(", ")}, none.`);
    }
    return want as TtsProvider;
  }
  if (env.ELEVENLABS_API_KEY) return "elevenlabs";
  if (env.OPENAI_API_KEY) return "openai";
  if (env.GEMINI_API_KEY) return "gemini";
  return null;
}

export interface Synthesizer {
  /** Everything besides the text that changes the audio; part of the cache key. */
  voice: string;
  ext: "mp3" | "wav";
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>;
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(120_000);
  const res = await fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} TTS ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

/** 16-bit mono PCM wrapped in a WAV header (Gemini returns raw PCM). */
export function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

export function createSynthesizer(
  provider: TtsProvider,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Synthesizer {
  switch (provider) {
    case "elevenlabs": {
      const key = required(env, "ELEVENLABS_API_KEY");
      const voiceId = env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
      const model = env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
      return {
        voice: `${voiceId}/${model}`,
        ext: "mp3",
        synthesize: async (text, signal) => {
          const res = await post(
            fetchImpl,
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
            {
              method: "POST",
              headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
              body: JSON.stringify({
                text,
                model_id: model,
                voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0.1 },
              }),
            },
            "ElevenLabs",
            signal,
          );
          return Buffer.from(await res.arrayBuffer());
        },
      };
    }
    case "openai": {
      const key = required(env, "OPENAI_API_KEY");
      const model = env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
      const voice = env.OPENAI_TTS_VOICE || "onyx";
      const instructions = env.OPENAI_TTS_INSTRUCTIONS || "Measured, neutral delivery. No hype.";
      return {
        voice: `${model}/${voice}/${instructions}`,
        ext: "mp3",
        synthesize: async (text, signal) => {
          const res = await post(
            fetchImpl,
            "https://api.openai.com/v1/audio/speech",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model, voice, input: text, response_format: "mp3", instructions }),
            },
            "OpenAI",
            signal,
          );
          return Buffer.from(await res.arrayBuffer());
        },
      };
    }
    case "gemini": {
      const key = required(env, "GEMINI_API_KEY");
      const model = env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
      const voice = env.GEMINI_TTS_VOICE || "Charon";
      return {
        voice: `${model}/${voice}`,
        ext: "wav",
        synthesize: async (text, signal) => {
          const res = await post(
            fetchImpl,
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
              method: "POST",
              headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text }] }],
                generationConfig: {
                  responseModalities: ["AUDIO"],
                  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
                },
              }),
            },
            "Gemini",
            signal,
          );
          const json = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
          };
          const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
          if (!part?.data) throw new Error("Gemini TTS returned no audio.");
          const rate = Number(/rate=(\d+)/.exec(part.mimeType ?? "")?.[1] ?? 24000);
          return pcmToWav(Buffer.from(part.data, "base64"), rate);
        },
      };
    }
    case "espeak": {
      const voice = env.ESPEAK_VOICE || "en-us";
      const speed = env.ESPEAK_SPEED || "165";
      return {
        voice: `${voice}/${speed}`,
        ext: "wav",
        synthesize: async (text, signal) => {
          try {
            // `--` so a line starting with "-" (say "-5% this quarter") is text, not an option.
            const { stdout } = await execFileAsync("espeak-ng", ["-v", voice, "-s", speed, "--stdout", "--", text], {
              encoding: "buffer",
              maxBuffer: 64 * 1024 * 1024,
              signal,
            });
            return stdout;
          } catch (err) {
            if (signal?.aborted) throw err;
            throw new Error(`espeak-ng failed (is it installed?): ${(err as Error).message}`);
          }
        },
      };
    }
  }
}

export async function audioDuration(file: string): Promise<number> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    return await input.computeDuration();
  } finally {
    input.dispose();
  }
}

export interface VoiceNarrationOptions {
  provider: TtsProvider;
  /** Where clips are written (and looked up, for the cache). */
  dir: string;
  /**
   * How the composition reaches a clip, given its file name. Default
   * `voiceover/<file>` (a path under the project's public/, for a local
   * bundle). A render service passes an http URL instead.
   */
  toSrc?: (file: string) => string;
  env?: Env;
  fetchImpl?: typeof fetch;
  /** Inject a synthesizer (tests); overrides provider. */
  synthesizer?: Synthesizer;
  /** Stop between clips and cancel the one in flight. */
  signal?: AbortSignal;
}

/**
 * Clips being written right now, by path: two renders voicing the same line
 * at once share one request instead of racing on the same file.
 */
const inFlight = new Map<string, Promise<number>>();

/** Seconds of audio in `file`, or null if it isn't a playable clip. */
async function playableSeconds(file: string): Promise<number | null> {
  const seconds = await audioDuration(file).catch(() => NaN);
  return seconds > 0 ? seconds : null;
}

/**
 * Make sure `file` holds a good clip and return its length: reuse it, share
 * another caller's request for it, or synthesize it. Every clip is measured
 * before it is trusted, so an empty or non-audio response is an error now,
 * and a bad file already in the cache is replaced rather than failing every
 * render that needs the line.
 */
async function ensureClip(file: string, synthesize: () => Promise<Buffer>): Promise<number> {
  if (existsSync(file)) {
    const seconds = await playableSeconds(file);
    if (seconds !== null) {
      // Touch on use, so a cache sweep by age keeps clips that are still being rendered.
      const now = new Date();
      await utimes(file, now, now).catch(() => undefined);
      return seconds;
    }
    await rm(file, { force: true });
  }
  const pending = inFlight.get(file);
  if (pending) {
    // Share the other render's request; if it failed (say it was canceled), try ourselves.
    const seconds = await pending.catch(() => null);
    if (seconds !== null) return seconds;
    return ensureClip(file, synthesize);
  }
  const write = (async () => {
    const audio = await synthesize();
    if (!audio.length) throw new Error("The TTS provider returned no audio.");
    // Write, check, then rename, so the cache only ever holds whole, playable clips.
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, audio);
      const seconds = await playableSeconds(tmp);
      if (seconds === null) throw new Error("The TTS provider returned something that isn't playable audio.");
      await rename(tmp, file);
      return seconds;
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  })();
  inFlight.set(file, write);
  try {
    return await write;
  } finally {
    inFlight.delete(file);
  }
}

/** Voice every non-empty line of `narration`; lines already on disk are reused. Keys are kept. */
export async function voiceNarration(narration: Narration, opts: VoiceNarrationOptions): Promise<Voiceover> {
  const tts = opts.synthesizer ?? createSynthesizer(opts.provider, opts.env, opts.fetchImpl);
  const toSrc = opts.toSrc ?? ((file: string) => `voiceover/${file}`);
  await mkdir(opts.dir, { recursive: true });

  const out: Voiceover = {};
  for (const [scene, text] of Object.entries(narration)) {
    opts.signal?.throwIfAborted();
    const clean = text?.replace(/\s+/g, " ").trim();
    if (!clean) {
      out[scene] = null;
      continue;
    }
    const hash = createHash("sha256").update(`${opts.provider}\n${tts.voice}\n${clean}`).digest("hex").slice(0, 24);
    const name = `${hash}.${tts.ext}`;
    const file = path.join(opts.dir, name);
    const seconds = await ensureClip(file, () => tts.synthesize(clean, opts.signal));
    const clip: VoiceClip = { src: toSrc(name), durationInSeconds: seconds };
    out[scene] = clip;
  }
  return out;
}
