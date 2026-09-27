import { createHmac } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export const SERVICE_ROOT = path.resolve(import.meta.dirname, import.meta.dirname.includes(`${path.sep}dist${path.sep}`) ? "../.." : "..");

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** "::" listens on IPv4 and IPv6 (Railway's private network is IPv6). */
  HOST: z.string().default("::"),
  RENDER_API_KEY: z.string().min(16, "RENDER_API_KEY must be at least 16 characters"),
  /** Signs file URLs. Default: derived from RENDER_API_KEY, so rotating the key revokes old URLs. */
  SIGNING_SECRET: z.string().min(16).optional(),
  /**
   * Signs webhook bodies; receivers hold it. Default: derived from
   * RENDER_API_KEY (see webhookSecretFromApiKey in the client). Separate from
   * SIGNING_SECRET, so a receiver can never mint file links.
   */
  WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Allow webhooks and template media URLs on private addresses (e.g. *.railway.internal siblings). Off: public hosts only. */
  ALLOW_PRIVATE_URLS: z
    .enum(["0", "1", "true", "false"])
    .default("0")
    .transform((v) => v === "1" || v === "true"),
  /** Public base for file URLs. Default https://$RAILWAY_PUBLIC_DOMAIN, else the request's own origin. */
  PUBLIC_URL: z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  DATA_DIR: z.string().default(path.join(SERVICE_ROOT, ".data")),
  BUILTIN_BUNDLE_DIR: z.string().default(path.join(SERVICE_ROOT, "bundle")),
  /** Renders run at once. Each is a headless Chrome; keep this at 1 unless the box has the RAM. */
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** Remotion's per-render frame concurrency (browser tabs). Default: Remotion's own (half the cores). */
  FRAME_CONCURRENCY: z.coerce.number().int().min(1).max(32).optional(),
  MAX_QUEUE: z.coerce.number().int().min(1).default(25),
  MAX_RENDER_SECONDS: z.coerce.number().positive().default(180),
  /**
   * Seconds between SIGTERM and SIGKILL on a redeploy; running renders get
   * this long to finish. Railway's own variable of the same meaning is read
   * when this isn't set.
   */
  DRAINING_SECONDS: z.coerce.number().min(0).optional(),
  RAILWAY_DEPLOYMENT_DRAINING_SECONDS: z.coerce.number().min(0).default(0),
  /** A job (voicing, selecting, rendering, poster) that runs longer than this is failed. */
  JOB_TIMEOUT_MINUTES: z.coerce.number().positive().default(45),
  /** Narration a render may ask the service to voice: total characters and lines. */
  MAX_NARRATION_CHARS: z.coerce.number().int().positive().default(12_000),
  MAX_NARRATION_LINES: z.coerce.number().int().positive().default(40),
  MAX_SITE_MB: z.coerce.number().positive().default(300),
  MAX_BODY_KB: z.coerce.number().positive().default(1024),
  RETENTION_DAYS: z.coerce.number().positive().default(7),
  VOICE_CACHE_DAYS: z.coerce.number().positive().default(30),
  URL_TTL_HOURS: z.coerce.number().positive().default(24 * 7),
  REMOTION_BROWSER_EXECUTABLE: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Bad configuration: ${issues}`);
  }
  const c = parsed.data;
  const dataDir = path.resolve(c.DATA_DIR);
  return {
    ...c,
    dataDir,
    jobsDir: path.join(dataDir, "jobs"),
    rendersDir: path.join(dataDir, "renders"),
    sitesDir: path.join(dataDir, "sites"),
    voiceDir: path.join(dataDir, "voice"),
    tmpDir: path.join(dataDir, "tmp"),
    builtinBundleDir: path.resolve(c.BUILTIN_BUNDLE_DIR),
    signingSecret: c.SIGNING_SECRET ?? createHmac("sha256", c.RENDER_API_KEY).update("video-kit:files").digest("hex"),
    DRAINING_SECONDS: c.DRAINING_SECONDS ?? c.RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
    webhookSecret: c.WEBHOOK_SECRET ?? createHmac("sha256", c.RENDER_API_KEY).update("video-kit:webhook").digest("hex"),
    /** Longest a file link may live: what the service issues, plus clock slack. */
    maxLinkSeconds: c.URL_TTL_HOURS * 3600 + 300,
    publicUrl: c.PUBLIC_URL ?? (c.RAILWAY_PUBLIC_DOMAIN ? `https://${c.RAILWAY_PUBLIC_DOMAIN}` : undefined),
    /** Where the service's own headless Chrome fetches voice clips from. */
    internalUrl: `http://127.0.0.1:${c.PORT}`,
    env,
  };
}
