import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RenderJob, RenderKind, RenderRequest } from "@banfimatei/video-kit/client";

/** What the service keeps per job: the public job plus what it needs to run it. */
export interface StoredJob extends RenderJob {
  /** Dropped once the job is terminal: nothing reads them after the render, and they can be large. */
  props?: Record<string, unknown>;
  tts?: string;
  ttsOptions?: { model?: string; voice?: string };
  frame?: number;
  poster?: number | false;
  webhookUrl?: string;
  /** Site version directory captured at submit time, so a redeploy can't swap files mid-render. */
  serveDir: string;
  /** Origin the job's file URLs are built on. */
  publicBase: string;
  /** Files written for this job, relative to its render dir. */
  files?: { video?: string; poster?: string; still?: string };
  /** A terminal job whose webhook hasn't been delivered yet (survives restarts). */
  webhookPending?: boolean;
}

export const TERMINAL = new Set(["done", "failed", "canceled"]);

export const RESTARTED = "The service restarted before this render finished. Submit it again.";

export class JobStore {
  private jobs = new Map<string, StoredJob>();
  private writes = new Map<string, Promise<void>>();

  constructor(private dir: string) {}

  /**
   * Load every job. Renders that were running when the process stopped are
   * marked failed (they can't resume); renders still waiting never started,
   * so they are returned, oldest first, to be queued again.
   */
  async init(): Promise<{ interrupted: number; queued: string[] }> {
    await mkdir(this.dir, { recursive: true });
    let interrupted = 0;
    const queued: StoredJob[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as StoredJob;
        if (typeof job.id !== "string" || `${job.id}.json` !== name) continue;
        // In the map first: persist() skips jobs it doesn't know.
        this.jobs.set(job.id, job);
        if (job.status === "queued") {
          queued.push(job);
        } else if (!TERMINAL.has(job.status)) {
          interrupted++;
          this.update(job.id, { status: "failed", stage: undefined, error: RESTARTED, finishedAt: new Date().toISOString() }, false);
          await this.persist(job);
        } else if (job.props) {
          delete job.props;
          await this.persist(job);
        }
      } catch {
        // A torn or foreign file: ignore it rather than refuse to boot.
      }
    }
    queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { interrupted, queued: queued.map((j) => j.id) };
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
      ttsOptions: req.ttsOptions,
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

  /**
   * Apply a change and persist it. Progress ticks are frequent; persist is
   * serialized per job. Reaching a terminal status drops the props and, if
   * the job has a webhook, marks it pending until delivered.
   */
  update(id: string, change: Partial<StoredJob>, persist = true): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const wasTerminal = TERMINAL.has(job.status);
    Object.assign(job, change);
    if (!wasTerminal && TERMINAL.has(job.status)) {
      delete job.props;
      if (job.webhookUrl) job.webhookPending = true;
    }
    if (persist) void this.persist(job);
    return job;
  }

  /** Resolves once every write started so far has landed (for shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()]);
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
  const {
    props: _p,
    tts: _t,
    ttsOptions: _to,
    frame: _f,
    poster: _po,
    webhookUrl: _w,
    webhookPending: _wp,
    serveDir: _s,
    publicBase: _b,
    files: _fi,
    ...rest
  } = job;
  return position === undefined ? rest : { ...rest, position };
}

/** Why a running render was aborted; the runner records a different outcome for each. */
export type AbortReason = "canceled" | "shutdown";

/**
 * FIFO queue with a fixed number of workers. `run` does the work for one job;
 * `cancel` drops a queued job or aborts a running one. `onCrash` hears about
 * a `run` that rejected (it shouldn't), so the job can still be closed out.
 */
export class RenderQueue {
  private waiting: string[] = [];
  private running = new Map<string, AbortController>();
  private paused = false;

  constructor(
    private concurrency: number,
    private maxQueued: number,
    private run: (id: string, signal: AbortSignal) => Promise<void>,
    private onCrash: (id: string, err: unknown) => void = () => undefined,
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

  /** Where the job was: dropped from the queue, aborted while running, or not here at all. */
  cancel(id: string): "queued" | "running" | null {
    const i = this.waiting.indexOf(id);
    if (i !== -1) {
      this.waiting.splice(i, 1);
      return "queued";
    }
    const ctl = this.running.get(id);
    if (ctl) {
      ctl.abort("canceled" satisfies AbortReason);
      return "running";
    }
    return null;
  }

  /** Start nothing new (shutdown); waiting jobs stay queued, on disk too. */
  pause(): void {
    this.paused = true;
  }

  /** Abort every running render. */
  abortRunning(reason: AbortReason): void {
    for (const ctl of this.running.values()) ctl.abort(reason);
  }

  /** Resolves once nothing is running, or after `timeoutMs` (for shutdown). */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  private pump(): void {
    while (!this.paused && this.running.size < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift()!;
      const ctl = new AbortController();
      this.running.set(id, ctl);
      this.run(id, ctl.signal)
        .catch((err: unknown) => {
          try {
            this.onCrash(id, err);
          } catch {
            // never let bookkeeping take the worker down
          }
        })
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
  }
}
