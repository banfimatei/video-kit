import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { JobStore, RenderQueue } from "../src/jobs.js";
import { createRunner, type Runner } from "../src/runner.js";
import { createApp } from "../src/server.js";
import { Sites } from "../src/sites.js";

export const KEY = "test-key-0123456789abcdef";
export const auth = { Authorization: `Bearer ${KEY}` };
export const STORY = { composition: "Story", props: { scenes: [{ title: "Hello" }] } };

/** A raw tar entry, so tests can build archives node-tar itself would refuse to write. */
export function entry(p: string, body: string, type: "File" | "SymbolicLink" = "File", linkpath?: string): Buffer {
  const data = Buffer.from(body);
  const header = new tar.Header({ path: p, mode: 0o644, size: type === "File" ? data.length : 0, type, linkpath, mtime: new Date(0) });
  header.encode();
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header.block!, ...(type === "File" ? [data, Buffer.alloc(pad)] : [])]);
}
export const tgz = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
export const never = () => new Promise<void>(() => undefined);

export interface Ctx {
  dir: string;
  cfg: Config;
  store: JobStore;
  sites: Sites;
  runner: Runner;
  queue: RenderQueue;
  app: ReturnType<typeof createApp>;
  ran: string[];
  logs: string[];
  /** Peak number of listCompositions calls running at once (site deploys). */
  compositionsPeak: () => number;
  call: (p: string, init?: RequestInit, remote?: string) => Promise<Response>;
  post: (body: unknown) => Promise<Response>;
  put: (name: string, body: Buffer) => Promise<Response>;
}

const dirs: string[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  // Let fire-and-forget job writes land before the directory goes.
  await Promise.all(stores.splice(0).map((s) => s.flush()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

export async function setup(
  extraEnv: Record<string, string> = {},
  run?: (id: string, signal: AbortSignal) => Promise<void>,
  opts: { dir?: string; compositionsDelayMs?: number } = {},
): Promise<Ctx> {
  const dir = opts.dir ?? mkdtempSync(path.join(os.tmpdir(), "vk-svc-"));
  if (!opts.dir) dirs.push(dir);
  const bundle = path.join(dir, "bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, "index.html"), "<html></html>");
  const cfg = loadConfig({ RENDER_API_KEY: KEY, DATA_DIR: path.join(dir, "data"), BUILTIN_BUNDLE_DIR: bundle, PORT: "8799", ...extraEnv });
  const store = new JobStore(cfg.jobsDir);
  stores.push(store);
  await store.init();
  let active = 0;
  let peak = 0;
  const fakeComps = async () => {
    active++;
    peak = Math.max(peak, active);
    if (opts.compositionsDelayMs) await new Promise((r) => setTimeout(r, opts.compositionsDelayMs));
    active--;
    return [{ id: "Story", width: 1080, height: 1920, fps: 30, durationInFrames: 300, defaultProps: {} }];
  };
  const sites = new Sites(cfg, fakeComps);
  await sites.init();
  const logs: string[] = [];
  const runner = createRunner(cfg, store, (m) => void logs.push(m));
  const ran: string[] = [];
  const queue = new RenderQueue(1, cfg.MAX_QUEUE, run ?? (async (id) => void ran.push(id)), (id) =>
    runner.finish(id, "failed", "The render crashed inside the service."),
  );
  const app = createApp({ cfg, store, queue, sites, runner, version: "test" });
  /** Call the app as if from `remote` (the node-server binding the voice route checks). */
  const call = (p: string, init: RequestInit = {}, remote = "203.0.113.9") =>
    Promise.resolve(app.request(p, init, { incoming: { socket: { remoteAddress: remote } } } as never));
  const post = (body: unknown) =>
    call("/v1/renders", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // Buffer is a valid body at runtime; the DOM types just predate it.
  const put = (name: string, body: Buffer) =>
    call(`/v1/sites/${name}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/gzip" }, body: new Uint8Array(body) });
  return { dir, cfg, store, sites, runner, queue, app, ran, logs, compositionsPeak: () => peak, call, post, put };
}
