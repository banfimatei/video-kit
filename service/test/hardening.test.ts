import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { verifyWebhook, webhookSecretFromApiKey } from "@banfimatei/video-kit/client";
import { afterEach, describe, expect, it } from "vitest";
import { prepareStoryProps } from "../remotion/templates/story/schema.js";
import { signBody, signPath, verifySignedPath } from "../src/auth.js";
import { contentDisposition } from "../src/files.js";
import { JobStore, RESTARTED, type StoredJob } from "../src/jobs.js";
import { isPrivateAddress } from "../src/net.js";
import { sweep } from "../src/retention.js";
import { auth, entry, KEY, never, setup, STORY, tgz, type Ctx } from "./helpers.js";

let t: Ctx;
const DAY = 86_400_000;
const PUBLIC_IP = "93.184.216.34";

/** A local webhook receiver; resolves each delivery with its raw body and headers. */
interface Hook {
  url: string;
  next: () => Promise<{ body: string; headers: IncomingMessage["headers"] }>;
  count: () => number;
}
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function hook(status = 200): Promise<Hook> {
  const waiting: Array<(d: { body: string; headers: IncomingMessage["headers"] }) => void> = [];
  const got: Array<{ body: string; headers: IncomingMessage["headers"] }> = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      n++;
      res.statusCode = status;
      res.end();
      const d = { body, headers: req.headers };
      const w = waiting.shift();
      if (w) w(d);
      else got.push(d);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    next: () => (got.length ? Promise.resolve(got.shift()!) : new Promise((r) => waiting.push(r))),
    count: () => n,
  };
}

/** Put a finished render on disk so /files can serve it. */
function finishRender(ctx: Ctx, id: string, finishedAt = new Date()): string {
  const dir = path.join(ctx.cfg.rendersDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "video.mp4"), Buffer.alloc(1000, 7));
  ctx.store.update(id, {
    status: "done",
    finishedAt: finishedAt.toISOString(),
    files: { video: "video.mp4" },
    result: { width: 1080, height: 1920, fps: 30, durationInSeconds: 10, voice: null, expiresAt: "" },
  });
  return dir;
}

describe("job store", () => {
  it("persists the failure of interrupted renders, so a second boot doesn't see them again", async () => {
    t = await setup({}, never);
    const a = await (await t.post(STORY)).json();
    t.store.update(a.id, { status: "running" });
    await t.store.flush();
    const first = new JobStore(t.cfg.jobsDir);
    expect((await first.init()).interrupted).toBe(1);
    await first.flush();
    const onDisk = JSON.parse(readFileSync(path.join(t.cfg.jobsDir, `${a.id}.json`), "utf8")) as StoredJob;
    expect(onDisk.status).toBe("failed");
    expect((await new JobStore(t.cfg.jobsDir).init()).interrupted).toBe(0);
  });

  it("drops props once a job is terminal, in memory and on disk", async () => {
    t = await setup();
    const a = await (await t.post(STORY)).json();
    expect(t.store.get(a.id)?.props).toBeDefined();
    t.runner.finish(a.id, "failed", "x");
    await t.store.flush();
    expect(t.store.get(a.id)?.props).toBeUndefined();
    expect(readFileSync(path.join(t.cfg.jobsDir, `${a.id}.json`), "utf8")).not.toContain("Hello");
  });
});

