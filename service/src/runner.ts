import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RenderJob, RenderResult } from "@banfimatei/video-kit/client";
import { renderComposition } from "@banfimatei/video-kit/node";
import { signBody, signPath } from "./auth.js";
import type { Config } from "./config.js";
import { publicJob, RESTARTED, TERMINAL, type AbortReason, type JobStore, type StoredJob } from "./jobs.js";
import { postJson, UnsafeTargetError } from "./net.js";
import { BUILTIN } from "./sites.js";
import { BUILTIN_TEMPLATES } from "./templates.js";

/**
 * The props a job renders with. Submit already cleaned them (props.ts); this
 * repeats the cheap, idempotent part so a job stored by another version of
 * the service can't skip it: no client voiceover, built-in props prepared.
 */
export function renderProps(job: StoredJob): Record<string, unknown> {
  const { voiceover: _dropped, ...props } = job.props ?? {};
  const template = job.site === BUILTIN ? BUILTIN_TEMPLATES[job.composition] : undefined;
  return template ? template.prepare(props) : props;
}

export interface Runner {
  run(id: string, signal: AbortSignal): Promise<void>;
  view(job: StoredJob, position?: number): RenderJob;
  /** Close out a job that never ran (canceled while queued, dropped at shutdown, crashed) and send its webhook. */
  finish(id: string, status: "failed" | "canceled", error: string): void;
  /** Send webhooks still pending from before a restart. */
  redeliver(): number;
  /** Wait, at most `timeoutMs`, for webhooks in flight (for shutdown; undelivered ones stay pending). */
  settle(timeoutMs: number): Promise<void>;
}

const DAY = 86_400_000;
const RETRY_DELAYS = [0, 5_000, 30_000];

export function createRunner(cfg: Config, store: JobStore, log: (msg: string) => void): Runner {
  /**
   * Result URLs are signed fresh on every read, so re-fetching a job renews
   * them, but never past the render's own deletion by retention.
   */
  function view(job: StoredJob, position?: number): RenderJob {
    const out = publicJob(job, position);
    if (job.status !== "done" || !job.result || !job.files) return out;
    const now = Date.now();
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : now;
    const expiresMs = Math.min(now + cfg.URL_TTL_HOURS * 3_600_000, finished + cfg.RETENTION_DAYS * DAY);
    const ttl = Math.max(0, Math.floor((expiresMs - now) / 1000));
    const url = (name: string | undefined) => {
      if (!name) return undefined;
      const p = `/files/${job.id}/${name}`;
      return `${job.publicBase}${p}?${signPath(cfg.signingSecret, p, ttl, now).query}`;
    };
    const result: RenderResult = {
      ...job.result,
      videoUrl: url(job.files.video),
      posterUrl: url(job.files.poster),
      stillUrl: url(job.files.still),
      // The same instant the links' `exp` encodes.
      expiresAt: new Date((Math.floor(now / 1000) + ttl) * 1000).toISOString(),
    };
    return { ...out, result };
  }

  const delivering = new Map<string, Promise<void>>();

  /** At least once: the pending flag is persisted with the terminal status and cleared only after delivery or giving up. */
  function deliver(id: string): void {
    const job = store.get(id);
    if (!job?.webhookUrl || !job.webhookPending || delivering.has(id)) return;
    const target = job.webhookUrl;
    const attempt = (async () => {
      const body = JSON.stringify(view(job));
      const headers = {
        "X-Video-Kit-Signature": signBody(cfg.webhookSecret, body),
        "X-Video-Kit-Job": id,
        "User-Agent": "video-kit",
      };
      for (const delay of RETRY_DELAYS) {
        if (delay) await new Promise((r) => setTimeout(r, delay).unref());
        try {
          const status = await postJson(target, body, headers, { allowPrivate: cfg.ALLOW_PRIVATE_URLS });
          if (status >= 200 && status < 300) break;
          log(`webhook ${id} → ${status}`);
          // A 4xx other than timeout or rate limit won't get better with retries.
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) break;
        } catch (err) {
          log(`webhook ${id} failed: ${(err as Error).message}`);
          // Refused for good (private host, bad scheme); a DNS or network failure gets the next attempt.
          if (err instanceof UnsafeTargetError) break;
        }
      }
      store.update(id, { webhookPending: false });
    })()
      .catch((err: unknown) => log(`webhook ${id} crashed: ${(err as Error).message}`))
      .finally(() => delivering.delete(id));
    delivering.set(id, attempt);
  }

  function finish(id: string, status: "failed" | "canceled", error: string): void {
    const job = store.get(id);
    if (!job || TERMINAL.has(job.status)) return;
    store.update(id, { status, stage: undefined, error, finishedAt: new Date().toISOString() });
    deliver(id);
  }

  function redeliver(): number {
    let n = 0;
    for (const job of store.all()) {
      if (job.webhookPending) {
        deliver(job.id);
        n++;
      }
    }
    return n;
  }

  async function settle(timeoutMs: number): Promise<void> {
    if (!delivering.size) return;
    await Promise.race([
      Promise.all([...delivering.values()]),
      new Promise((r) => setTimeout(r, timeoutMs).unref()),
    ]);
  }

  async function run(id: string, signal: AbortSignal): Promise<void> {
    const job = store.get(id);
    if (!job || job.status !== "queued") return;
    const started = Date.now();
    store.update(id, { status: "running", startedAt: new Date().toISOString(), stage: "starting", progress: 0 });
    const dir = path.join(cfg.rendersDir, id);
    const still = job.kind === "still";
    const timeout = AbortSignal.timeout(cfg.JOB_TIMEOUT_MINUTES * 60_000);
    let lastStage = "";
    let lastTick = 0;
    try {
      if (!existsSync(job.serveDir)) throw new Error(`Site "${job.site}" was deleted before this render started.`);
      await mkdir(dir, { recursive: true });
      const result = await renderComposition({
        serveUrl: job.serveDir,
        compositionId: job.composition,
        inputProps: renderProps(job),
        output: path.join(dir, still ? "still.png" : "video.mp4"),
        still: still ? { frame: job.frame ?? 0 } : undefined,
        poster: still || job.poster === false ? false : { frame: job.poster ?? 60 },
        tts: job.tts,
        voice: { dir: cfg.voiceDir, toSrc: (file) => `${cfg.internalUrl}/internal/voice/${file}` },
        browserExecutable: cfg.REMOTION_BROWSER_EXECUTABLE ?? null,
        maxDurationInSeconds: cfg.MAX_RENDER_SECONDS,
        concurrency: cfg.FRAME_CONCURRENCY ?? null,
        env: cfg.env,
        signal: AbortSignal.any([signal, timeout]),
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
      const reason: AbortReason | "timeout" | null = signal.aborted
        ? signal.reason === "shutdown"
          ? "shutdown"
          : "canceled"
        : timeout.aborted
          ? "timeout"
          : null;
      const message = err instanceof Error ? err.message : String(err);
      const error =
        reason === "canceled"
          ? "Canceled."
          : reason === "shutdown"
            ? RESTARTED
            : reason === "timeout"
              ? `Timed out after ${cfg.JOB_TIMEOUT_MINUTES} minutes.`
              : message.slice(0, 2000);
      store.update(id, {
        status: reason === "canceled" ? "canceled" : "failed",
        stage: undefined,
        error,
        finishedAt: new Date().toISOString(),
      });
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      log(`render ${id} ${reason ?? `failed: ${message.split("\n")[0]}`}`);
    }
    deliver(id);
  }

  return { run, view, finish, redeliver, settle };
}
