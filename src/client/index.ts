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
  /** TTS provider for `props.narration` (elevenlabs | openai | gemini | deepgram | openrouter | espeak | none); default: whichever key the service has. */
  tts?: string;
  /**
   * Model and/or voice for this render, over the service's defaults for the
   * provider: e.g. `{ voice: "flux-hannah-en" }` or `{ voice: "aura-2-apollo-en" }`
   * (Deepgram), `{ model: "google/gemini-3.8-flash-tts", voice: "Kore" }` (OpenRouter).
   */
  ttsOptions?: { model?: string; voice?: string };
  /**
   * A music bed composed to the video's length and passed to the composition
   * as `props.musicTrack` ({ src, durationInSeconds, provider }); the
   * composition decides how to play it. `"elevenlabs"` uses the service's
   * default prompt; `{ provider, prompt }` brings its own. Videos only.
   */
  music?: "elevenlabs" | { provider: "elevenlabs"; prompt?: string };
  /** "video" (default, mp4) or "still" (png of `frame`). */
  kind?: RenderKind;
  /** Frame for a still. */
  frame?: number;
  /** Poster frame for a video, or false for none. Default 60. */
  poster?: number | false;
  /**
   * POSTed the finished job (JSON) when it is done, failed or canceled, signed
   * with X-Video-Kit-Signature (check it with verifyWebhook). Delivered at
   * least once: dedupe by job id. Must be a public http(s) host.
   */
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
  /** The provider that composed the music bed, if any. */
  music?: string | null;
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
    /** Seconds the server asked to wait (Retry-After), if it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "VideoKitError";
  }
}

export interface VideoKitClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /**
   * How many times render() and deploySite() retry a 429 (queue full) or 503
   * (service restarting), honouring Retry-After. Nothing was created on
   * those, so a retry can't duplicate work. Default 5; 0 turns it off.
   */
  retries?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Statuses that mean "try again shortly": queue full, restarting, or a proxy in between saw no service. */
const TRANSIENT = new Set([429, 502, 503, 504]);

/** True for errors worth retrying a read on: a transient status, or no response at all. */
function isTransient(err: unknown): boolean {
  if (err instanceof VideoKitError) return TRANSIENT.has(err.status);
  return err instanceof TypeError; // fetch's network failure (connection refused, reset, DNS)
}

const backoff = (attempt: number, retryAfter?: number) =>
  retryAfter && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : Math.min(30_000, 1000 * 2 ** attempt);

export function createVideoKitClient(opts: VideoKitClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 5;

  /** Run a request that creates nothing on 429/503, retrying those. */
  async function submit<T>(send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
      } catch (err) {
        const again = err instanceof VideoKitError && (err.status === 429 || err.status === 503) && attempt < retries;
        if (!again) throw err;
        await sleep(backoff(attempt, err.retryAfter));
      }
    }
  }

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
      const body = parsed && typeof parsed === "object" ? (parsed as { error?: unknown; details?: unknown; issues?: unknown }) : null;
      let message = body && "error" in body ? String(body.error) : text;
      // Validation errors name the fields: put them in the message, not only in .body.
      const list = Array.isArray(body?.details) ? body.details : Array.isArray(body?.issues) ? body.issues : null;
      if (list?.length) {
        message += ` (${list
          .map((i: { path?: unknown; message?: unknown }) => (i.path ? `${String(i.path)}: ${String(i.message)}` : String(i.message)))
          .join("; ")})`;
      }
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw new VideoKitError(`${method} ${route} → ${res.status}: ${message}`, res.status, parsed, retryAfter);
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
      submit(() => call<SiteInfo>("PUT", `/v1/sites/${encodeURIComponent(name)}`, tarball, { "Content-Type": "application/gzip" })),
    deleteSite: (name: string) => call<{ deleted: boolean }>("DELETE", `/v1/sites/${encodeURIComponent(name)}`),
    render: (req: RenderRequest) => submit(() => call<RenderJob>("POST", "/v1/renders", req)),
    get: (id: string) => call<RenderJob>("GET", `/v1/renders/${encodeURIComponent(id)}`),
    list: () => call<{ renders: RenderJob[] }>("GET", "/v1/renders").then((r) => r.renders),
    cancel: (id: string) => call<RenderJob>("DELETE", `/v1/renders/${encodeURIComponent(id)}`),
    /**
     * Poll until the job is done, failed or canceled. Throws on failure unless
     * `throwOnFailure: false`. Rides out a restarting service (connection
     * refused, 502/503/504, 429) until the timeout: jobs survive restarts.
     */
    async wait(id: string, o: WaitOptions = {}): Promise<RenderJob> {
      const deadline = Date.now() + (o.timeoutMs ?? 15 * 60_000);
      let misses = 0;
      for (;;) {
        let job: RenderJob;
        try {
          job = await client.get(id);
          misses = 0;
        } catch (err) {
          if (!isTransient(err) || Date.now() > deadline) throw err;
          await sleep(backoff(misses++, err instanceof VideoKitError ? err.retryAfter : undefined));
          continue;
        }
        o.onProgress?.(job);
        if (job.status === "done") return job;
        if (job.status === "failed" || job.status === "canceled") {
          if (o.throwOnFailure === false) return job;
          throw new VideoKitError(`Render ${id} ${job.status}: ${job.error ?? "no error given"}`, 500, job);
        }
        if (Date.now() > deadline) throw new VideoKitError(`Render ${id} still ${job.status} after timeout`, 504, job);
        await sleep(o.intervalMs ?? 2000);
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

const encoder = new TextEncoder();
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, encoder.encode(data)));
}

/**
 * The key webhooks are signed with when the service has no WEBHOOK_SECRET of
 * its own: the lowercase hex of HMAC-SHA256(apiKey, "video-kit:webhook"),
 * used as a UTF-8 string key (not the raw digest bytes).
 */
export function webhookSecretFromApiKey(apiKey: string): Promise<string> {
  return hmacHex(apiKey, "video-kit:webhook");
}

/**
 * Check a webhook's `X-Video-Kit-Signature` against its raw body (the exact
 * bytes received, before JSON.parse). Pass the service's WEBHOOK_SECRET, or
 * the API key when the service derives it.
 */
export async function verifyWebhook(
  rawBody: string,
  /** The X-Video-Kit-Signature header, as your framework gives it (Node's req.headers may give an array). */
  signature: string | string[] | null | undefined,
  key: { secret: string } | { apiKey: string },
): Promise<boolean> {
  const header = Array.isArray(signature) ? signature[0] : signature;
  const m = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const secret = "secret" in key ? key.secret : await webhookSecretFromApiKey(key.apiKey);
  const want = await hmacHex(secret, rawBody);
  // Constant-time compare over equal-length hex strings.
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[1].charCodeAt(i);
  return diff === 0;
}