describe("queue and cancel", () => {
  it("accepts exactly MAX_QUEUE waiting renders under concurrent submits", async () => {
    t = await setup({ MAX_QUEUE: "1" }, never);
    const results = await Promise.all(Array.from({ length: 6 }, () => t.post(STORY)));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([202, 202, 429, 429, 429, 429]); // one running, one waiting
  });

  it("aborts a running render with reason 'canceled' and lets it close itself out", async () => {
    let reason: unknown;
    t = await setup({}, (id, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => {
          reason = signal.reason;
          t.runner.finish(id, "canceled", "Canceled.");
          resolve();
        }),
      ),
    );
    const a = await (await t.post(STORY)).json();
    const res = await (await t.call(`/v1/renders/${a.id}`, { method: "DELETE", headers: auth })).json();
    expect(reason).toBe("canceled");
    expect(res.status).toBe("canceled");
  });

  it("cancels a job the queue doesn't hold instead of leaving it queued forever", async () => {
    t = await setup();
    const job = t.store.create({ ...STORY, site: "builtin", kind: "video" }, { serveDir: t.cfg.builtinBundleDir, publicBase: "http://x" });
    const res = await (await t.call(`/v1/renders/${job.id}`, { method: "DELETE", headers: auth })).json();
    expect(res.status).toBe("canceled");
  });

  it("fails a render whose runner rejects", async () => {
    t = await setup({}, async () => {
      throw new Error("boom");
    });
    const a = await (await t.post(STORY)).json();
    await new Promise((r) => setTimeout(r, 20));
    // The fake runner never marked it running, so it was still queued when it crashed.
    expect(t.store.get(a.id)?.status).toBe("failed");
    expect(t.store.get(a.id)?.error).toMatch(/crashed/);
  });

  it("on shutdown, starts nothing new, aborts running renders as 'shutdown' and keeps waiting ones queued", async () => {
    let reason: unknown;
    t = await setup({}, (_id, signal) => new Promise<void>((r) => signal.addEventListener("abort", () => ((reason = signal.reason), r()))));
    const running = await (await t.post(STORY)).json();
    const waiting = await (await t.post(STORY)).json();
    t.queue.pause();
    t.queue.abortRunning("shutdown");
    await t.queue.drain(1000);
    expect(reason).toBe("shutdown");
    expect(t.queue.size).toEqual({ queued: 1, running: 0 }); // paused: the waiting one did not start
    expect(t.store.get(waiting.id)?.status).toBe("queued");
    expect(running.id).not.toBe(waiting.id);
  });

  it("answers 503 to new work while draining", async () => {
    t = await setup();
    let draining = false;
    const { createApp } = await import("../src/server.js");
    const app = createApp({ cfg: t.cfg, store: t.store, queue: t.queue, sites: t.sites, runner: t.runner, version: "t", draining: () => draining });
    const req = (p: string, init: RequestInit = {}) => app.request(p, init, { incoming: { socket: { remoteAddress: "203.0.113.9" } } } as never);
    draining = true;
    const res = await req("/v1/renders", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(STORY) });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await req("/v1/renders", { headers: auth })).status).toBe(200);
    expect((await req("/healthz")).status).toBe(503);
  });
});

describe("webhooks", () => {
  it("refuses private, loopback and internal targets", async () => {
    t = await setup();
    for (const url of ["http://127.0.0.1:9/hook", "http://[::1]/hook", "http://169.254.169.254/latest", "http://api.railway.internal/x", "http://localhost/x", "http://10.1.2.3/"]) {
      const res = await t.post({ ...STORY, webhookUrl: url });
      expect(res.status, url).toBe(400);
    }
    expect((await t.post({ ...STORY, webhookUrl: `https://${PUBLIC_IP}/hook` })).status).toBe(202);
  });

  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.20.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of [PUBLIC_IP, "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("delivers on cancel, signed with the webhook secret (not the link secret), verifiable from the API key", async () => {
    const h = await hook();
    t = await setup({ ALLOW_PRIVATE_URLS: "1" }, never);
    await t.post(STORY); // occupies the worker
    const queued = await (await t.post({ ...STORY, webhookUrl: h.url })).json();
    await t.call(`/v1/renders/${queued.id}`, { method: "DELETE", headers: auth });
    const got = await h.next();
    expect(JSON.parse(got.body)).toMatchObject({ id: queued.id, status: "canceled" });
    const sig = got.headers["x-video-kit-signature"] as string;
    expect(await verifyWebhook(got.body, sig, { apiKey: KEY })).toBe(true);
    expect(await verifyWebhook(got.body + " ", sig, { apiKey: KEY })).toBe(false);
    expect(sig).not.toBe(signBody(t.cfg.signingSecret, got.body));
    expect(await webhookSecretFromApiKey(KEY)).toBe(t.cfg.webhookSecret);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.store.get(queued.id)?.webhookPending).toBe(false);
  });

  it("redelivers webhooks still pending after a restart", async () => {
    const h = await hook();
    t = await setup({ ALLOW_PRIVATE_URLS: "1" }, never);
    await t.post(STORY);
    const queued = await (await t.post({ ...STORY, webhookUrl: h.url })).json();
    // Terminal with the webhook still owed, as if the process died mid-delivery.
    t.store.update(queued.id, { status: "failed", error: RESTARTED, finishedAt: new Date().toISOString() });
    await t.store.flush();
    expect(t.store.get(queued.id)?.webhookPending).toBe(true);
    const next = await setup({ ALLOW_PRIVATE_URLS: "1" }, never, { dir: t.dir });
    expect(next.runner.redeliver()).toBe(1);
    expect(JSON.parse((await h.next()).body)).toMatchObject({ id: queued.id, status: "failed" });
  });
});

