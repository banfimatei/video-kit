import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RenderJob, RenderResult } from "@banfimatei/video-kit/client";
import { renderComposition } from "@banfimatei/video-kit/node";
import { signBody, signPath } from "./auth.js";
import type { Config } from "./config.js";
import { publicJob, type JobStore, type StoredJob } from "./jobs.js";
import { BUILTIN } from "./sites.js";
import { BUILTIN_TEMPLATES } from "./templates.js";

export interface Runner {
  run(id: string, signal: AbortSignal): Promise<void>;
  view(job: StoredJob, position?: number): RenderJob;
}

export function createRunner(cfg: Config, store: JobStore, log: (msg: string) => void): Runner {
  /** Result URLs are signed fresh on every read, so re-fetching a job renews them. */
  function view(job: StoredJob, position?: number): RenderJob {
    const out = publicJob(job, position);
    if (job.status !== "done" || !job.result || !job.files) return out;
    const ttl = Math.min(cfg.URL_TTL_HOURS * 3600, cfg.RETENTION_DAYS * 86400);
    const url = (name: string | undefined) => {
      if (!name) return undefined;
      const p = `/files/${job.id}/${name}`;
      return `${job.publicBase}${p}?${signPath(cfg.signingSecret, p, ttl).query}`;
    };
    const result: RenderResult = {
      ...job.result,
      videoUrl: url(job.files.video),
      posterUrl: url(job.files.poster),
      stillUrl: url(job.files.still),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
    return { ...out, result };
  }

  async function webhook(job: StoredJob): Promise<void> {
    if (!job.webhookUrl) return;
    const body = JSON.stringify(view(job));
    for (const delay of [0, 5_000, 30_000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await fetch(job.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Video-Kit-Signature": signBody(cfg.signingSecret, body) },
          body,
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        });
        if (res.ok) return;
        log(`webhook ${job.id} → ${res.status}`);
      } catch (err) {
        log(`webhook ${job.id} failed: ${(err as Error).message}`);
      }
    }
  }

  async function run(id: string, signal: AbortSignal): Promise<void> {
    const job = store.get(id);
    if (!job || job.status !== "queued") return;
    const started = Date.now();
    store.update(id, { status: "running", startedAt: new Date().toISOString(), stage: "starting", progress: 0 });
    const dir = path.join(cfg.rendersDir, id);
    await mkdir(dir, { recursive: true });
    const still = job.kind === "still";
    let lastStage = "";
    let lastTick = 0;
    try {
      const props = job.site === BUILTIN && BUILTIN_TEMPLATES[job.composition]
        ? BUILTIN_TEMPLATES[job.composition].prepare(job.props)
        : job.props;
      const result = await renderComposition({
        serveUrl: job.serveDir,
        compositionId: job.composition,
        inputProps: props,
        output: path.join(dir, still ? "still.png" : "video.mp4"),
        still: still ? { frame: job.frame ?? 0 } : undefined,
        poster: still || job.poster === false ? false : { frame: job.poster ?? 60 },
        tts: job.tts,
        voice: { dir: cfg.voiceDir, toSrc: (file) => `${cfg.internalUrl}/internal/voice/${file}` },
        browserExecutable: cfg.REMOTION_BROWSER_EXECUTABLE ?? null,
        maxDurationInSeconds: cfg.MAX_RENDER_SECONDS,
        concurrency: cfg.FRAME_CONCURRENCY ?? null,
        env: cfg.env,
        signal,
        onProgress: (stage, progress) => {
          const now = Date.now();
          // Persist on each stage change; progress ticks only update memory (polls read memory).
          if (stage !== lastStage) {
            lastStage = stage;
            store.update(id, { stage, progress });
          } else if (now - lastTick > 250) {
            lastTick = now;
            store.update(id, { progress }, false);
          }
        },
      });
      store.update(id, {
        status: "done",
        stage: undefined,
        progress: 1,
        finishedAt: new Date().toISOString(),
        files: still ? { still: "still.png" } : { video: "video.mp4", poster: result.poster ? "video.poster.png" : undefined },
        result: {
          width: result.width,
          height: result.height,
          fps: result.fps,
          durationInSeconds: result.durationInSeconds,
          voice: result.voice,
          expiresAt: "",
        },
      });
      log(`render ${id} ${job.site}/${job.composition} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      const canceled = signal.aborted;
      const message = (err as Error).message ?? String(err);
      store.update(id, {
        status: canceled ? "canceled" : "failed",
        error: canceled ? "Canceled." : message.slice(0, 2000),
        finishedAt: new Date().toISOString(),
      });
      await rm(dir, { recursive: true, force: true });
      log(`render ${id} ${canceled ? "canceled" : `failed: ${message.split("\n")[0]}`}`);
    }
    const final = store.get(id);
    if (final) void webhook(final);
  }

  return { run, view };
}
