import { describe, expect, it } from "vitest";
import { createVideoKitClient, VideoKitError, type RenderJob } from "../src/client/index.js";

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
