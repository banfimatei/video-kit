import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createVideoKitClient,
  verifyWebhook,
  VideoKitError,
  webhookSecretFromApiKey,
  type RenderJob,
} from "../src/client/index.js";

function fakeServer(jobs: RenderJob[]) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  let polls = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: init.body });
    if (url.endsWith("/v1/renders") && init.method === "POST") return Response.json(jobs[0], { status: 202 });
    if (url.includes("/v1/renders/")) return Response.json(jobs[Math.min(++polls, jobs.length - 1)]);
    if (url.includes("/v1/sites/")) return Response.json({ name: "zortix", uploadedAt: "t", bytes: 3, compositions: ["SignalShort"] });
    if (url.endsWith("/v1/templates")) return Response.json({ error: "bad key" }, { status: 401 });
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const job = (status: RenderJob["status"], extra: Partial<RenderJob> = {}): RenderJob => ({
  id: "j1",
  status,
  progress: 0,
  site: "builtin",
  composition: "Story",
  kind: "video",
  createdAt: "t",
  ...extra,
});

describe("video-kit client", () => {
  it("renders and polls until done, with the bearer key", async () => {
    const { calls, fetchImpl } = fakeServer([job("queued"), job("running", { progress: 0.5 }), job("done", { progress: 1 })]);
    const kit = createVideoKitClient({ baseUrl: "https://kit.example/", apiKey: "k", fetch: fetchImpl });
    const seen: string[] = [];
    const done = await kit.renderAndWait({ composition: "Story", props: {} }, { intervalMs: 1, onProgress: (j) => seen.push(j.status) });
    expect(done.status).toBe("done");
    expect(seen).toEqual(["running", "done"]);
    expect(calls[0].url).toBe("https://kit.example/v1/renders");
    expect(calls[0].headers.Authorization).toBe("Bearer k");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("throws VideoKitError with the server's message, and on failed jobs", async () => {
    const { fetchImpl } = fakeServer([job("queued"), job("failed", { error: "boom" })]);
    const kit = createVideoKitClient({ baseUrl: "https://kit.example", apiKey: "k", fetch: fetchImpl });
    await expect(kit.templates()).rejects.toMatchObject({ status: 401, message: expect.stringContaining("bad key") });
    await expect(kit.renderAndWait({ composition: "Story" }, { intervalMs: 1 })).rejects.toBeInstanceOf(VideoKitError);
  });

  it("uploads a site as raw gzip, not JSON", async () => {
    const { calls, fetchImpl } = fakeServer([job("queued")]);
    const kit = createVideoKitClient({ baseUrl: "https://kit.example", apiKey: "k", fetch: fetchImpl });
    await kit.deploySite("zortix", new Uint8Array([1, 2, 3]));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.headers["Content-Type"]).toBe("application/gzip");
    expect(put.body).toBeInstanceOf(Uint8Array);
  });
});

describe("errors", () => {
  it("puts the server's validation details in the message", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { error: "Invalid props", details: [{ path: "props.scenes.0.title", message: "Required" }] },
        { status: 400 },
      )) as unknown as typeof fetch;
    const kit = createVideoKitClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchImpl });
    await expect(kit.render({ composition: "Story" })).rejects.toThrow(
      "POST /v1/renders → 400: Invalid props (props.scenes.0.title: Required)",
    );
  });
});

describe("restarts", () => {
  it("retries a render the service refused with 503/429, honouring Retry-After", async () => {
    const replies = [
      Response.json({ error: "restarting" }, { status: 503, headers: { "Retry-After": "7" } }),
      Response.json({ error: "queue full" }, { status: 429 }),
      Response.json(job("queued"), { status: 202 }),
    ];
    const sleeps: number[] = [];
    const kit = createVideoKitClient({
      baseUrl: "http://x",
      apiKey: "k",
      fetch: (async () => replies.shift()!) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect((await kit.render({ composition: "Story" })).status).toBe("queued");
    expect(sleeps).toEqual([7000, 2000]);
  });

  it("doesn't retry a render the service rejected", async () => {
    let calls = 0;
    const kit = createVideoKitClient({
      baseUrl: "http://x",
      apiKey: "k",
      fetch: (async () => (calls++, Response.json({ error: "Invalid props" }, { status: 400 }))) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(kit.render({ composition: "Story" })).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it("keeps waiting through a restart: connection refused, 502, then done", async () => {
    const replies: Array<Response | Error> = [
      Response.json(job("running")),
      new TypeError("fetch failed"),
      new Response("Bad gateway", { status: 502 }),
      Response.json(job("done", { result: { width: 1, height: 1, fps: 30, durationInSeconds: 1, voice: null, expiresAt: "t" } })),
    ];
    const kit = createVideoKitClient({
      baseUrl: "http://x",
      apiKey: "k",
      fetch: (async () => {
        const r = replies.shift()!;
        if (r instanceof Error) throw r;
        return r;
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect((await kit.wait("j1")).status).toBe("done");
  });

  it("still gives up on a job that is gone", async () => {
    const kit = createVideoKitClient({
      baseUrl: "http://x",
      apiKey: "k",
      fetch: (async () => Response.json({ error: "No such render." }, { status: 404 })) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(kit.wait("j1")).rejects.toThrow(/404/);
  });
});

describe("verifyWebhook", () => {
  const body = JSON.stringify({ id: "j1", status: "done" });
  const sign = (secret: string, b = body) => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;

  it("derives the service's default webhook secret from the API key", async () => {
    const expected = createHmac("sha256", "api-key-0123456789").update("video-kit:webhook").digest("hex");
    expect(await webhookSecretFromApiKey("api-key-0123456789")).toBe(expected);
    expect(await verifyWebhook(body, sign(expected), { apiKey: "api-key-0123456789" })).toBe(true);
  });

  it("accepts an explicit secret and rejects tampering, other keys and junk", async () => {
    expect(await verifyWebhook(body, sign("whsec-0123456789abcdef"), { secret: "whsec-0123456789abcdef" })).toBe(true);
    expect(await verifyWebhook(body + " ", sign("whsec-0123456789abcdef"), { secret: "whsec-0123456789abcdef" })).toBe(false);
    expect(await verifyWebhook(body, sign("other-secret-0123456"), { secret: "whsec-0123456789abcdef" })).toBe(false);
    expect(await verifyWebhook(body, "sha256=nothex", { secret: "whsec-0123456789abcdef" })).toBe(false);
    expect(await verifyWebhook(body, undefined, { secret: "whsec-0123456789abcdef" })).toBe(false);
  });
});
