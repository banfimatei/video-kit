import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceClipSchema, type VoiceWord } from "../src/schema.js";
import { pcmToWav, voiceNarration } from "../src/node/tts.js";
import {
  alignToTranscript,
  alignWords,
  DEEPGRAM_LISTEN_URL,
  estimateWords,
  scriptTokens,
  wordKey,
  wordsForClip,
  type SttWord,
} from "../src/node/words.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "vk-words-"));
  dirs.push(d);
  return d;
};
// Keep a developer's real key out of these tests: every alignment here goes to a fake fetch.
beforeEach(() => vi.stubEnv("DEEPGRAM_API_KEY", undefined));
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const silence = (seconds: number) => pcmToWav(Buffer.alloc(Math.round(seconds * 16000) * 2), 16000);

/** The invariants every words[] keeps, whatever its source. */
function expectWellFormed(words: VoiceWord[], text: string, duration: number) {
  expect(words.map((w) => w.text)).toEqual(text.trim().split(/\s+/));
  let last = 0;
  for (const w of words) {
    expect(w.start).toBeGreaterThanOrEqual(last);
    expect(w.end).toBeGreaterThanOrEqual(w.start);
    expect(w.end).toBeLessThanOrEqual(duration);
    last = w.end;
  }
}

/** A Deepgram /v1/listen response shaped like the real one (nova-3, smart_format). */
function deepgramResponse(heard: Array<[punctuated: string, start: number, end: number]>, duration: number) {
  const words = heard.map(([punctuated_word, start, end]) => ({
    // Deepgram's `word` is lower case without punctuation; smart_format numbers lose their separators.
    word: punctuated_word.toLowerCase().replace(/[.,!?]+$/, "").replace(/(\d),(\d)/g, "$1$2"),
    start,
    end,
    confidence: 0.98,
    punctuated_word,
  }));
  return {
    metadata: { request_id: "3f0e…", created: "2026-09-28T09:00:00.000Z", duration, channels: 1, models: ["nova-3"] },
    results: {
      channels: [
        { alternatives: [{ transcript: heard.map((h) => h[0]).join(" "), confidence: 0.97, words }] },
      ],
    },
  };
}

const SCRIPT = "This week, Alphabet led 2,110 safe ideas on zortix. The S&P 500 was quiet.";
/** What STT heard: "led" dropped, "zortix" misheard, an extra "uh", "2,110" formatted by smart_format. */
const HEARD: Array<[string, number, number]> = [
  ["This", 0.12, 0.3],
  ["week,", 0.3, 0.58],
  ["Alphabet", 0.66, 1.2],
  ["2,110", 1.4, 2.3],
  ["safe", 2.34, 2.6],
  ["ideas", 2.6, 3.0],
  ["on", 3.04, 3.14],
  ["zortex.", 3.14, 3.7],
  ["uh", 3.8, 3.9],
  ["The", 4.0, 4.1],
  ["S&P", 4.1, 4.6],
  ["500", 4.6, 5.1],
  ["was", 5.1, 5.3],
  ["quiet.", 5.3, 5.8],
];
const stt = (heard: Array<[string, number, number]>): SttWord[] => deepgramResponse(heard, 6).results.channels[0].alternatives[0].words;
const at = (words: VoiceWord[], text: string) => words.find((w) => w.text === text)!;

