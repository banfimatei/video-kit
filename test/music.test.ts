import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeMusic, DEFAULT_MUSIC_PROMPT } from "../src/node/music.js";
import { pcmToWav, pickTtsProvider } from "../src/node/tts.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "vk-music-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const silence = (seconds: number) => pcmToWav(Buffer.alloc(Math.round(seconds * 24_000) * 2), 24_000);

describe("composeMusic", () => {
  it("asks ElevenLabs for an instrumental bed a second longer than the video, and caches it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(silence(2));
    }) as unknown as typeof fetch;
    const dir = tmp();
    const opts = {
      request: { provider: "elevenlabs" as const },
      seconds: 42.4,
      dir,
      toSrc: (f: string) => `http://x/${f}`,
      env: { ELEVENLABS_KEY: "e-key" },
      fetchImpl,
    };
    const track = await composeMusic(opts);
    expect(track.provider).toBe("elevenlabs");
    expect(track.src).toMatch(/^http:\/\/x\/[0-9a-f]{24}\.mp3$/);
    expect(track.durationInSeconds).toBeCloseTo(2, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128");
    expect((calls[0].init.headers as Record<string, string>)["xi-api-key"]).toBe("e-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      prompt: DEFAULT_MUSIC_PROMPT,
      music_length_ms: 43_400,
      model_id: "music_v1",
      force_instrumental: true,
    });

    await composeMusic(opts);
    expect(calls).toHaveLength(1);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("keeps the length inside the API's range and uses a request's own prompt", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(silence(1));
    }) as unknown as typeof fetch;
    await composeMusic({
      request: { provider: "elevenlabs", prompt: "  solo piano  " },
      seconds: 3,
      dir: tmp(),
      toSrc: (f) => f,
      env: { ELEVENLABS_API_KEY: "k" },
      fetchImpl,
    });
    expect(body.music_length_ms).toBe(10_000);
    expect(body.prompt).toBe("solo piano");
  });

  it("says what failed", async () => {
    const fetchImpl = (async () => new Response("quota exceeded", { status: 402 })) as unknown as typeof fetch;
    await expect(
      composeMusic({ request: { provider: "elevenlabs" }, seconds: 20, dir: tmp(), toSrc: (f) => f, env: { ELEVENLABS_KEY: "k" }, fetchImpl }),
    ).rejects.toThrow(/ElevenLabs music 402: quota exceeded/);
    await expect(
      composeMusic({ request: { provider: "elevenlabs" }, seconds: 20, dir: tmp(), toSrc: (f) => f, env: {}, fetchImpl }),
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});

describe("ElevenLabs key", () => {
  it("is found under ELEVENLABS_KEY too", () => {
    expect(pickTtsProvider(undefined, { ELEVENLABS_KEY: "e", DEEPGRAM_API_KEY: "d" })).toBe("elevenlabs");
  });
});
