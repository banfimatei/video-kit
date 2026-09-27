import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { audioDuration, createSynthesizer, pcmToWav, pickTtsProvider, voiceNarration } from "../src/node/tts.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "vk-tts-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** `seconds` of silence as 16-bit mono PCM at 16 kHz. */
const silence = (seconds: number) => pcmToWav(Buffer.alloc(Math.round(seconds * 16000) * 2), 16000);

describe("pickTtsProvider", () => {
  it("honours an explicit choice, and none", () => {
    expect(pickTtsProvider("openai", {})).toBe("openai");
    expect(pickTtsProvider("none", { ELEVENLABS_API_KEY: "k" })).toBeNull();
    expect(pickTtsProvider(undefined, { TTS_PROVIDER: "espeak" })).toBe("espeak");
  });
  it("otherwise takes the first provider with a key", () => {
    expect(pickTtsProvider(undefined, { GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" })).toBe("openai");
    expect(pickTtsProvider(undefined, { GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e" })).toBe("elevenlabs");
    expect(pickTtsProvider(undefined, {})).toBeNull();
  });
  it("rejects an unknown provider", () => {
    expect(() => pickTtsProvider("polly", {})).toThrow(/Unknown TTS provider/);
  });
});

describe("pcmToWav + audioDuration", () => {
  it("writes a header mediabunny can measure", async () => {
    const d = tmp();
    const f = path.join(d, "a.wav");
    writeFileSync(f, silence(2.5));
    expect(await audioDuration(f)).toBeCloseTo(2.5, 3);
    const buf = readFileSync(f);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.readUInt32LE(24)).toBe(16000);
  });
});

describe("voiceNarration", () => {
  it("voices non-empty lines, keeps keys, caches by text and reports durations", async () => {
    const d = tmp();
    let calls = 0;
    const synthesizer = {
      voice: "fake",
      ext: "wav" as const,
      synthesize: async (text: string) => {
        calls++;
        return silence(text.length / 10);
      },
    };
    const narration = { opener: "Hello   there", empty: "  ", missing: null, closer: "Bye" };
    const v = await voiceNarration(narration, { provider: "espeak", dir: d, synthesizer, toSrc: (f) => `http://x/${f}` });
    expect(Object.keys(v)).toEqual(["opener", "empty", "missing", "closer"]);
    expect(v.empty).toBeNull();
    expect(v.missing).toBeNull();
    expect(v.opener?.src).toMatch(/^http:\/\/x\/[0-9a-f]{24}\.wav$/);
    expect(v.opener?.durationInSeconds).toBeCloseTo("Hello there".length / 10, 2);
    expect(calls).toBe(2);
    const again = await voiceNarration(narration, { provider: "espeak", dir: d, synthesizer });
    expect(calls).toBe(2);
    expect(again.opener?.src).toMatch(/^voiceover\//);
  });

  it("builds provider requests with the right auth and fails loudly on errors", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.includes("googleapis")) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.alloc(4800).toString("base64") } }] } }],
          }),
        );
      }
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch;

    const gemini = createSynthesizer("gemini", { GEMINI_API_KEY: "g-key" }, fetchImpl);
    const wav = await gemini.synthesize("hi");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect((seen[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");

    const openai = createSynthesizer("openai", { OPENAI_API_KEY: "o-key" }, fetchImpl);
    await expect(openai.synthesize("hi")).rejects.toThrow(/OpenAI TTS 401/);
    expect((seen[1].init.headers as Record<string, string>).Authorization).toBe("Bearer o-key");

    expect(() => createSynthesizer("elevenlabs", {}, fetchImpl)).toThrow(/ELEVENLABS_API_KEY/);
  });
});
