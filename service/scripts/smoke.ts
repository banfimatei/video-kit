/**
 * End-to-end check against a running service, through the client:
 * render a two-scene Story (voiced when a provider is available), wait,
 * download, and check what came back.
 *
 *   VIDEO_KIT_URL=http://localhost:8080 VIDEO_KIT_API_KEY=… npm run smoke --workspace service
 *   SMOKE_TTS=espeak …   # force the offline voice
 */
import { writeFileSync } from "node:fs";
import { createVideoKitClient } from "@banfimatei/video-kit/client";

const baseUrl = process.env.VIDEO_KIT_URL ?? "http://localhost:8080";
const apiKey = process.env.VIDEO_KIT_API_KEY;
if (!apiKey) throw new Error("Set VIDEO_KIT_API_KEY.");
const kit = createVideoKitClient({ baseUrl, apiKey });

const health = await kit.health();
console.error(`service ${health.version} is up`);
const templates = await kit.templates();
if (!templates.some((t) => t.id === "Story")) throw new Error("Story template missing");

const job = await kit.renderAndWait(
  {
    composition: "Story",
    tts: process.env.SMOKE_TTS,
    props: {
      aspect: "9:16",
      brand: { name: "video-kit", url: "smoke test" },
      footer: "Smoke test render.",
      scenes: [
        { kicker: "Smoke", title: "The service renders", narration: "The service renders." },
        { title: "And hands back a link", body: "Signed, time-limited." },
      ],
    },
  },
  { intervalMs: 1000, onProgress: (j) => process.stderr.write(`\r${j.status} ${j.stage ?? ""} ${Math.round(j.progress * 100)}%   `) },
);
const bytes = await kit.download(job);
const out = process.env.SMOKE_OUT ?? "smoke.mp4";
writeFileSync(out, bytes);
console.error(`\nwrote ${out}: ${bytes.length} bytes, ${job.result?.durationInSeconds.toFixed(1)}s, voice ${job.result?.voice ?? "none"}`);
if (bytes.length < 20_000) throw new Error("Video suspiciously small");
if (process.env.SMOKE_TTS && process.env.SMOKE_TTS !== "none" && job.result?.voice !== process.env.SMOKE_TTS) {
  throw new Error(`Expected voice ${process.env.SMOKE_TTS}, got ${job.result?.voice}`);
}
