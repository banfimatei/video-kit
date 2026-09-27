import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signPath, verifySignedPath } from "../src/auth.js";
import { loadConfig, type Config } from "../src/config.js";
import { JobStore, RenderQueue } from "../src/jobs.js";
import { createRunner } from "../src/runner.js";
import { createApp } from "../src/server.js";
import { Sites } from "../src/sites.js";

const KEY = "test-key-0123456789abcdef";
const auth = { Authorization: `Bearer ${KEY}` };

/** A raw tar entry, so tests can build archives node-tar itself would refuse to write. */
function entry(p: string, body: string, type: "File" | "SymbolicLink" = "File", linkpath?: string): Buffer {
  const data = Buffer.from(body);
  const header = new tar.Header({ path: p, mode: 0o644, size: type === "File" ? data.length : 0, type, linkpath, mtime: new Date(0) });
  header.encode();
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header.block!, ...(type === "File" ? [data, Buffer.alloc(pad)] : [])]);
}
const tgz = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

let dir: string;
let cfg: Config;
let store: JobStore;
let app: ReturnType<typeof createApp>;
let queue: RenderQueue;
let ran: string[];

async function setup(extraEnv: Record<string, string> = {}, run?: (id: string, signal: AbortSignal) => Promise<void>) {
  dir = mkdtempSync(path.join(os.tmpdir(), "vk-svc-"));
  const bundle = path.join(dir, "bundle");
  mkdirSync(bundle);
  writeFileSync(path.join(bundle, "index.html"), "<html></html>");
  cfg = loadConfig({ RENDER_API_KEY: KEY, DATA_DIR: path.join(dir, "data"), BUILTIN_BUNDLE_DIR: bundle, PORT: "8799", ...extraEnv });
  store = new JobStore(cfg.jobsDir);
  await store.init();
  const fakeComps = async () => [{ id: "Story", width: 1080, height: 1920, fps: 30, durationInFrames: 300, defaultProps: {} }];
  const sites = new Sites(cfg, fakeComps);
  await sites.init();
  const runner = createRunner(cfg, store, () => undefined);
  ran = [];
  queue = new RenderQueue(1, cfg.MAX_QUEUE, run ?? (async (id) => void ran.push(id)));
  app = createApp({ cfg, store, queue, sites, runner, version: "test" });
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Call the app as if from `remote` (the node-server binding the voice route checks). */
const call = (p: string, init: RequestInit = {}, remote = "203.0.113.9") =>
  app.request(p, init, { incoming: { socket: { remoteAddress: remote } } } as never);

describe("auth", () => {
  beforeEach(() => setup());
  it("leaves /healthz open and closes /v1 without the key", async () => {
    expect((await call("/healthz")).status).toBe(200);
    expect((await call("/v1/templates")).status).toBe(401);
    expect((await call("/v1/templates", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call("/v1/templates", { headers: auth })).status).toBe(200);
  });
});

describe("POST /v1/renders", () => {
  const post = (body: unknown) => call("/v1/renders", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("validates built-in props up front and names the bad field", async () => {
    await setup();
    const res = await post({ composition: "Story", props: { scenes: [] } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("props.scenes");
  });

  it("404s an unknown site or composition, and 400s a non-http webhook", async () => {
    await setup();
    expect((await post({ site: "nope", composition: "Story" })).status).toBe(404);
    expect((await post({ composition: "Nope" })).status).toBe(404);
    expect((await post({ composition: "Story", props: { scenes: [{ title: "x" }] }, webhookUrl: "file:///etc/passwd" })).status).toBe(400);
  });

  it("queues a valid render, then 429s when the queue is full", async () => {
    await setup({ MAX_QUEUE: "1" }, () => new Promise(() => undefined)); // the first render never finishes
    const ok = { composition: "Story", props: { scenes: [{ title: "Hello" }] } };
    expect((await post(ok)).status).toBe(202); // running
    expect((await post(ok)).status).toBe(202); // queued
    const full = await post(ok);
    expect(full.status).toBe(429);
  });

  it("cancels a queued render", async () => {
    await setup({}, () => new Promise(() => undefined));
    const ok = { composition: "Story", props: { scenes: [{ title: "Hello" }] } };
    await post(ok);
    const queued = await (await post(ok)).json();
    expect(queued.status).toBe("queued");
    expect(queued.position).toBe(0);
    const res = await call(`/v1/renders/${queued.id}`, { method: "DELETE", headers: auth });
    expect((await res.json()).status).toBe("canceled");
  });

  it("never returns props or internal paths", async () => {
    await setup();
    const job = await (await post({ composition: "Story", props: { scenes: [{ title: "secret-ish" }] } })).json();
    expect(JSON.stringify(job)).not.toContain("secret-ish");
    expect(job).not.toHaveProperty("serveDir");
  });
});

describe("sites", () => {
  beforeEach(() => setup());
  const put = (name: string, body: Buffer) =>
    // Buffer is a valid body at runtime; the DOM types just predate it.
    call(`/v1/sites/${name}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/gzip" }, body: new Uint8Array(body) });

  it("deploys a bundle and lists it", async () => {
    const res = await put("layway", tgz(entry("index.html", "<html/>"), entry("bundle.js", "1")));
    expect(res.status).toBe(201);
    expect((await res.json()).compositions).toEqual(["Story"]);
    const list = await (await call("/v1/sites", { headers: auth })).json();
    expect(list.sites.map((s: { name: string }) => s.name)).toEqual(["layway"]);
  });

  it("rejects bad names and the reserved builtin", async () => {
    expect((await put("Bad_Name", tgz(entry("index.html", "x")))).status).toBe(400);
    expect((await put("builtin", tgz(entry("index.html", "x")))).status).toBe(400);
  });

  it("refuses path traversal and never writes outside the site", async () => {
    const res = await put("evil", tgz(entry("index.html", "x"), entry("../../escaped.txt", "pwned")));
    expect(res.status).toBe(400);
    expect(existsSync(path.join(cfg.sitesDir, "escaped.txt"))).toBe(false);
    expect(existsSync(path.join(cfg.dataDir, "escaped.txt"))).toBe(false);
    expect(existsSync(path.join(dir, "escaped.txt"))).toBe(false);
  });

  it("skips symlinks instead of following them", async () => {
    const res = await put("links", tgz(entry("index.html", "x"), entry("passwd", "", "SymbolicLink", "/etc/passwd")));
    expect(res.status).toBe(201);
    const meta = JSON.parse(readFileSync(path.join(cfg.sitesDir, "links", "meta.json"), "utf8"));
    expect(existsSync(path.join(cfg.sitesDir, "links", meta.current, "passwd"))).toBe(false);
  });

  it("requires index.html and a readable archive", async () => {
    expect((await put("nohtml", tgz(entry("bundle.js", "1")))).status).toBe(400);
    expect((await put("garbage", Buffer.from("not a tarball"))).status).toBe(400);
  });

  it("enforces MAX_SITE_MB while streaming", async () => {
    rmSync(dir, { recursive: true, force: true });
    await setup({ MAX_SITE_MB: "0.001" });
    const big = tgz(entry("index.html", "x"), entry("big.bin", "y".repeat(5000)), entry("noise.bin", Math.random().toString(36).repeat(400)));
    expect((await put("big", big)).status).toBe(413);
  });
});

describe("voice clips and render files", () => {
  beforeEach(() => setup());

  it("serves voice clips to loopback only, with CORS", async () => {
    mkdirSync(cfg.voiceDir, { recursive: true });
    const name = "0123456789abcdef01234567.wav";
    writeFileSync(path.join(cfg.voiceDir, name), "RIFF");
    expect((await call(`/internal/voice/${name}`)).status).toBe(404);
    const local = await call(`/internal/voice/${name}`, {}, "127.0.0.1");
    expect(local.status).toBe(200);
    expect(local.headers.get("access-control-allow-origin")).toBe("*");
    expect((await call("/internal/voice/..%2Fjobs", {}, "127.0.0.1")).status).toBe(404);
  });

  it("signs file paths and rejects tampering, other paths and expiry", () => {
    const now = Date.now();
    const { exp, query } = signPath("secret-secret-secret", "/files/a/video.mp4", 60, now);
    const sig = new URLSearchParams(query).get("sig")!;
    expect(verifySignedPath("secret-secret-secret", "/files/a/video.mp4", String(exp), sig, now)).toBe(true);
    expect(verifySignedPath("secret-secret-secret", "/files/b/video.mp4", String(exp), sig, now)).toBe(false);
    expect(verifySignedPath("other-secret-secret", "/files/a/video.mp4", String(exp), sig, now)).toBe(false);
    expect(verifySignedPath("secret-secret-secret", "/files/a/video.mp4", String(exp), sig, now + 61_000)).toBe(false);
    expect(verifySignedPath("secret-secret-secret", "/files/a/video.mp4", "abc", sig, now)).toBe(false);
  });

  it("403s a file without a valid signature or key", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await call(`/files/${id}/video.mp4`)).status).toBe(403);
    expect((await call(`/files/${id}/video.mp4?exp=9999999999&sig=nope`)).status).toBe(403);
  });
});

describe("restart", () => {
  it("marks renders that were queued or running as failed on boot", async () => {
    await setup({}, () => new Promise(() => undefined));
    const post = (b: unknown) => call("/v1/renders", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const a = await (await post({ composition: "Story", props: { scenes: [{ title: "a" }] } })).json();
    await store.persist(store.get(a.id)!);
    const fresh = new JobStore(cfg.jobsDir);
    expect(await fresh.init()).toBe(1);
    expect(fresh.get(a.id)?.status).toBe("failed");
    expect(fresh.get(a.id)?.error).toMatch(/restarted/);
  });
});