describe("props", () => {
  it("never keeps a client voiceover (the service voices narration itself)", async () => {
    t = await setup();
    await t.put("site", tgz(entry("index.html", "<html/>")));
    const res = await t.post({
      site: "site",
      composition: "Story",
      props: { narration: { a: "Hi." }, voiceover: { a: { src: "http://169.254.169.254/latest", durationInSeconds: 1 } } },
    });
    expect(res.status).toBe(202);
    const job = t.store.get((await res.json()).id)!;
    expect(job.props).toEqual({ narration: { a: "Hi." } });
  });

  it("caps narration lines and characters for any site", async () => {
    t = await setup({ MAX_NARRATION_LINES: "2", MAX_NARRATION_CHARS: "50" });
    await t.put("site", tgz(entry("index.html", "<html/>")));
    const post = (narration: unknown) => t.post({ site: "site", composition: "Story", props: { narration } });
    expect((await post({ a: "x", b: "y", c: "z" })).status).toBe(400);
    expect((await post({ a: "x".repeat(51) })).status).toBe(400);
    expect((await post({ a: 42 })).status).toBe(400);
    expect((await post(["nope"])).status).toBe(400);
    expect((await post({ a: "fine", b: null })).status).toBe(202);
    const story = await t.post({ composition: "Story", props: { scenes: [1, 2, 3].map((i) => ({ title: `T${i}`, narration: "Hello." })) } });
    expect(story.status).toBe(400);
  });

  it("voices only a Story's scene keys", () => {
    const p = prepareStoryProps({ scenes: [{ title: "a", narration: "One." }], narration: { s0: "Override.", stray: "Never played." } });
    expect(p.narration).toEqual({ s0: "Override." });
  });

  it("takes only https images and known sounds in Story, on public hosts", async () => {
    t = await setup();
    const withScene = (scene: object, extra: object = {}) => t.post({ composition: "Story", props: { scenes: [{ title: "a", ...scene }], ...extra } });
    expect((await withScene({ image: "http://example.com/a.jpg" })).status).toBe(400);
    expect((await withScene({ image: "https://10.0.0.1/a.jpg" })).status).toBe(400);
    expect((await withScene({ image: "https://169.254.169.254/a.jpg" })).status).toBe(400);
    expect((await withScene({ image: `https://${PUBLIC_IP}/a.jpg` })).status).toBe(202);
    expect((await withScene({}, { sfx: [{ sound: "data:audio/wav;base64,AAAA", at: 0 }] })).status).toBe(400);
    expect((await withScene({}, { sfx: [{ sound: "sfx/boom.wav", at: 0 }] })).status).toBe(400);
    expect((await withScene({}, { sfx: [{ sound: "https://127.0.0.1/boom.wav", at: 0 }] })).status).toBe(400);
    expect((await withScene({}, { sfx: [{ sound: "chime", at: 0 }, { sound: "remotion:ding", at: 1 }] })).status).toBe(202);
  });
});

