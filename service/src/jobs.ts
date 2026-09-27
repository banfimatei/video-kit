import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RenderJob, RenderKind, RenderRequest } from "@banfimatei/video-kit/client";

/** What the service keeps per job: the public job plus what it needs to run it. */
export interface StoredJob extends RenderJob {
  props: Record<string, unknown>;
  tts?: string;
  frame?: number;
  poster?: number | false;
  webhookUrl?: string;
  /** Site version directory captured at submit time, so a redeploy can't swap files mid-render. */
  serveDir: string;
  /** Origin the job's file URLs are built on. */
  publicBase: string;
  /** Files written for this job, relative to its render dir. */
  files?: { video?: string; poster?: string; still?: string };
}

export const TERMINAL = new Set(["done", "failed", "canceled"]);

export class JobStore {
  private jobs = new Map<string, StoredJob>();
  private writes = new Map<string, Promise<void>>();

  constructor(private dir: string) {}

  /** Load every job; any that were queued or running when the process died are marked failed. */
  async init(): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    let interrupted = 0;
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as StoredJob;
        if (!TERMINAL.has(job.status)) {
          job.status = "failed";
          job.error = "The service restarted before this render finished. Submit it again.";
          job.finishedAt = new Date().toISOString();
          interrupted++;
          await this.persist(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        // A torn or foreign file: ignore it rather than refuse to boot.
      }
    }
    return interrupted;
  }

  create(req: RenderRequest & { site: string; kind: RenderKind }, extra: Pick<StoredJob, "serveDir" | "publicBase">): StoredJob {
    const job: StoredJob = {
      id: randomUUID(),
      status: "queued",
      progress: 0,
      site: req.site,
      composition: req.composition,
      kind: req.kind,
      createdAt: new Date().toISOString(),
      props: req.props ?? {},
      tts: req.tts,
      frame: req.frame,
      poster: req.poster,
      webhookUrl: req.webhookUrl,
      ...extra,
    };
    this.jobs.set(job.id, job);
    void this.persist(job);
    return job;
  }

  get(id: string): StoredJob | undefined {
    return this.jobs.get(id);
  }

  list(limit = 50): StoredJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  all(): StoredJob[] {
    return [...this.jobs.values()];
  }

  /** Apply a change and persist it. Progress ticks are frequent; persist is serialized per job. */
  update(id: string, change: Partial<StoredJob>, persist = true): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    Object.assign(job, change);
    if (persist) void this.persist(job);
    return job;
  }

  async remove(id: string): Promise<void> {
    this.jobs.delete(id);
    await this.writes.get(id);
    await rm(path.join(this.dir, `${id}.json`), { force: true });
  }

  /**
   * Atomic write (tmp + rename), chained per job so writes land in order.
   * Never rejects: callers fire and forget, and an unhandled rejection would
   * kill the process, so a failed write is logged and the in-memory job stays
   * authoritative.
   */
  persist(job: StoredJob): Promise<void> {
    const prev = this.writes.get(job.id) ?? Promise.resolve();
    const next: Promise<void> = prev.then(async () => {
      if (!this.jobs.has(job.id)) return;
      const file = path.join(this.dir, `${job.id}.json`);
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(job));
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        console.error(`[video-kit] could not save job ${job.id}: ${(err as Error).message}`);
      }
    });
    this.writes.set(job.id, next);
    void next.then(() => {
      if (this.writes.get(job.id) === next) this.writes.delete(job.id);
    });
    return next;
  }
}

/** Public view of a job: no props, no internal paths. */
export function publicJob(job: StoredJob, position?: number): RenderJob {
  const { props: _p, tts: _t, frame: _f, poster: _po, webhookUrl: _w, serveDir: _s, publicBase: _b, files: _fi, ...rest } = job;
  return position === undefined ? rest : { ...rest, position };
}

/**
 * FIFO queue with a fixed number of workers. `run` does the work for one job;
 * `cancel` drops a queued job or aborts a running one.
 */
export class RenderQueue {
  private waiting: string[] = [];
  private running = new Map<string, AbortController>();

  constructor(
    private concurrency: number,
    private maxQueued: number,
    private run: (id: string, signal: AbortSignal) => Promise<void>,
  ) {}

  get size() {
    return { queued: this.waiting.length, running: this.running.size };
  }

  isFull(): boolean {
    return this.waiting.length >= this.maxQueued;
  }

  position(id: string): number | undefined {
    const i = this.waiting.indexOf(id);
    return i === -1 ? undefined : i;
  }

  push(id: string): void {
    this.waiting.push(id);
    this.pump();
  }

  /** True if the job was queued or running here. */
  cancel(id: string): boolean {
    const i = this.waiting.indexOf(id);
    if (i !== -1) {
      this.waiting.splice(i, 1);
      return true;
    }
    const ctl = this.running.get(id);
    if (ctl) {
      ctl.abort();
      return true;
    }
    return false;
  }

  abortAll(): void {
    this.waiting = [];
    for (const ctl of this.running.values()) ctl.abort();
  }

  /** Resolves once nothing is running (after abortAll, for shutdown). */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift()!;
      const ctl = new AbortController();
      this.running.set(id, ctl);
      this.run(id, ctl.signal)
        .catch(() => undefined)
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
  }
}
