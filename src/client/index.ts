/**
 * Client for the video-kit render service. Fetch only, so it runs in Node,
 * Bun, Deno, edge runtimes and browsers alike (keep the API key server-side).
 *
 *   const kit = createVideoKitClient({ baseUrl: process.env.VIDEO_KIT_URL!, apiKey: process.env.VIDEO_KIT_API_KEY! });
 *   const job = await kit.renderAndWait({ composition: "Story", props: { scenes: [{ title: "Hello" }] } });
 *   console.log(job.result?.videoUrl);
 */

export type RenderKind = "video" | "still";
export type RenderStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface RenderRequest {
  /** A site uploaded with deploySite(), or "builtin" (default) for the service's own templates. */
  site?: string;
  composition: string;
  props?: Record<string, unknown>;
  /** TTS provider for `props.narration` (elevenlabs | openai | gemini | espeak | none); default: whichever key the service has. */
  tts?: string;
  /** "video" (default, mp4) or "still" (png of `frame`). */
  kind?: RenderKind;
  /** Frame for a still. */
  frame?: number;
  /** Poster frame for a video, or false for none. Default 60. */
  poster?: number | false;
  /** POSTed the finished job (JSON) when it completes or fails, signed with X-Video-Kit-Signature. */
  webhookUrl?: string;
}

export interface RenderResult {
  videoUrl?: string;
  posterUrl?: string;
  stillUrl?: string;
  width: number;
  height: number;
  fps: number;
  durationInSeconds: number;
  /** The TTS provider that voiced the narration, if any. */
  voice: string | null;
  /** When the signed URLs stop working. */
  expiresAt: string;
}

export interface RenderJob {
  id: string;
  status: RenderStatus;
  stage?: string;
  /** 0..1 within the current stage. */
  progress: number;
  site: string;
  composition: string;
  kind: RenderKind;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Jobs ahead of this one while queued. */
  position?: number;
  error?: string;
  result?: RenderResult;
}

export interface TemplateInfo {
  site: string;
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  defaultProps: Record<string, unknown>;
  /** JSON Schema of the props, where the service knows it (built-in templates). */
  schema?: unknown;
}

export interface SiteInfo {
  name: string;
  uploadedAt: string;
  bytes: number;
  compositions: string[];
}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (job: RenderJob) => void;
  /** Return failed/canceled jobs instead of throwing. */
  throwOnFailure?: boolean;
}

export class VideoKitError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "VideoKitError";
  }
}

export interface VideoKitClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export function createVideoKitClient(opts: VideoKitClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? fetch;

  async function call<T>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const isRaw = body instanceof Uint8Array || body instanceof ArrayBuffer || (typeof Blob !== "undefined" && body instanceof Blob);
    const res = await fetchImpl(`${base}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        ...(body !== undefined && !isRaw ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isRaw ? (body as BodyInit) : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep the text
    }
    if (!res.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : text;
      throw new VideoKitError(`${method} ${route} → ${res.status}: ${message}`, res.status, parsed);
    }
    return parsed as T;
  }

  const client = {
    health: () => call<{ ok: boolean; version: string }>("GET", "/healthz"),
    templates: (site?: string) =>
      call<{ templates: TemplateInfo[] }>("GET", `/v1/templates${site ? `?site=${encodeURIComponent(site)}` : ""}`).then(
        (r) => r.templates,
      ),
    sites: () => call<{ sites: SiteInfo[] }>("GET", "/v1/sites").then((r) => r.sites),
    /** Upload a gzipped tarball of a `remotion bundle` directory as site `name` (replacing any previous one). */
    deploySite: (name: string, tarball: Uint8Array | ArrayBuffer | Blob) =>
      call<SiteInfo>("PUT", `/v1/sites/${encodeURIComponent(name)}`, tarball, { "Content-Type": "application/gzip" }),
    deleteSite: (name: string) => call<{ deleted: boolean }>("DELETE", `/v1/sites/${encodeURIComponent(name)}`),
    render: (req: RenderRequest) => call<RenderJob>("POST", "/v1/renders", req),
    get: (id: string) => call<RenderJob>("GET", `/v1/renders/${encodeURIComponent(id)}`),
    list: () => call<{ renders: RenderJob[] }>("GET", "/v1/renders").then((r) => r.renders),
    cancel: (id: string) => call<RenderJob>("DELETE", `/v1/renders/${encodeURIComponent(id)}`),
    /** Poll until the job is done, failed or canceled. Throws on failure unless `throwOnFailure: false`. */
    async wait(id: string, o: WaitOptions = {}): Promise<RenderJob> {
      const deadline = Date.now() + (o.timeoutMs ?? 15 * 60_000);
      for (;;) {
        const job = await client.get(id);
        o.onProgress?.(job);
        if (job.status === "done") return job;
        if (job.status === "failed" || job.status === "canceled") {
          if (o.throwOnFailure === false) return job;
          throw new VideoKitError(`Render ${id} ${job.status}: ${job.error ?? "no error given"}`, 500, job);
        }
        if (Date.now() > deadline) throw new VideoKitError(`Render ${id} still ${job.status} after timeout`, 504, job);
        await new Promise((r) => setTimeout(r, o.intervalMs ?? 2000));
      }
    },
    async renderAndWait(req: RenderRequest, o?: WaitOptions): Promise<RenderJob> {
      const job = await client.render(req);
      return client.wait(job.id, o);
    },
    /** Download a finished render's video (or still) as bytes. */
    async download(job: RenderJob, which: "video" | "poster" | "still" = job.kind === "still" ? "still" : "video") {
      const url = which === "video" ? job.result?.videoUrl : which === "poster" ? job.result?.posterUrl : job.result?.stillUrl;
      if (!url) throw new VideoKitError(`Render ${job.id} has no ${which}`, 404, job);
      const res = await fetchImpl(url);
      if (!res.ok) throw new VideoKitError(`Download ${which} → ${res.status}`, res.status, null);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
  return client;
}

export type VideoKitClient = ReturnType<typeof createVideoKitClient>;