describe("files and links", () => {
  it("answers HEAD with headers only, and keeps Range working", async () => {
    t = await setup();
    const a = await (await t.post(STORY)).json();
    finishRender(t, a.id);
    const head = await t.call(`/files/${a.id}/video.mp4`, { method: "HEAD", headers: auth });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const part = await t.call(`/files/${a.id}/video.mp4`, { headers: { ...auth, Range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    const full = await t.call(`/files/${a.id}/video.mp4`, { headers: auth });
    expect((await full.arrayBuffer()).byteLength).toBe(1000);
    expect(full.headers.get("content-disposition")).toMatch(/^inline; filename="Story-[0-9a-f]{8}\.mp4"; filename\*=UTF-8''/);
  });

  it("builds a Content-Disposition any composition id can go in", () => {
    const v = contentDisposition("inline", "故事-1234abcd.mp4");
    expect(v).toBe(`inline; filename="__-1234abcd.mp4"; filename*=UTF-8''%E6%95%85%E4%BA%8B-1234abcd.mp4`);
    expect(() => new Headers({ "Content-Disposition": v })).not.toThrow();
    expect(contentDisposition("inline", 'a"b\\c.mp4')).toContain('filename="a_b_c.mp4"');
  });

  it("never issues links that outlive the render", async () => {
    t = await setup({ RETENTION_DAYS: "7", URL_TTL_HOURS: "168" });
    const a = await (await t.post(STORY)).json();
    const finished = new Date(Date.now() - 7 * DAY + 3_600_000); // deleted by retention in an hour
    finishRender(t, a.id, finished);
    const job = await (await t.call(`/v1/renders/${a.id}`, { headers: auth })).json();
    const expires = Date.parse(job.result.expiresAt);
    expect(expires).toBeLessThanOrEqual(finished.getTime() + 7 * DAY + 1000);
    expect(expires).toBeGreaterThan(Date.now() + 3_500_000);
    const exp = Number(new URL(job.result.videoUrl).searchParams.get("exp"));
    expect(exp * 1000).toBe(expires);
  });

  it("refuses links signed to expire beyond the longest TTL the service issues", async () => {
    t = await setup();
    const a = await (await t.post(STORY)).json();
    finishRender(t, a.id);
    const p = `/files/${a.id}/video.mp4`;
    const ok = signPath(t.cfg.signingSecret, p, 3600).query;
    const forever = signPath(t.cfg.signingSecret, p, 10 * 365 * 86400).query;
    expect((await t.call(`${p}?${ok}`)).status).toBe(200);
    expect((await t.call(`${p}?${forever}`)).status).toBe(403);
    const { exp, query } = signPath("s".repeat(20), p, 1000 * 86400);
    expect(verifySignedPath("s".repeat(20), p, String(exp), new URLSearchParams(query).get("sig")!, { maxTtlSeconds: 86400 })).toBe(false);
  });
});

describe("sites and retention", () => {
  it("runs deploys one at a time and records the version each replaced", async () => {
    t = await setup({}, undefined, { compositionsDelayMs: 40 });
    const [a, b] = await Promise.all([t.put("site", tgz(entry("index.html", "1"))), t.put("site", tgz(entry("index.html", "2")))]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(t.compositionsPeak()).toBe(1);
    const meta = JSON.parse(readFileSync(path.join(t.cfg.sitesDir, "site", "meta.json"), "utf8"));
    expect(Object.keys(meta.retired)).toHaveLength(1);
    expect(readdirSync(path.join(t.cfg.sitesDir, "site")).filter((v) => !v.endsWith(".json"))).toHaveLength(2);
  });

  it("extracts with deploy-time mtimes, not the archive's", async () => {
    t = await setup();
    await t.put("site", tgz(entry("index.html", "x"))); // entries carry mtime 1970
    const meta = JSON.parse(readFileSync(path.join(t.cfg.sitesDir, "site", "meta.json"), "utf8"));
    const m = statSync(path.join(t.cfg.sitesDir, "site", meta.current, "index.html")).mtimeMs;
    expect(Date.now() - m).toBeLessThan(60_000);
  });

  it("refuses to delete a site with renders in flight, and retention keeps their version", async () => {
    t = await setup({}, never);
    await t.put("site", tgz(entry("index.html", "1")));
    const job = await (await t.post({ site: "site", composition: "Story" })).json();
    await t.put("site", tgz(entry("index.html", "2")));
    expect((await t.call("/v1/sites/site", { method: "DELETE", headers: auth })).status).toBe(409);

    // Pretend the first version was replaced two days ago.
    const metaFile = path.join(t.cfg.sitesDir, "site", "meta.json");
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    const [old] = Object.keys(meta.retired);
    meta.retired[old] = new Date(Date.now() - 2 * DAY).toISOString();
    writeFileSync(metaFile, JSON.stringify(meta));
    const versions = () => readdirSync(path.join(t.cfg.sitesDir, "site")).filter((v) => !v.endsWith(".json"));

    await sweep(t.cfg, t.store, t.sites, () => undefined);
    expect(versions()).toContain(old); // the running render still reads it
    t.runner.finish(job.id, "failed", "x");
    await sweep(t.cfg, t.store, t.sites, () => undefined);
    expect(versions()).not.toContain(old);
    expect((await t.call("/v1/sites/site", { method: "DELETE", headers: auth })).status).toBe(200);
  });

  it("leaves the voice cache alone while renders run", async () => {
    t = await setup();
    mkdirSync(t.cfg.voiceDir, { recursive: true });
    const clip = path.join(t.cfg.voiceDir, "0123456789abcdef01234567.wav");
    writeFileSync(clip, "RIFF");
    const old = new Date(Date.now() - 60 * DAY);
    utimesSync(clip, old, old);
    await sweep(t.cfg, t.store, t.sites, () => undefined, () => true);
    expect(readdirSync(t.cfg.voiceDir)).toHaveLength(1);
    await sweep(t.cfg, t.store, t.sites, () => undefined, () => false);
    expect(readdirSync(t.cfg.voiceDir)).toHaveLength(0);
  });
});
