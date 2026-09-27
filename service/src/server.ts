import path from "node:path";
import type { HttpBindings } from "@hono/node-server";
import type { RenderKind, RenderRequest } from "@banfimatei/video-kit/client";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { bearerToken, safeEqual, verifySignedPath } from "./auth.js";
import type { Config } from "./config.js";
import { fileResponse } from "./files.js";
import { TERMINAL, type JobStore, type RenderQueue } from "./jobs.js";
import type { Runner } from "./runner.js";
import { BUILTIN, HttpError, type Sites } from "./sites.js";
import { BUILTIN_TEMPLATES, builtinJsonSchema } from "./templates.js";

const renderRequestSchema = z.object({
  site: z.string().min(1).max(63).default(BUILTIN),
  composition: z.string().min(1).max(100),
  props: z.record(z.string(), z.unknown()).default({}),
  tts: z.enum(["elevenlabs", "openai", "gemini", "espeak", "none"]).optional(),
  kind: z.enum(["video", "still"]).default("video"),
  frame: z.number().int().min(0).optional(),
  poster: z.union([z.number().int().min(0), z.literal(false)]).optional(),
  webhookUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "webhookUrl must be http(s)")
    .optional(),
});

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const VOICE_FILE = /^[0-9a-f]{24}\.(wav|mp3)$/;
const RENDER_FILES = new Set(["video.mp4", "video.poster.png", "still.png"]);
const ID = /^[0-9a-f-]{36}$/;

type Env = { Bindings: HttpBindings };

export interface AppDeps {
  cfg: Config;
  store: JobStore;
  queue: RenderQueue;
  sites: Sites;
  runner: Runner;
  version: string;
}

/** The origin clients reached us on, for the job's file URLs. */
function requestOrigin(c: Context<Env>, cfg: Config): string {
  if (cfg.publicUrl) return cfg.publicUrl.replace(/\/+$/, "");
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() || new URL(c.req.url).protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0].trim() || c.req.header("host") || `localhost:${cfg.PORT}`;
  return `${proto}://${host}`;
}

export function createApp({ cfg, store, queue, sites, runner, version }: AppDeps) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, details: err.details }, err.status as 400);
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    }
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.get("/healthz", (c) => c.json({ ok: true, version, queue: queue.size }));

  // Voice clips for the service's own headless Chrome only; CORS because the bundle is another origin.
  app.get("/internal/voice/:file", async (c) => {
    const remote = c.env.incoming.socket.remoteAddress ?? "";
    if (!LOOPBACK.has(remote)) return c.json({ error: "Not found" }, 404);
    const file = c.req.param("file");
    if (!VOICE_FILE.test(file)) return c.json({ error: "Not found" }, 404);
    return fileResponse(path.join(cfg.voiceDir, file), c.req.header("range"), { "Access-Control-Allow-Origin": "*" });
  });

  // Render outputs: a signed URL (from the job) or the API key.
  app.get("/files/:id/:file", async (c) => {
    const { id, file } = c.req.param();
    if (!ID.test(id) || !RENDER_FILES.has(file)) return c.json({ error: "Not found" }, 404);
    const signed = verifySignedPath(cfg.signingSecret, `/files/${id}/${file}`, c.req.query("exp"), c.req.query("sig"));
    const token = bearerToken(c.req.header("authorization"));
    if (!signed && !(token && safeEqual(token, cfg.RENDER_API_KEY))) return c.json({ error: "Link expired or invalid" }, 403);
    const job = store.get(id);
    if (!job || job.status !== "done") return c.json({ error: "Not found" }, 404);
    return fileResponse(path.join(cfg.rendersDir, id, file), c.req.header("range"), {
      "Content-Disposition": `inline; filename="${job.composition}-${id.slice(0, 8)}${path.extname(file)}"`,
    });
  });

  const v1 = new Hono<Env>();
  v1.use("*", async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !safeEqual(token, cfg.RENDER_API_KEY)) return c.json({ error: "Missing or wrong API key" }, 401);
    await next();
  });

  v1.get("/templates", async (c) => {
    const site = c.req.query("site") ?? BUILTIN;
    return c.json({ templates: await sites.templates(site, builtinJsonSchema) });
  });

  v1.get("/sites", async (c) => c.json({ sites: await sites.list() }));

  v1.put("/sites/:name", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > cfg.MAX_SITE_MB * 1024 * 1024) throw new HttpError(413, `Site is over MAX_SITE_MB (${cfg.MAX_SITE_MB} MB).`);
    const info = await sites.deploy(c.req.param("name"), c.req.raw.body as never);
    return c.json(info, 201);
  });

  v1.delete("/sites/:name", async (c) => {
    const name = c.req.param("name");
    if (!(await sites.remove(name))) throw new HttpError(404, `No site "${name}".`);
    return c.json({ deleted: true });
  });

  v1.post("/renders", bodyLimit({ maxSize: cfg.MAX_BODY_KB * 1024, onError: (c) => c.json({ error: "Request body too large" }, 413) }), async (c) => {
    const raw = await c.req.json().catch(() => {
      throw new HttpError(400, "Body must be JSON.");
    });
    const req = renderRequestSchema.parse(raw);
    if (req.site !== BUILTIN && !(await sites.meta(req.site))) {
      throw new HttpError(404, `No site "${req.site}". Deploy one with PUT /v1/sites/${req.site}.`);
    }
    if (!(await sites.hasComposition(req.site, req.composition))) {
      throw new HttpError(404, `No composition "${req.composition}" in site "${req.site}". GET /v1/templates?site=${req.site} lists them.`);
    }
    // Built-in templates validate now, so bad props are a 400 rather than a failed job.
    if (req.site === BUILTIN && BUILTIN_TEMPLATES[req.composition]) {
      try {
        BUILTIN_TEMPLATES[req.composition].prepare(req.props);
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new HttpError(400, "Invalid props", err.issues.map((i) => ({ path: ["props", ...i.path].join("."), message: i.message })));
        }
        throw err;
      }
    }
    if (queue.isFull()) throw new HttpError(429, "The render queue is full. Try again shortly.");
    const job = store.create(req as RenderRequest & { site: string; kind: RenderKind }, {
      serveDir: await sites.serveDir(req.site),
      publicBase: requestOrigin(c, cfg),
    });
    queue.push(job.id);
    return c.json(runner.view(job, queue.position(job.id)), 202);
  });

  v1.get("/renders", (c) => c.json({ renders: store.list().map((j) => runner.view(j, queue.position(j.id))) }));

  v1.get("/renders/:id", (c) => {
    const job = store.get(c.req.param("id"));
    if (!job) throw new HttpError(404, "No such render.");
    return c.json(runner.view(job, queue.position(job.id)));
  });

  /** Cancel a queued or running render; on a finished one, delete it and its files. */
  v1.delete("/renders/:id", async (c) => {
    const id = c.req.param("id");
    const job = store.get(id);
    if (!job) throw new HttpError(404, "No such render.");
    if (!TERMINAL.has(job.status)) {
      const wasQueued = job.status === "queued";
      queue.cancel(id);
      if (wasQueued) store.update(id, { status: "canceled", error: "Canceled.", finishedAt: new Date().toISOString() });
      return c.json(runner.view(store.get(id)!));
    }
    const { rm } = await import("node:fs/promises");
    await rm(path.join(cfg.rendersDir, id), { recursive: true, force: true });
    await store.remove(id);
    return c.json({ ...runner.view(job), deleted: true });
  });

  app.route("/v1", v1);
  return app;
}
