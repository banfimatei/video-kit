import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { signPath, verifySignedPath } from "../src/auth.js";
import { JobStore } from "../src/jobs.js";
import { auth, entry, never, setup, tgz, type Ctx } from "./helpers.js";

let t: Ctx;

describe("auth", () => {
  beforeEach(async () => {
    t = await setup();
  });
  it("leaves /healthz open and closes /v1 without the key", async () => {
    expect((await t.call("/healthz")).status).toBe(200);
    expect((await t.call("/v1/templates")).status).toBe(401);
    expect((await t.call("/v1/templates", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await t.call("/v1/templates", { headers: auth })).status).toBe(200);
  });
});

describe("POST /v1/renders", () => {

  it("validates built-in props up front and names the bad field", async () => {
    t = await setup();
    const res = await t.post({ composition: "Story", props: { scenes: [] } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("props.scenes");
  });

  it("404s an unknown site or composition, and 400s a non-http webhook", async () => {
    t = await setup();
    expect((await t.post({ site: "nope", composition: "Story" })).status).toBe(404);
    expect((await t.post({ composition: "Nope" })).status).toBe(404);
    expect((await t.post({ composition: "Story", props: { scenes: [{ title: "x" }] }, webhookUrl: "file:///etc/passwd" })).status).toBe(400);
  });

  it("takes a per-render voice, and 400s one that isn't a model or voice name", async () => {
    t = await setup({}, never);
    const base = { composition: "Story", props: { scenes: [{ title: "x" }] } };
    expect((await t.post({ ...base, ttsOptions: { voice: "flux-hannah-en" } })).status).toBe(202);
    expect((await t.post({ ...base, ttsOptions: { voice: "a b" } })).status).toBe(400);
    expect((await t.post({ ...base, ttsOptions: { speed: 2 } })).status).toBe(400);
  });

  it("queues a valid render, then 429s when the queue is full", async () => {
    t = await setup({ MAX_QUEUE: "1" }, never); // the first render never finishes
    const ok = { composition: "Story", props: { scenes: [{ title: "Hello" }] } };
    expect((await t.post(ok)).status).toBe(202); // running
    expect((await t.post(ok)).status).toBe(202); // queued
    const full = await t.post(ok);
    expect(full.status).toBe(429);
  });

  it("cancels a queued render", async () => {
    t = await setup({}, never);
    const ok = { composition: "Story", props: { scenes: [{ title: "Hello" }] } };
    await t.post(ok);
    const queued = await (await t.post(ok)).json();
    expect(queued.status).toBe("queued");
    expect(queued.position).toBe(0);
    const res = await t.call(`/v1/renders/${queued.id}`, { method: "DELETE", headers: auth });
    expect((await res.json()).status).toBe("canceled");
  });

  it("never returns props or internal paths", async () => {
    t = await setup();
    const job = await (await t.post({ composition: "Story", props: { scenes: [{ title: "secret-ish" }] } })).json();
    expect(JSON.stringify(job)).not.toContain("secret-ish");
    expect(job).not.toHaveProperty("serveDir");
  });
});

describe("sites", () => {
  beforeEach(async () => {
    t = await setup();
  });

  it("deploys a bundle and lists it", async () => {
    const res = await t.put("layway", tgz(entry("index.html", "<html/>"), entry("bundle.js", "1")));
    expect(res.status).toBe(201);
    expect((await res.json()).compositions).toEqual(["Story"]);
    const list = await (await t.call("/v1/sites", { headers: auth })).json();
    expect(list.sites.map((s: { name: string }) => s.name)).toEqual(["layway"]);
  });

  it("rejects bad names and the reserved builtin", async () => {
    expect((await t.put("Bad_Name", tgz(entry("index.html", "x")))).status).toBe(400);
    expect((await t.put("builtin", tgz(entry("index.html", "x")))).status).toBe(400);
  });

  it("refuses path traversal and never writes outside the site", async () => {
    const res = await t.put("evil", tgz(entry("index.html", "x"), entry("../../escaped.txt", "pwned")));
    expect(res.status).toBe(400);
    expect(existsSync(path.join(t.cfg.sitesDir, "escaped.txt"))).toBe(false);
    expect(existsSync(path.join(t.cfg.dataDir, "escaped.txt"))).toBe(false);
    expect(existsSync(path.join(t.dir, "escaped.txt"))).toBe(false);
  });

  it("skips symlinks instead of following them", async () => {
    const res = await t.put("links", tgz(entry("index.html", "x"), entry("passwd", "", "SymbolicLink", "/etc/passwd")));
    expect(res.status).toBe(201);
    const meta = JSON.parse(readFileSync(path.join(t.cfg.sitesDir, "links", "meta.json"), "utf8"));
    expect(existsSync(path.join(t.cfg.sitesDir, "links", meta.current, "passwd"))).toBe(false);
  });

  it("requires index.html and a readable archive", async () => {
    expect((await t.put("nohtml", tgz(entry("bundle.js", "1")))).status).toBe(400);
    expect((await t.put("garbage", Buffer.from("not a tarball"))).status).toBe(400);
  });

  it("enforces MAX_SITE_MB while streaming", async () => {
    t = await setup({ MAX_SITE_MB: "0.001" });
    const big = tgz(entry("index.html", "x"), entry("big.bin", "y".repeat(5000)), entry("noise.bin", Math.random().toString(36).repeat(400)));
    expect((await t.put("big", big)).status).toBe(413);
  });
});

describe("voice clips and render files", () => {
  beforeEach(async () => {
    t = await setup();
  });

  it("serves voice clips to loopback only, with CORS", async () => {
    mkdirSync(t.cfg.voiceDir, { recursive: true });
    const name = "0123456789abcdef01234567.wav";
    writeFileSync(path.join(t.cfg.voiceDir, name), "RIFF");
    expect((await t.call(`/internal/voice/${name}`)).status).toBe(404);
    const local = await t.call(`/internal/voice/${name}`, {}, "127.0.0.1");
    expect(local.status).toBe(200);
    expect(local.headers.get("access-control-allow-origin")).toBe("*");
    expect((await t.call("/internal/voice/..%2Fjobs", {}, "127.0.0.1")).status).toBe(404);
  });

  it("signs file paths and rejects tampering, other paths and expiry", () => {
    const now = Date.now();
    const { exp, query } = signPath("secret-secret-secret", "/files/a/video.mp4", 60, now);
    const sig = new URLSearchParams(query).get("sig")!;
    expect(verifySignedPath("secret-secret-secret", "/files/a/video.mp4", String(exp), sig, { now })).toBe(true);
    expect(verifySignedPath("secret-secret-secret", "/files/b/video.mp4", String(exp), sig, { now })).toBe(false);
    expect(verifySignedPath("other-secret-secret", "/files/a/video.mp4", String(exp), sig, { now })).toBe(false);
    expect(verifySignedPath("secret-secret-secret", "/files/a/video.mp4", String(exp), sig, { now: now + 61_000 })).toBe(false);
    expect(verifySignedPath("secret-secret-secret", "/files/a/video.mp4", "abc", sig, { now })).toBe(false);
  });

  it("403s a file without a valid signature or key", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await t.call(`/files/${id}/video.mp4`)).status).toBe(403);
    expect((await t.call(`/files/${id}/video.mp4?exp=9999999999&sig=nope`)).status).toBe(403);
  });
});

describe("restart", () => {
  it("fails renders that were running and hands back the ones still waiting, oldest first", async () => {
    t = await setup({}, never);
    const a = await (await t.post({ composition: "Story", props: { scenes: [{ title: "a" }] } })).json();
    const b = await (await t.post({ composition: "Story", props: { scenes: [{ title: "b" }] } })).json();
    const c = await (await t.post({ composition: "Story", props: { scenes: [{ title: "c" }] } })).json();
    t.store.update(a.id, { status: "running" });
    await t.store.flush();
    const fresh = new JobStore(t.cfg.jobsDir);
    expect(await fresh.init()).toEqual({ interrupted: 1, queued: [b.id, c.id] });
    expect(fresh.get(a.id)?.status).toBe("failed");
    expect(fresh.get(a.id)?.error).toMatch(/restarted/);
    expect(fresh.get(b.id)).toMatchObject({ status: "queued", props: { scenes: [{ title: "b" }] } });
  });
});