describe("estimateWords", () => {
  it("covers every token verbatim, in order, with a sliver of silence at both ends of the clip", () => {
    for (const [text, duration] of [
      [SCRIPT, 6],
      ["One.", 0.8],
      ["  Hello,   world — again!  ", 2.25],
      ["Nvidia, Alphabet and the S&P 500: 2,110 ideas.", 4.321],
    ] as const) {
      const words = estimateWords(text, duration);
      expect(words).toHaveLength(scriptTokens(text).length);
      expectWellFormed(words, text, duration);
      // TTS voices leave a breath before the first word and after the last: 3% and 4%, at most 0.12 s and 0.2 s.
      // (Times are rounded to the millisecond.)
      expect(words[0].start).toBeCloseTo(Math.min(0.12, duration * 0.03), 2);
      expect(words.at(-1)!.end).toBeCloseTo(duration - Math.min(0.2, duration * 0.04), 2);
    }
  });

  it("gives longer words more time and pauses after commas and full stops", () => {
    const words = estimateWords("I remember, extraordinarily well. Yes", 5);
    const len = (w: VoiceWord) => w.end - w.start;
    expect(len(words[2])).toBeGreaterThan(len(words[0]) * 5);
    // Gaps only where the punctuation is, the full stop's longer than the comma's.
    const gap = (i: number) => words[i + 1].start - words[i].end;
    expect(gap(0)).toBeCloseTo(0, 3);
    expect(gap(1)).toBeGreaterThan(0.05);
    expect(gap(3)).toBeGreaterThan(gap(1));
  });

  it("times a number by how long it takes to say, not how many digits it has", () => {
    const len = (w: VoiceWord) => w.end - w.start;
    // "two thousand one hundred ten" against "ideas": 28 letters against 5, plus a space each.
    const [n, ideas] = estimateWords("2,110 ideas", 3);
    expect(len(n) / len(ideas)).toBeCloseTo(29 / 6, 2);
    // Separators, a currency sign, a trailing full stop and a percent sign don't change the reading.
    const lens = (text: string) => estimateWords(text, 4).map(len);
    expect(lens("2,110 ideas")).toEqual(lens("2110 ideas"));
    expect(lens("$56 ideas")).toEqual(lens("56 ideas"));
    const [five, percent] = lens("five percent up");
    expect(lens("5% up")[0]).toBeCloseTo(five + percent, 2);
    // "&" is said "and": "S&P" takes as long as "SandP".
    expect(lens("S&P rose")).toEqual(lens("SandP rose"));
    // A line whose counts come late: the number takes its spoken share, so what follows it isn't rushed
    // (a digit count put "2,110" a second late in this 7.2 s line and squeezed "ideas from 56 shows").
    const opener = estimateWords(
      "This week we listened to 127 hours of investing podcasts, and pulled out 2,110 ideas from 56 shows.",
      7.2,
    );
    expect(at(opener, "2,110").start).toBeGreaterThan(4.3);
    expect(at(opener, "2,110").start).toBeLessThan(4.6);
    expect(at(opener, "56").start).toBeGreaterThan(6.1);
    expect(at(opener, "56").start).toBeLessThan(6.4);
  });

  it("handles empty text and a clip with no length", () => {
    expect(estimateWords("   ", 3)).toEqual([]);
    expect(estimateWords("Two words", 0)).toEqual([
      { text: "Two", start: 0, end: 0 },
      { text: "words", start: 0, end: 0 },
    ]);
    expect(estimateWords("Still two", Number.NaN).every((w) => w.start === 0 && w.end === 0)).toBe(true);
  });
});

describe("wordKey", () => {
  it("ignores case, punctuation and thousands separators, and reads & as and", () => {
    expect(wordKey("Alphabet,")).toBe("alphabet");
    expect(wordKey("2,110")).toBe(wordKey("2110"));
    expect(wordKey("&")).toBe("and");
    expect(wordKey("S&P")).toBe("sp");
    expect(wordKey("Café.")).toBe("cafe");
    expect(wordKey("—")).toBe("");
  });
});

