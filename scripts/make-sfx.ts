/**
 * Synthesize the house sound effects into assets/sfx/*.wav.
 *
 *   npm run sfx:make
 *
 * Quiet, printed-page cues for a broadsheet brand: a type tick, a paper
 * whoosh, a low landing thud, a two-note chime, a riser and a page flick.
 * Generated from code, so they are ours (no licence to track), identical on
 * every run (seeded noise), and need no network at render time. The WAVs are
 * committed; rerun this only after changing a recipe here.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RATE = 44100;
const OUT = path.resolve(import.meta.dirname, "../assets/sfx");

/** Seeded PRNG (mulberry32) so the noise, and so the files, never change. */
function noise(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function render(seconds: number, sample: (t: number, i: number) => number): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = sample(i / RATE, i);
  // Short fade at both ends so no cue starts or stops with a click.
  const edge = Math.min(n >> 1, Math.round(0.003 * RATE));
  for (let i = 0; i < edge; i++) {
    out[i] *= i / edge;
    out[n - 1 - i] *= i / edge;
  }
  return out;
}

/** One-pole low-pass, in place: `cutoff(t)` in Hz may move over time. */
function lowpass(x: Float32Array, cutoff: (t: number) => number): Float32Array {
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const k = 1 - Math.exp((-2 * Math.PI * cutoff(i / RATE)) / RATE);
    y += k * (x[i] - y);
    x[i] = y;
  }
  return x;
}

function highpass(x: Float32Array, hz: number): Float32Array {
  const lp = lowpass(Float32Array.from(x), () => hz);
  for (let i = 0; i < x.length; i++) x[i] -= lp[i];
  return x;
}

function normalize(x: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / max;
  return x;
}

function wav(x: Float32Array): Buffer {
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + x.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(x.length * 2, 40);
  x.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

const TAU = 2 * Math.PI;

const recipes: Record<string, () => Float32Array> = {
  // A typewriter-light tick for a row or a word landing.
  tick: () => {
    const n = noise(1);
    return normalize(
      render(0.06, (t) => (Math.sin(TAU * 1850 * t) * 0.7 + n() * 0.3) * Math.exp(-t * 90)),
      0.8,
    );
  },
  // Paper moving past: band-limited noise swelling and falling away.
  whoosh: () => {
    const n = noise(2);
    const d = 0.5;
    const x = render(d, (t) => n() * Math.sin((Math.PI * t) / d) ** 2);
    return normalize(highpass(lowpass(x, (t) => 700 + 3200 * Math.sin((Math.PI * t) / d)), 250), 0.7);
  },
  // Something heavy set down: a falling low sine under a soft click.
  thud: () => {
    const n = noise(3);
    let phase = 0;
    return normalize(
      render(0.4, (t) => {
        phase += (TAU * (48 + 40 * Math.exp(-t * 18))) / RATE;
        return Math.sin(phase) * Math.exp(-t * 11) + n() * 0.15 * Math.exp(-t * 120);
      }),
      0.85,
    );
  },
  // Two bell partials a fifth apart, for the sign-off.
  chime: () =>
    normalize(
      render(1.4, (t) => {
        const env = Math.exp(-t * 3.2) * Math.min(1, t * 400);
        return (
          env *
          (Math.sin(TAU * 880 * t) +
            0.5 * Math.sin(TAU * 1320 * t) +
            0.18 * Math.sin(TAU * 2640 * t) * Math.exp(-t * 6))
        );
      }),
      0.6,
    ),
  // A rising filtered swell into a reveal.
  riser: () => {
    const n = noise(5);
    const d = 1.2;
    let phase = 0;
    const x = render(d, (t) => {
      phase += (TAU * (180 + 520 * (t / d) ** 2)) / RATE;
      return ((t / d) ** 2) * (n() * 0.6 + Math.sin(phase) * 0.4);
    });
    return normalize(lowpass(x, (t) => 400 + 5000 * (t / d) ** 2), 0.65);
  },
  // A single page flicked over: a short bright burst with a papery tail.
  page: () => {
    const n = noise(6);
    const x = render(0.28, (t) => n() * (Math.exp(-t * 28) * 0.9 + Math.exp(-((t - 0.07) ** 2) / 0.0006) * 0.6));
    return normalize(highpass(x, 1200), 0.6);
  },
};

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(recipes)) {
  const file = path.join(OUT, `${name}.wav`);
  writeFileSync(file, wav(make()));
  console.error(`Wrote ${path.relative(process.cwd(), file)}`);
}
