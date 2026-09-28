import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  audioDuration,
  createSynthesizer,
  pcmToWav,
  pickTtsProvider,
  splitForTts,
  voiceNarration,
  withTtsOptions,
} from "../src/node/tts.js";

const hasEspeak = spawnSync("espeak-ng", ["--version"]).status === 0;
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
  it("falls back to OpenRouter after the direct providers", () => {
    expect(pickTtsProvider(undefined, { OPENROUTER_API_KEY: "r" })).toBe("openrouter");
    expect(pickTtsProvider(undefined, { OPENROUTER_API_KEY: "r", GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(pickTtsProvider("openrouter", {})).toBe("openrouter");
  });
  it("prefers a direct Deepgram key over OpenRouter", () => {
    expect(pickTtsProvider(undefined, { OPENROUTER_API_KEY: "r", DEEPGRAM_API_KEY: "d" })).toBe("deepgram");
    expect(pickTtsProvider(undefined, { DEEPGRAM_API_KEY: "d", GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(pickTtsProvider(undefined, { DEEPGRAM_API_KEY: "d", GEMINI_API_KEY: "g", TTS_PROVIDER: "deepgram" })).toBe("deepgram");
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

  it("shares one request when two renders voice the same line at once, and leaves no temp files", async () => {
    const d = tmp();
    let calls = 0;
    const synthesizer = {
      voice: "fake",
      ext: "wav" as const,
      synthesize: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return silence(1);
      },
    };
    const [a, b] = await Promise.all([
      voiceNarration({ s0: "Same line." }, { provider: "espeak", dir: d, synthesizer }),
      voiceNarration({ x: "Same line." }, { provider: "espeak", dir: d, synthesizer }),
    ]);
    expect(calls).toBe(1);
    expect(a.s0?.src).toBe(b.x?.src);
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("retries a line itself when the shared request failed (say, the other render was canceled)", async () => {
    const d = tmp();
    let calls = 0;
    const synthesizer = {
      voice: "fake",
      ext: "wav" as const,
      synthesize: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        if (calls === 1) throw new Error("canceled");
        return silence(1);
      },
    };
    const results = await Promise.allSettled([
      voiceNarration({ s0: "Line." }, { provider: "espeak", dir: d, synthesizer }),
      voiceNarration({ s0: "Line." }, { provider: "espeak", dir: d, synthesizer }),
    ]);
    // Whichever call made the failing request fails; the other retries by itself and succeeds.
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(calls).toBe(2);
  });

  it("touches cached clips on use, so an age-based sweep keeps the ones still in use", async () => {
    const d = tmp();
    const synthesizer = { voice: "fake", ext: "wav" as const, synthesize: async () => silence(1) };
    const v = await voiceNarration({ s0: "Keep me." }, { provider: "espeak", dir: d, synthesizer });
    const file = path.join(d, v.s0!.src.replace("voiceover/", ""));
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(file, old, old);
    await voiceNarration({ s0: "Keep me." }, { provider: "espeak", dir: d, synthesizer });
    expect(Date.now() - statSync(file).mtimeMs).toBeLessThan(60_000);
  });

  it("stops between clips and hands the signal to the provider", async () => {
    const d = tmp();
    const ctl = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const synthesizer = {
      voice: "fake",
      ext: "wav" as const,
      synthesize: async (_text: string, signal?: AbortSignal) => {
        seen.push(signal);
        ctl.abort();
        return silence(1);
      },
    };
    await expect(
      voiceNarration({ a: "One.", b: "Two." }, { provider: "espeak", dir: d, synthesizer, signal: ctl.signal }),
    ).rejects.toThrow(/abort/i);
    expect(seen).toEqual([ctl.signal]);
  });

  it("never caches an empty or unplayable clip", async () => {
    const d = tmp();
    const bad = (audio: Buffer) => ({ voice: "fake", ext: "wav" as const, synthesize: async () => audio });
    await expect(voiceNarration({ s0: "Empty." }, { provider: "espeak", dir: d, synthesizer: bad(Buffer.alloc(0)) })).rejects.toThrow(/no audio/);
    await expect(
      voiceNarration({ s0: "Junk." }, { provider: "espeak", dir: d, synthesizer: bad(Buffer.from("<html>rate limited</html>")) }),
    ).rejects.toThrow(/playable/);
    expect(readdirSync(d)).toEqual([]);
    // A later good response for the same line is cached normally.
    const ok = await voiceNarration({ s0: "Junk." }, { provider: "espeak", dir: d, synthesizer: bad(silence(1)) });
    expect(ok.s0?.durationInSeconds).toBeCloseTo(1, 2);
  });

  it("replaces a bad clip already in the cache instead of failing on it forever", async () => {
    const d = tmp();
    let calls = 0;
    const synthesizer = { voice: "fake", ext: "wav" as const, synthesize: async () => (calls++, silence(1)) };
    const first = await voiceNarration({ s0: "Heal me." }, { provider: "espeak", dir: d, synthesizer });
    const file = path.join(d, first.s0!.src.replace("voiceover/", ""));
    writeFileSync(file, ""); // poisoned, e.g. by an older version
    const again = await voiceNarration({ s0: "Heal me." }, { provider: "espeak", dir: d, synthesizer });
    expect(calls).toBe(2);
    expect(again.s0?.durationInSeconds).toBeCloseTo(1, 2);
    expect(statSync(file).size).toBeGreaterThan(44);
  });

  it.skipIf(!hasEspeak)("speaks a line that starts with a dash (espeak)", async () => {
    const d = tmp();
    const v = await voiceNarration({ s0: "-5% growth this quarter." }, { provider: "espeak", dir: d });
    expect(v.s0!.durationInSeconds).toBeGreaterThan(0.5);
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

  it("speaks through OpenRouter's /audio/speech as mp3, with tone instructions only for OpenAI models", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const mp3 = Buffer.from([0xff, 0xf3, 0x44, 0xc4]);
    const pcm = Buffer.alloc(4800);
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return JSON.parse(String(init.body)).response_format === "pcm"
        ? new Response(pcm, { headers: { "Content-Type": "audio/pcm;rate=24000;channels=1" } })
        : new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } });
    }) as unknown as typeof fetch;

    const gemini = createSynthesizer("openrouter", { OPENROUTER_API_KEY: "r-key" }, fetchImpl);
    expect(gemini.ext).toBe("wav");
    const wav = await gemini.synthesize("Hello.");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.length).toBe(44 + pcm.length);
    expect(seen[0].url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer r-key");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      model: "google/gemini-3.8-flash-tts",
      input: "Hello.",
      voice: "Charon",
      response_format: "pcm",
    });
    const openai = createSynthesizer("openrouter", { OPENROUTER_API_KEY: "r-key", OPENROUTER_TTS_MODEL: "openai/some-tts", OPENROUTER_TTS_VOICE: "alloy" }, fetchImpl);
    await openai.synthesize("Hi.");
    expect(JSON.parse(String(seen[1].init.body)).provider).toEqual({ options: { openai: { instructions: "Measured, neutral delivery. No hype." } } });

    const voxtral = createSynthesizer(
      "openrouter",
      { OPENROUTER_API_KEY: "r-key", OPENROUTER_TTS_MODEL: "mistralai/voxtral-mini-tts-2603", OPENROUTER_TTS_VOICE: "en_paul_neutral" },
      fetchImpl,
    );
    expect(voxtral.ext).toBe("mp3");
    expect(await voxtral.synthesize("Hi.")).toEqual(mp3);
    const body = JSON.parse(String(seen[2].init.body));
    expect(body).toMatchObject({ model: "mistralai/voxtral-mini-tts-2603", voice: "en_paul_neutral", response_format: "mp3" });
    expect(body.provider).toBeUndefined();
    // Different model or voice, different cache key.
    expect(voxtral.voice).not.toBe(gemini.voice);
  });

  it("speaks through Deepgram Aura-2 with a Token header, splitting long lines", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(Buffer.from([0xff, 0xf3, seen.length]), { headers: { "Content-Type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const dg = createSynthesizer("deepgram", { DEEPGRAM_API_KEY: "dg-key" }, fetchImpl);
    expect(dg.ext).toBe("mp3");
    expect(dg.voice).toBe("aura-2-thalia-en");
    await dg.synthesize("Hello.");
    expect(seen[0].url).toBe("https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Token dg-key");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ text: "Hello." });

    const apollo = createSynthesizer("deepgram", { DEEPGRAM_API_KEY: "k", DEEPGRAM_TTS_MODEL: "aura-2-apollo-en" }, fetchImpl);
    const long = "This sentence is exactly forty chars ok. ".repeat(60).trim(); // ~2400 chars
    const audio = await apollo.synthesize(long);
    const calls = seen.slice(1);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.url.includes("model=aura-2-apollo-en"))).toBe(true);
    expect(calls.every((c) => JSON.parse(String(c.init.body)).text.length <= 2000)).toBe(true);
    expect(audio.length).toBe(6);
    const err = createSynthesizer("deepgram", { DEEPGRAM_API_KEY: "k" }, (async () =>
      Response.json({ err_msg: "Invalid credentials." }, { status: 401 })) as unknown as typeof fetch);
    await expect(err.synthesize("x")).rejects.toThrow(/Deepgram TTS 401/);
  });

  it("sends flux-* Deepgram models to Flux TTS on /v2/speak", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(Buffer.from([0xff, 0xf3, 1]), { headers: { "Content-Type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const flux = createSynthesizer("deepgram", { DEEPGRAM_API_KEY: "k", DEEPGRAM_TTS_MODEL: "flux-hannah-en" }, fetchImpl);
    await flux.synthesize("Hello.");
    expect(seen[0]).toBe("https://api.deepgram.com/v2/speak?model=flux-hannah-en&encoding=mp3");
    expect(flux.voice).toBe("flux-hannah-en");
  });

  it("overrides a provider's model and voice for one call, without touching the env", () => {
    const env = { DEEPGRAM_API_KEY: "k", DEEPGRAM_TTS_MODEL: "aura-2-thalia-en" };
    const dg = withTtsOptions("deepgram", env, { voice: "flux-miles-en" });
    expect(dg.DEEPGRAM_TTS_MODEL).toBe("flux-miles-en");
    expect(env.DEEPGRAM_TTS_MODEL).toBe("aura-2-thalia-en");
    expect(createSynthesizer("deepgram", dg, fetch).voice).toBe("flux-miles-en");
    const or = withTtsOptions("openrouter", { OPENROUTER_API_KEY: "k" }, { model: "google/gemini-3.8-flash-tts", voice: "Kore" });
    expect(or).toMatchObject({ OPENROUTER_TTS_MODEL: "google/gemini-3.8-flash-tts", OPENROUTER_TTS_VOICE: "Kore" });
    expect(withTtsOptions("openai", env, null)).toBe(env);
    expect(() => withTtsOptions("espeak", {}, { model: "x" })).toThrow(/no model option/);
    expect(() => withTtsOptions("deepgram", env, { voice: "bad voice; rm" })).toThrow(/Invalid TTS voice/);
  });

  it("splits text at sentence ends, then spaces", () => {
    expect(splitForTts("Short.", 100)).toEqual(["Short."]);
    const parts = splitForTts("One two three. Four five six. Seven eight nine.", 30);
    expect(parts.every((p) => p.length <= 30)).toBe(true);
    expect(parts.join(" ")).toBe("One two three. Four five six. Seven eight nine.");
    expect(splitForTts("x".repeat(25), 10)).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  });

  it("fails loudly when OpenRouter answers with an error or with something that isn't audio", async () => {
    const err = createSynthesizer("openrouter", { OPENROUTER_API_KEY: "k" }, (async () =>
      Response.json({ error: { message: "Model X does not exist" } }, { status: 400 })) as unknown as typeof fetch);
    await expect(err.synthesize("x")).rejects.toThrow(/OpenRouter TTS 400: .*does not exist/);
    const html = createSynthesizer("openrouter", { OPENROUTER_API_KEY: "k" }, (async () =>
      new Response("<html>oops</html>", { headers: { "Content-Type": "text/html" } })) as unknown as typeof fetch);
    await expect(html.synthesize("x")).rejects.toThrow(/not audio/);
    expect(() => createSynthesizer("openrouter", {}, fetch)).toThrow(/OPENROUTER_API_KEY/);
  });
});