describe("alignToTranscript", () => {
  it("times the script from what was heard, through a dropped word, an extra one and formatted numbers", () => {
    const { words, matched } = alignToTranscript(SCRIPT, stt(HEARD), 6);
    expectWellFormed(words, SCRIPT, 6);
    expect(matched).toBe(13);
    expect(at(words, "Alphabet")).toEqual({ text: "Alphabet", start: 0.66, end: 1.2 });
    expect(at(words, "week,")).toEqual({ text: "week,", start: 0.3, end: 0.58 });
    expect(at(words, "2,110")).toEqual({ text: "2,110", start: 1.4, end: 2.3 });
    // Misheard as "zortex", still found where it was said.
    expect(at(words, "zortix.")).toEqual({ text: "zortix.", start: 3.14, end: 3.7 });
    // The extra "uh" is skipped: "The" keeps its own time.
    expect(at(words, "The")).toEqual({ text: "The", start: 4.0, end: 4.1 });
    expect(at(words, "S&P")).toEqual({ text: "S&P", start: 4.1, end: 4.6 });
    // Dropped by STT: placed in the gap between its neighbours.
    const led = at(words, "led");
    expect(led.start).toBeGreaterThanOrEqual(1.2);
    expect(led.end).toBeLessThanOrEqual(1.4);
    expect(led.end).toBeGreaterThan(led.start);
  });

  it("gives a dropped word part of its neighbours' time when they touch", () => {
    const { words } = alignToTranscript("the cat sat on the mat", stt([["the", 0.1, 0.2], ["cat", 0.2, 0.5], ["on", 0.5, 0.6], ["the", 0.6, 0.7], ["mat", 0.7, 1.0]]), 1.2);
    expectWellFormed(words, "the cat sat on the mat", 1.2);
    // "cat sat on" share cat's start to on's end, [0.2, 0.6], by spoken length plus a space: 4, 4 and 3.
    expect(words[1].start).toBe(0.2);
    expect(words[2].end).toBeCloseTo(0.2 + (0.4 * 8) / 11, 3);
    expect(words[3].end).toBe(0.6);
    expect(words[2].end - words[2].start).toBeGreaterThan(0.1);
  });

  it("matches a web address or & spelled out on either side", () => {
    const dotted = alignToTranscript("Visit zortix.com today", stt([["Visit", 0.1, 0.4], ["zortix", 0.45, 0.9], ["dot", 0.9, 1.05], ["com", 1.05, 1.3], ["today", 1.4, 1.8]]), 2);
    expect(dotted.words[1]).toEqual({ text: "zortix.com", start: 0.45, end: 1.3 });
    expect(dotted.matched).toBe(3);

    const spoken = alignToTranscript("Visit zortix dot com today", stt([["Visit", 0.1, 0.4], ["zortix.com", 0.45, 1.3], ["today", 1.4, 1.8]]), 2);
    expectWellFormed(spoken.words, "Visit zortix dot com today", 2);
    expect(spoken.words[1].start).toBe(0.45);
    expect(spoken.words[3].end).toBe(1.3);
    expect(spoken.matched).toBe(5);

    const and = alignToTranscript("Johnson & Johnson rose", stt([["Johnson", 0.1, 0.5], ["and", 0.5, 0.6], ["Johnson", 0.6, 1.0], ["rose", 1.0, 1.3]]), 1.5);
    expect(and.words[1]).toEqual({ text: "&", start: 0.5, end: 0.6 });
    expect(and.matched).toBe(4);
  });

  it("keeps its place in a long line where STT lost a long run of words", () => {
    const tokens = Array.from({ length: 300 }, (_, i) => `word${i}`);
    // Words 100-189 never heard; everything else 0.25 s apart.
    const heard = tokens.flatMap((t, i) => (i >= 100 && i < 190 ? [] : [[t, i * 0.25, i * 0.25 + 0.2] as [string, number, number]]));
    const { words, matched } = alignToTranscript(tokens.join(" "), stt(heard), 76);
    expectWellFormed(words, tokens.join(" "), 76);
    expect(matched).toBe(210);
    expect(words[99]).toEqual({ text: "word99", start: 24.75, end: 24.95 });
    expect(words[190]).toEqual({ text: "word190", start: 47.5, end: 47.7 });
    expect(words[299]).toEqual({ text: "word299", start: 74.75, end: 74.95 });
    expect(words[150].start).toBeGreaterThan(24.95);
    expect(words[150].end).toBeLessThan(47.5);
  });

  it("clamps to the clip and spreads unheard ends to its edges", () => {
    // STT says the last word runs past the measured clip.
    const over = alignToTranscript("Markets moved today.", stt([["Markets", 0.4, 0.9], ["moved", 0.9, 1.3], ["today.", 1.3, 2.4]]), 2.2);
    expectWellFormed(over.words, "Markets moved today.", 2.2);
    expect(over.words[2]).toEqual({ text: "today.", start: 1.3, end: 2.2 });

    // The first token wasn't heard: it starts the clip. The last wasn't either, with no room
    // left after "today.": the two share that word's time rather than "Fine" getting none.
    const { words } = alignToTranscript("So, markets moved today. Fine", stt([["markets", 0.4, 0.9], ["moved", 0.9, 1.3], ["today.", 1.3, 2.4]]), 2.2);
    expectWellFormed(words, "So, markets moved today. Fine", 2.2);
    expect(words[0]).toMatchObject({ start: 0 });
    expect(words[0].end).toBeLessThanOrEqual(0.4);
    expect(words[1]).toMatchObject({ start: 0.4, end: 0.9 });
    expect(words[3].start).toBe(1.3);
    expect(words[4].end).toBe(2.2);
    expect(words[4].end - words[4].start).toBeGreaterThan(0.1);
  });
});

