/**
 * Word timings for voice clips: when each word of a line is spoken, in
 * seconds from the start of that clip's audio, so a composition can caption
 * word by word or put something on screen on the word that names it.
 *
 * Two sources, recorded as the clip's `wordTiming`:
 *   aligned    Deepgram speech-to-text (nova-3) on the clip, matched back to
 *              the script, so each entry keeps the script's own spelling
 *   estimated  the clip's length spread over the words by spoken length
 *              (a number counts as its words): no DEEPGRAM_API_KEY,
 *              alignment turned off, or it failed
 *
 * Either way `words` has exactly one entry per script token
 * (`text.trim().split(/\s+/)`, punctuation kept), in order, with times that
 * never go backwards and stay within the clip.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { VoiceWord, WordTiming } from "../schema.js";

type Env = Record<string, string | undefined>;
type Span = [start: number, end: number];

/** One recognised word as Deepgram's /v1/listen returns it. */
export interface SttWord {
  word: string;
  start: number;
  end: number;
  punctuated_word?: string;
}

/** The tokens `words` covers: the line split on whitespace, punctuation kept ("Alphabet," "2,110"). */
export function scriptTokens(text: string): string[] {
  const t = text.trim();
  return t ? t.split(/\s+/) : [];
}

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** An integer in words ("2110" → "two thousand one hundred ten"): how long it takes to say. */
function numberWords(n: number): string {
  if (n < 20) return ONES[n] || "zero";
  if (n < 100) return `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}`.trim();
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred ${n % 100 ? numberWords(n % 100) : ""}`.trim();
  for (const [size, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const) {
    if (n >= size) {
      const rest = n % size;
      return `${numberWords(Math.floor(n / size))} ${name} ${rest ? numberWords(rest) : ""}`.trim();
    }
  }
  return String(n);
}

/**
 * How long a token takes to say, in letters: a number counts as its words
 * ("2,110" is 28 letters spoken, not 4 digits written; "5%" adds "percent")
 * and "&" as "and". Numbers are where a line's counts sit, so they are where a
 * cue most needs to land on time, and a digit count puts them up to a second
 * early or late in a long line. The composition's own estimator (zortix
 * video/src/SignalShort/words.ts) counts the same way, so the two agree.
 */
function spokenLength(token: string): number {
  const bare = token.replace(/[^\p{L}\p{N}&%.]/gu, "").replace(/\.+$/, "");
  const digits = bare.replace(/%$/, "");
  if (/^\d{1,12}$/.test(digits)) return numberWords(Number(digits)).length + (bare.endsWith("%") ? 8 : 0);
  return bare.replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "").length;
}

/**
 * The pause a voice leaves after a token, in letters' worth of time: a comma
 * breathes, a sentence end (or a colon before a list) breathes longer.
 * Closing quotes and brackets don't hide the punctuation before them ("said."
 * is still a full stop).
 */
function pauseAfter(token: string): number {
  const bare = token.replace(/["'”’»)\]]+$/u, "");
  if (/[.!?…:]$/u.test(bare)) return 4;
  if (/[,;—–]$/u.test(bare)) return 2;
  return 0;
}

/**
 * Lay `tokens` over [from, to] by spoken length, each with a letter's worth
 * for the space after it (so a lone "—" still takes a beat), and their pauses
 * between them (none after the last).
 */
function spread(tokens: readonly string[], from: number, to: number): Span[] {
  const lengths = tokens.map((t) => spokenLength(t) + 1);
  const pauses = tokens.map((t, i) => (i < tokens.length - 1 ? pauseAfter(t) : 0));
  const total = lengths.reduce((a, b) => a + b, 0) + pauses.reduce((a, b) => a + b, 0);
  const unit = total > 0 ? Math.max(0, to - from) / total : 0;
  let t = from;
  return tokens.map((_, i) => {
    const start = t;
    t += lengths[i] * unit;
    const span: Span = [start, i === tokens.length - 1 ? Math.max(from, to) : t];
    t += pauses[i] * unit;
    return span;
  });
}

/**
 * Pair tokens with spans, rounded to the millisecond (props stay small) and
 * forced into order within [0, duration]: each word starts no earlier than
 * the previous one ended.
 */
function finish(tokens: readonly string[], spans: readonly Span[], duration: number): VoiceWord[] {
  const at = (x: number) => Math.min(duration, Math.max(0, Math.round(x * 1000) / 1000));
  let last = 0;
  return tokens.map((text, i) => {
    const start = Math.max(last, at(spans[i][0]));
    const end = Math.max(start, at(spans[i][1]));
    last = end;
    return { text, start, end };
  });
}

const positive = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/**
 * Timings without listening: the clip's length spread over the script's
 * tokens by spoken length (numbers as their words), with a short pause after
 * a comma and a longer one after a full stop, and a sliver of silence at both
 * ends, which is where TTS voices put it (at most 0.12 s before the first word
 * and 0.2 s after the last). Good to a word or so; aligned timings replace it.
 */
export function estimateWords(text: string, durationInSeconds: number): VoiceWord[] {
  const tokens = scriptTokens(text);
  const duration = positive(durationInSeconds) ? durationInSeconds : 0;
  const lead = Math.min(0.12, duration * 0.03);
  const tail = Math.min(0.2, duration * 0.04);
  return finish(tokens, spread(tokens, lead, duration - tail), duration);
}

/**
 * How a token compares with a recognised word. Case, accents and punctuation
 * don't count, which also drops thousands separators ("2,110" ≈ "2110") and
 * lets "Nvidia's" meet "nvidia's"; a lone "&" is the word "and".
 */
export function wordKey(token: string): string {
  const t = token.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  if (t === "&") return "and";
  return t.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The same, for one side spelled as several words on the other: "zortix.com"
 * against "zortix dot com", "S&P" against "S & P". A spoken "dot" and a bare
 * "&" join as nothing.
 */
function joinKey(token: string): string {
  const t = token.toLowerCase();
  return t === "dot" ? "" : wordKey(t === "&" ? "" : t);
}

/**
 * Whether a and b are within `max` edits. The alignment asks this of most
 * token/word pairs, so it gives up as soon as a row of the edit table is all
 * over `max` (most pairs, within a row or two) and reuses its rows.
 */
let rowA = new Int32Array(32);
let rowB = new Int32Array(32);
function withinEdits(a: string, b: string, max: number): boolean {
  if (rowA.length <= b.length) (rowA = new Int32Array(b.length + 1)), (rowB = new Int32Array(b.length + 1));
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      cur[j] = v;
      if (v < low) low = v;
    }
    if (low > max) return false;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] <= max;
}

const EXACT = 2;
const FUZZY = 1;

function pairScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return EXACT;
  // A misheard name ("zortix" heard as "zortex") still marks where it was said. Short words
  // are left out: "in" for "on" is as likely a different word as a mishearing.
  if (Math.min(a.length, b.length) >= 4 && Math.abs(a.length - b.length) <= 2) {
    if (withinEdits(a, b, Math.floor(Math.max(a.length, b.length) / 3))) return FUZZY;
  }
  return 0;
}

/** Keys of each run of `k` items ending at index i-1 (so `joined(keys, k)[i]`), or "" where the run's ends are silent. */
function joined(keys: readonly string[], k: number): string[] {
  return Array.from({ length: keys.length + 1 }, (_, i) =>
    i >= k && keys[i - k] && keys[i - 1] ? keys.slice(i - k, i).join("") : "",
  );
}

// Moves in the alignment table. PAIR matches one token with one word; the
// others match one token with 2 or 3 words, or 2 or 3 tokens with one word.
const SKIP_TOKEN = 1;
const SKIP_HEARD = 2;
const PAIR = 3;
const ONE_TO_2 = 4;
const ONE_TO_3 = 5;
const TWO_TO_1 = 6;
const THREE_TO_1 = 7;

/** Score of a cell no alignment reaches; far enough down that adding matches never lifts it past a real one. */
const UNREACHED = -1_000_000_000;

/** A token whose neighbours left it less than this long is given part of their time instead. */
const MIN_WORD_SECONDS = 0.08;

/**
 * Time the script's tokens from what speech-to-text heard. The two word lists
 * are aligned by dynamic programming (a weighted longest common subsequence
 * over normalised words, allowing one token to match two or three heard words
 * and the reverse), so a dropped word, an extra "uh" or a number written
 * differently only costs that word. Matched tokens take the heard times;
 * the rest are spread between their matched neighbours by length.
 *
 * `matched` counts the tokens timed from what was heard.
 */
export function alignToTranscript(
  text: string,
  heard: readonly SttWord[],
  durationInSeconds?: number,
): { words: VoiceWord[]; matched: number } {
  const tokens = scriptTokens(text);
  const n = tokens.length;
  const m = heard.length;
  const lastHeard = heard.reduce((max, w) => Math.max(max, w.end), 0);
  const duration = positive(durationInSeconds) ? durationInSeconds : lastHeard;

  const keys = tokens.map(wordKey);
  const heardKeys = heard.map((w) => wordKey(w.punctuated_word ?? w.word));
  const tokenJoins = tokens.map(joinKey);
  const heardJoins = heard.map((w) => joinKey(w.punctuated_word ?? w.word));
  const tokens2 = joined(tokenJoins, 2);
  const tokens3 = joined(tokenJoins, 3);
  const heard2 = joined(heardJoins, 2);
  const heard3 = joined(heardJoins, 3);

  // Both lists are the same speech, so the path hugs the diagonal: only cells within `band` of
  // it are filled. The band spans the whole table for lines of a few dozen words, and always
  // leaves room for STT dropping or adding a run as long as the two lists' difference in length.
  const band = 64 + Math.abs(n - m);
  const W = m + 1;
  const score = new Int32Array((n + 1) * W).fill(UNREACHED);
  const move = new Uint8Array((n + 1) * W);
  score[0] = 0;
  for (let i = 0; i <= n; i++) {
    const center = n ? Math.round((i * m) / n) : 0;
    for (let j = Math.max(0, center - band), last = Math.min(m, center + band); j <= last; j++) {
      if (i === 0 && j === 0) continue;
      const at = i * W + j;
      let best = UNREACHED;
      let how = i > 0 ? SKIP_TOKEN : SKIP_HEARD;
      // Matches are tried before skips, so a tie times a token rather than dropping it.
      if (i > 0 && j > 0) {
        const s = pairScore(keys[i - 1], heardKeys[j - 1]);
        if (s && score[at - W - 1] + s > best) (best = score[at - W - 1] + s), (how = PAIR);
        const t = tokenJoins[i - 1];
        if (t && j >= 2 && t === heard2[j] && score[at - W - 2] + EXACT > best) (best = score[at - W - 2] + EXACT), (how = ONE_TO_2);
        if (t && j >= 3 && t === heard3[j] && score[at - W - 3] + EXACT > best) (best = score[at - W - 3] + EXACT), (how = ONE_TO_3);
        const h = heardJoins[j - 1];
        if (h && i >= 2 && h === tokens2[i] && score[at - 2 * W - 1] + EXACT > best) (best = score[at - 2 * W - 1] + EXACT), (how = TWO_TO_1);
        if (h && i >= 3 && h === tokens3[i] && score[at - 3 * W - 1] + EXACT > best) (best = score[at - 3 * W - 1] + EXACT), (how = THREE_TO_1);
      }
      if (i > 0 && score[at - W] > best) (best = score[at - W]), (how = SKIP_TOKEN);
      if (j > 0 && score[at - 1] > best) (best = score[at - 1]), (how = SKIP_HEARD);
      score[at] = best;
      move[at] = how;
    }
  }

  const spans: Array<Span | null> = new Array(n).fill(null);
  let matched = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    // The best path never leaves the band; the fallback only guarantees this walk ends.
    const how = move[i * W + j] || (i > 0 ? SKIP_TOKEN : SKIP_HEARD);
    if (how === SKIP_TOKEN) i--;
    else if (how === SKIP_HEARD) j--;
    else if (how === PAIR || how === ONE_TO_2 || how === ONE_TO_3) {
      const k = how === PAIR ? 1 : how === ONE_TO_2 ? 2 : 3;
      spans[i - 1] = [heard[j - k].start, heard[j - 1].end];
      matched++;
      i--;
      j -= k;
    } else {
      // Several tokens heard as one word ("S & P" as "S&P"): share its time by length.
      const k = how === TWO_TO_1 ? 2 : 3;
      spread(tokens.slice(i - k, i), heard[j - 1].start, heard[j - 1].end).forEach((s, x) => (spans[i - k + x] = s));
      matched += k;
      i -= k;
      j--;
    }
  }

  // Unmatched runs go between their matched neighbours (or the clip's ends).
  for (let i = 0; i < n; ) {
    if (spans[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !spans[j]) j++;
    let a = i;
    let b = j;
    let from = i > 0 ? spans[i - 1]![1] : 0;
    let to = j < n ? spans[j]![0] : duration;
    if (to - from < MIN_WORD_SECONDS * (j - i)) {
      // Heard words often touch, leaving a dropped word no gap to sit in: share the neighbours' time.
      if (i > 0) (a = i - 1), (from = spans[i - 1]![0]);
      if (j < n) (b = j + 1), (to = spans[j]![1]);
    }
    spread(tokens.slice(a, b), from, Math.max(from, to)).forEach((s, x) => (spans[a + x] = s));
    i = j;
  }

  return { words: finish(tokens, spans as Span[], duration), matched };
}

/** Deepgram's pre-recorded speech-to-text, with numbers and punctuation formatted (smart_format). */
export const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en";

export interface AlignWordsOptions {
  /** The clip's measured length; timings are clamped to it. Default: Deepgram's reported duration. */
  durationInSeconds?: number;
  /** Where DEEPGRAM_API_KEY is read. Default process.env. */
  env?: Env;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Give up on Deepgram after this long. Default 60 s. */
  timeoutMs?: number;
}

/**
 * Time a clip's script from the clip itself: send the audio to Deepgram
 * speech-to-text and align what it heard with `text` (alignToTranscript).
 * Throws on an HTTP error, a response without words, or one that matches
 * fewer than half the script's words (probably not this line's audio);
 * voiceNarration falls back to estimateWords then.
 */
export async function alignWords(
  text: string,
  audio: Uint8Array,
  contentType: string,
  opts: AlignWordsOptions = {},
): Promise<VoiceWord[]> {
  const key = (opts.env ?? process.env).DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY is not set.");
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const res = await (opts.fetchImpl ?? fetch)(DEEPGRAM_LISTEN_URL, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": contentType },
    // fetch's types want an ArrayBuffer-backed view, which a Buffer read from disk is; only its own bytes are sent.
    body: audio as Uint8Array<ArrayBuffer>,
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Deepgram STT ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    metadata?: { duration?: number };
    results?: { channels?: Array<{ alternatives?: Array<{ words?: unknown }> }> };
  } | null;
  const words = json?.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(words)) throw new Error("Deepgram STT returned no words.");
  const heard = words.filter(
    (w): w is SttWord =>
      typeof w?.word === "string" && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start,
  );
  if (!heard.length) throw new Error("Deepgram STT heard no words.");
  const duration = positive(opts.durationInSeconds) ? opts.durationInSeconds : json?.metadata?.duration;
  const { words: timed, matched } = alignToTranscript(text, heard, duration);
  const comparable = scriptTokens(text).filter((t) => wordKey(t)).length;
  if (matched < comparable / 2) throw new Error(`Deepgram STT matched only ${matched} of ${comparable} words.`);
  return timed;
}

/** What a clip's `.words.json` holds: an alignment and what it was made from, to tell a stale one. */
interface WordsSidecar {
  text: string;
  bytes: number;
  durationInSeconds: number;
  words: VoiceWord[];
}

/** The sidecar's words if it belongs to exactly this text and clip, else null. */
function validSidecar(json: unknown, tokens: readonly string[], text: string, bytes: number, seconds: number): VoiceWord[] | null {
  const s = json as Partial<WordsSidecar> | null;
  if (!s || s.text !== text || s.bytes !== bytes || s.durationInSeconds !== seconds) return null;
  if (!Array.isArray(s.words) || s.words.length !== tokens.length) return null;
  let last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const w = s.words[i];
    const ok =
      w?.text === tokens[i] &&
      Number.isFinite(w.start) &&
      Number.isFinite(w.end) &&
      w.start >= last &&
      w.end >= w.start &&
      w.end <= seconds;
    if (!ok) return null;
    last = w.end;
  }
  return s.words.map(({ text, start, end }) => ({ text, start, end }));
}

/** Alignments being made right now, by sidecar path: two renders of the same clip pay once. */
const aligning = new Map<string, Promise<VoiceWord[]>>();

export interface ClipWordsOptions {
  /** The clip on disk; its `.words.json` sidecar sits next to it. */
  file: string;
  /** The clip's measured length. */
  seconds: number;
  /** Use a cached alignment (false: always estimate). */
  cached: boolean;
  /** Ask Deepgram when there is no good cached alignment. */
  align: boolean;
  env?: Env;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  warn: (message: string) => void;
}

/**
 * Word timings for one voiced clip: a cached alignment if there is a good
 * one, else a fresh alignment (cached as `<clip>.words.json`, so re-renders
 * don't pay again), else an estimate. Only an abort is thrown: a failed
 * alignment is a warning and an estimate, never a failed render.
 */
export async function wordsForClip(
  text: string,
  opts: ClipWordsOptions,
): Promise<{ words: VoiceWord[]; wordTiming: WordTiming }> {
  const tokens = scriptTokens(text);
  const sidecar = opts.file.replace(/\.[^./\\]+$/, "") + ".words.json";
  if (opts.cached) {
    const bytes = (await stat(opts.file)).size;
    const raw = await readFile(sidecar, "utf8").catch(() => null);
    if (raw !== null) {
      let json: unknown = null;
      try {
        json = JSON.parse(raw);
      } catch {
        // Unreadable: healed below.
      }
      const words = validSidecar(json, tokens, text, bytes, opts.seconds);
      if (words) {
        // Touch on use, like the clip, so a cache sweep by age keeps the pair together.
        const now = new Date();
        await utimes(sidecar, now, now).catch(() => undefined);
        return { words, wordTiming: "aligned" };
      }
      // Truncated, from an older clip of this line, or edited: drop it rather than trust it.
      await rm(sidecar, { force: true }).catch(() => undefined);
    }
  }

  if (opts.align) {
    opts.signal?.throwIfAborted();
    try {
      const words = await alignOnce(sidecar, async () => {
        const audio = await readFile(opts.file);
        const contentType = opts.file.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
        const words = await alignWords(text, audio, contentType, {
          durationInSeconds: opts.seconds,
          env: opts.env,
          fetchImpl: opts.fetchImpl,
          signal: opts.signal,
        });
        const body: WordsSidecar = { text, bytes: audio.length, durationInSeconds: opts.seconds, words };
        // Write then rename, so a reader never sees half a file. Failing to cache only costs a re-alignment later.
        const tmp = `${sidecar}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(body));
          await rename(tmp, sidecar);
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => undefined);
          opts.warn(`could not cache word timings: ${(err as Error).message}`);
        }
        return words;
      }, opts.signal);
      return { words, wordTiming: "aligned" };
    } catch (err) {
      opts.signal?.throwIfAborted();
      opts.warn(`word timings estimated, alignment failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { words: estimateWords(text, opts.seconds), wordTiming: "estimated" };
}

/**
 * Run `align` for `sidecar`, or share a run already in flight. If that one
 * fails (say its render was canceled), look again before starting our own:
 * another waiter may have started the retry already, and every waiter
 * retrying at once would pay Deepgram once each. Waiting on someone else's
 * run still stops the moment our own `signal` aborts; the run goes on for the
 * others.
 */
async function alignOnce(sidecar: string, align: () => Promise<VoiceWord[]>, signal?: AbortSignal): Promise<VoiceWord[]> {
  for (let pending = aligning.get(sidecar); pending; ) {
    const words = await unlessAborted(pending.catch(() => null), signal);
    if (words) {
      signal?.throwIfAborted();
      return words;
    }
    const next = aligning.get(sidecar);
    // The failed run clears itself before its waiters wake; if it somehow hasn't, don't wait on it again.
    pending = next === pending ? undefined : next;
  }
  signal?.throwIfAborted();
  const run = align();
  aligning.set(sidecar, run);
  try {
    return await run;
  } finally {
    if (aligning.get(sidecar) === run) aligning.delete(sidecar);
  }
}

/** `promise`, or a rejection with `signal`'s reason as soon as it aborts, whichever comes first. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
