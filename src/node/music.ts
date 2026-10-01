/**
 * Music for a render: an instrumental bed composed to the composition's
 * length, so it never loops or cuts mid-phrase.
 *
 * Providers:
 *   elevenlabs  ELEVENLABS_API_KEY (or ELEVENLABS_KEY)  [ELEVENLABS_MUSIC_MODEL]
 *
 * Tracks are named by a hash of provider, model, prompt and length, so the
 * same bed at the same length is composed once. Written, measured and only
 * then trusted, like voice clips (ensureClip).
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { elevenLabsKey, ensureClip } from "./tts.js";

type Env = Record<string, string | undefined>;

export const MUSIC_PROVIDERS = ["elevenlabs"] as const;
export type MusicProvider = (typeof MUSIC_PROVIDERS)[number];

/** What a render asks for: a provider and, optionally, its own prompt. */
export interface MusicRequest {
  provider: MusicProvider;
  prompt?: string;
}

/** The composed track as the composition receives it (the `musicTrack` prop). */
export interface MusicTrack {
  src: string;
  durationInSeconds: number;
  provider: MusicProvider;
}

/** A bed for a calm, news-style explainer: steady, even, out of the voice's way. */
export const DEFAULT_MUSIC_PROMPT =
  "Instrumental underscore for a short, modern explainer video about what investors discussed this week. " +
  "Minimal electronic: warm muted synth pads, a soft steady pulse around 100 BPM, light clean percussion. " +
  "Confident, calm and focused, never dramatic. No vocals, no big drops or builds, an even level throughout " +
  "so a voiceover sits on top, and a clean ending.";

export const MUSIC_PROMPT_MAX = 2000;
/** The API's range for a composition's length. */
const MIN_MS = 10_000;
const MAX_MS = 300_000;

export interface ComposeMusicOptions {
  request: MusicRequest;
  /** How long the composition is; the track is composed a second longer so it outlasts the fade. */
  seconds: number;
  /** Where tracks are written (and looked up, for the cache). */
  dir: string;
  /** How the composition reaches a track, given its file name. */
  toSrc: (file: string) => string;
  env?: Env;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function composeMusic(opts: ComposeMusicOptions): Promise<MusicTrack> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const key = elevenLabsKey(env);
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set (needed for ElevenLabs music).");
  const prompt = (opts.request.prompt?.trim() || DEFAULT_MUSIC_PROMPT).slice(0, MUSIC_PROMPT_MAX);
  const model = env.ELEVENLABS_MUSIC_MODEL || "music_v1";
  const ms = Math.min(MAX_MS, Math.max(MIN_MS, Math.ceil(opts.seconds * 1000) + 1000));
  const hash = createHash("sha256").update(["elevenlabs-music", model, prompt, ms].join("\n")).digest("hex").slice(0, 24);
  const file = `${hash}.mp3`;
  await mkdir(opts.dir, { recursive: true });
  const durationInSeconds = await ensureClip(path.join(opts.dir, file), async () => {
    const timeout = AbortSignal.timeout(300_000);
    const res = await fetchImpl("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ prompt, music_length_ms: ms, model_id: model, force_instrumental: true }),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs music ${res.status}: ${body.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  });
  return { src: opts.toSrc(file), durationInSeconds, provider: opts.request.provider };
}