describe("alignWords", () => {
  it("posts the clip to Deepgram nova-3 with a Token header and aligns the response", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json(deepgramResponse(HEARD, 6.02));
    }) as unknown as typeof fetch;
    const audio = Buffer.from([0xff, 0xf3, 1, 2, 3]);
    const words = await alignWords(SCRIPT, audio, "audio/mpeg", { durationInSeconds: 6, env: { DEEPGRAM_API_KEY: "dg" }, fetchImpl });
    expect(seen[0].url).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en");
    expect(seen[0].url).toBe(DEEPGRAM_LISTEN_URL);
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.headers).toEqual({ Authorization: "Token dg", "Content-Type": "audio/mpeg" });
    expect(seen[0].init.body).toBe(audio);
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
    expectWellFormed(words, SCRIPT, 6);
    expect(at(words, "2,110").start).toBe(1.4);
  });

  it("uses Deepgram's duration when not given one", async () => {
    const fetchImpl = (async () => Response.json(deepgramResponse([["Hello", 0.1, 0.5], ["there.", 0.5, 0.9]], 1.1))) as unknown as typeof fetch;
    const words = await alignWords("Hello there.", Buffer.alloc(4), "audio/wav", { env: { DEEPGRAM_API_KEY: "k" }, fetchImpl });
    expect(words).toEqual([
      { text: "Hello", start: 0.1, end: 0.5 },
      { text: "there.", start: 0.5, end: 0.9 },
    ]);
  });

  it("throws on HTTP errors, bad JSON, no words, a transcript of something else, or no key", async () => {
    const env = { DEEPGRAM_API_KEY: "k" };
    const answer = (res: () => Response) => (async () => res()) as unknown as typeof fetch;
    await expect(alignWords("Hi.", Buffer.alloc(4), "audio/wav", { env, fetchImpl: answer(() => Response.json({ err_msg: "Invalid credentials." }, { status: 401 })) })).rejects.toThrow(/Deepgram STT 401: .*Invalid credentials/);
    await expect(alignWords("Hi.", Buffer.alloc(4), "audio/wav", { env, fetchImpl: answer(() => new Response("<html>bad gateway</html>")) })).rejects.toThrow();
    await expect(alignWords("Hi.", Buffer.alloc(4), "audio/wav", { env, fetchImpl: answer(() => Response.json({ results: {} })) })).rejects.toThrow(/no words/);
    await expect(alignWords("Hi.", Buffer.alloc(4), "audio/wav", { env, fetchImpl: answer(() => Response.json(deepgramResponse([], 1))) })).rejects.toThrow(/heard no words/);
    await expect(
      alignWords("Alphabet led the week on zortix.", Buffer.alloc(4), "audio/wav", {
        env,
        fetchImpl: answer(() => Response.json(deepgramResponse([["Completely", 0, 0.5], ["different", 0.5, 1], ["audio.", 1, 1.4]], 1.5))),
      }),
    ).rejects.toThrow(/matched only 0 of 6/);
    await expect(alignWords("Hi.", Buffer.alloc(4), "audio/wav", { env: {}, fetchImpl: answer(() => Response.json({})) })).rejects.toThrow(/DEEPGRAM_API_KEY/);
  });
});

describe("voiceNarration word timings", () => {
  /** A fake voice making `seconds` of silence per line, and a fake Deepgram that hears HEARD. */
  function rig(opts: { seconds?: number; listen?: () => Response | Promise<Response> } = {}) {
    const calls = { synth: 0, listen: [] as Array<{ url: string; init: RequestInit }> };
    const synthesizer = {
      voice: "fake",
      ext: "wav" as const,
      synthesize: async () => (calls.synth++, silence(opts.seconds ?? 6)),
    };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.listen.push({ url, init });
      return opts.listen ? opts.listen() : Response.json(deepgramResponse(HEARD, 6));
    }) as unknown as typeof fetch;
    return { calls, synthesizer, fetchImpl };
  }
  const env = { DEEPGRAM_API_KEY: "dg" };

  it("aligns each clip once and reuses the cached alignment on the next render", async () => {
    const d = tmp();
    const { calls, synthesizer, fetchImpl } = rig();
    const warnings: string[] = [];
    const first = await voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl, onWarning: (m) => warnings.push(m) });
    expect(first.s0?.wordTiming).toBe("aligned");
    expectWellFormed(first.s0!.words!, SCRIPT, first.s0!.durationInSeconds);
    expect(at(first.s0!.words!, "2,110")).toEqual({ text: "2,110", start: 1.4, end: 2.3 });
    expect(calls.listen).toHaveLength(1);
    expect((calls.listen[0].init.headers as Record<string, string>)["Content-Type"]).toBe("audio/wav");
    const clip = first.s0!.src.replace("voiceover/", "");
    const sidecar = clip.replace(/\.wav$/, ".words.json");
    expect(readdirSync(d).sort()).toEqual([clip, sidecar].sort());
    expect(JSON.parse(readFileSync(path.join(d, sidecar), "utf8")).words).toEqual(first.s0!.words);

    const again = await voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl });
    expect(calls.listen).toHaveLength(1);
    expect(calls.synth).toBe(1);
    expect(again.s0).toEqual(first.s0);
    // Also without a key: the alignment on disk is free.
    const keyless = await voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env: {}, fetchImpl });
    expect(keyless.s0?.wordTiming).toBe("aligned");
    expect(calls.listen).toHaveLength(1);
    expect(warnings).toEqual([]);
    // What the composition's schema accepts.
    expect(voiceClipSchema.parse(first.s0)).toEqual(first.s0);
  });

  it("heals a bad or stale sidecar by aligning again", async () => {
    const d = tmp();
    const { calls, synthesizer, fetchImpl } = rig();
    const v = await voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl });
    const sidecar = path.join(d, v.s0!.src.replace("voiceover/", "").replace(/\.wav$/, ".words.json"));
    const good = JSON.parse(readFileSync(sidecar, "utf8"));

    for (const bad of [
      "{ truncated",
      JSON.stringify({ ...good, words: good.words.slice(1) }), // wrong token count
      JSON.stringify({ ...good, words: good.words.map((w: VoiceWord, i: number) => (i === 3 ? { ...w, start: 99, end: 99 } : w)) }),
      JSON.stringify({ ...good, bytes: good.bytes + 1 }), // made for an earlier clip of this line
    ]) {
      writeFileSync(sidecar, bad);
      const before = calls.listen.length;
      const healed = await voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl });
      expect(calls.listen).toHaveLength(before + 1);
      expect(healed.s0?.wordTiming).toBe("aligned");
      expect(healed.s0?.words).toEqual(good.words);
      expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual(good);
    }
  });

  it("falls back to estimated timings when alignment fails, and never fails the render", async () => {
    for (const listen of [
      () => Response.json({ err_msg: "Internal error" }, { status: 500 }),
      () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
      () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    ]) {
      const d = tmp();
      const { calls, synthesizer, fetchImpl } = rig({ listen });
      const warnings: string[] = [];
      const v = await voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl, onWarning: (m) => warnings.push(m) });
      expect(calls.listen).toHaveLength(1);
      expect(v.s0?.wordTiming).toBe("estimated");
      expect(v.s0?.words).toEqual(estimateWords(SCRIPT, v.s0!.durationInSeconds));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^voiceover "s0": word timings estimated, alignment failed: /);
      // Nothing cached, so the next render tries again.
      expect(readdirSync(d).filter((f) => f.endsWith(".json"))).toEqual([]);
    }
  });

  it("estimates without calling anyone when there is no key, or alignment is off", async () => {
    const d = tmp();
    const { calls, synthesizer, fetchImpl } = rig();
    const v = await voiceNarration({ a: "Hello   there", b: null }, { provider: "espeak", dir: d, synthesizer, env: {}, fetchImpl });
    expect(v.a?.wordTiming).toBe("estimated");
    expect(v.a?.words?.map((w) => w.text)).toEqual(["Hello", "there"]);
    expect(v.b).toBeNull();
    // No env given: process.env, which the stub above keeps key-free.
    await voiceNarration({ a: "Hello there" }, { provider: "espeak", dir: d, synthesizer, fetchImpl });
    expect(calls.listen).toHaveLength(0);

    // Off despite a key, and a cached alignment is ignored too.
    await voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl });
    expect(calls.listen).toHaveLength(1);
    const off = await voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl, alignWords: false });
    expect(off.s0?.wordTiming).toBe("estimated");
    expect(calls.listen).toHaveLength(1);

    const warnings: string[] = [];
    await voiceNarration({ a: "Hi." }, { provider: "espeak", dir: d, synthesizer, env: {}, fetchImpl, alignWords: true, onWarning: (m) => warnings.push(m) });
    expect(warnings).toEqual(["alignWords needs DEEPGRAM_API_KEY; word timings will be estimated."]);
  });

  it("stops on abort during alignment instead of estimating", async () => {
    const d = tmp();
    const ctl = new AbortController();
    const { synthesizer, fetchImpl } = rig({
      listen: () => {
        ctl.abort();
        return Promise.reject(new DOMException("This operation was aborted", "AbortError"));
      },
    });
    const warnings: string[] = [];
    await expect(
      voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl, signal: ctl.signal, onWarning: (m) => warnings.push(m) }),
    ).rejects.toThrow(/abort/i);
    expect(warnings).toEqual([]);
  });

  it("shares one alignment when two renders voice the same line at once", async () => {
    const d = tmp();
    const { calls, synthesizer, fetchImpl } = rig({
      listen: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return Response.json(deepgramResponse(HEARD, 6));
      },
    });
    const [a, b] = await Promise.all([
      voiceNarration({ s0: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl }),
      voiceNarration({ x: SCRIPT }, { provider: "espeak", dir: d, synthesizer, env, fetchImpl }),
    ]);
    expect(calls.listen).toHaveLength(1);
    expect(a.s0?.words).toEqual(b.x?.words);
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("sharing an alignment in flight", () => {
  /** A clip on disk, and a fake Deepgram that answers after `ms` unless its request is aborted first. */
  function slowRig(ms: number) {
    const file = path.join(tmp(), "clip.wav");
    writeFileSync(file, silence(6));
    const calls = { listen: 0 };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.listen++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        init.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(init.signal!.reason)));
      });
      return Response.json(deepgramResponse(HEARD, 6));
    }) as unknown as typeof fetch;
    const opts = (signal?: AbortSignal) => ({
      file,
      seconds: 6,
      cached: false,
      align: true,
      env: { DEEPGRAM_API_KEY: "dg" },
      fetchImpl,
      signal,
      warn: () => undefined,
    });
    return { calls, opts };
  }

  it("stops waiting on another render's alignment as soon as its own render is canceled", async () => {
    const { calls, opts } = slowRig(1000);
    const a = wordsForClip(SCRIPT, opts());
    const ctl = new AbortController();
    const b = wordsForClip(SCRIPT, opts(ctl.signal));
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 20);
    await expect(b).rejects.toThrow(/abort/i);
    expect(Date.now() - t0).toBeLessThan(500);
    // The shared run goes on for the render that started it.
    expect((await a).wordTiming).toBe("aligned");
    expect(calls.listen).toBe(1);
  });

  it("retries once, not once per waiter, when the shared alignment fails", async () => {
    const { calls, opts } = slowRig(50);
    const ctl = new AbortController();
    const a = wordsForClip(SCRIPT, opts(ctl.signal));
    const others = [opts(), opts(), opts()].map((o) => wordsForClip(SCRIPT, o));
    setTimeout(() => ctl.abort(), 10);
    await expect(a).rejects.toThrow(/abort/i);
    for (const r of await Promise.all(others)) expect(r.wordTiming).toBe("aligned");
    expect(calls.listen).toBe(2);
  });
});

describe("voiceClipSchema", () => {
  it("accepts clips with and without word timings", () => {
    expect(voiceClipSchema.parse({ src: "voiceover/a.wav", durationInSeconds: 1 })).toEqual({ src: "voiceover/a.wav", durationInSeconds: 1 });
    const clip = { src: "voiceover/a.wav", durationInSeconds: 1, words: [{ text: "Hi.", start: 0.1, end: 0.6 }], wordTiming: "estimated" };
    expect(voiceClipSchema.parse(clip)).toEqual(clip);
    expect(() => voiceClipSchema.parse({ ...clip, wordTiming: "guessed" })).toThrow();
    expect(() => voiceClipSchema.parse({ ...clip, words: [{ text: "Hi.", start: -1, end: 0 }] })).toThrow();
  });
});
