import { createHmac } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export const SERVICE_ROOT = path.resolve(import.meta.dirname, import.meta.dirname.includes(`${path.sep}dist${path.sep}`) ? "../.." : "..");

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** "::" listens on IPv4 and IPv6 (Railway's private network is IPv6). */
  HOST: z.string().default("::"),
  RENDER_API_KEY: z.string().min(16, "RENDER_API_KEY must be at least 16 characters"),
  /** Signs file URLs and webhooks. Default: derived from RENDER_API_KEY, so rotating the key revokes old URLs. */
  SIGNING_SECRET: z.string().min(16).optional(),
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
    signingSecret: c.SIGNING_SECRET ?? createHmac("sha256", c.RENDER_API_KEY).update("video-kit:signing").digest("hex"),
    publicUrl: c.PUBLIC_URL ?? (c.RAILWAY_PUBLIC_DOMAIN ? `https://${c.RAILWAY_PUBLIC_DOMAIN}` : undefined),
    /** Where the service's own headless Chrome fetches voice clips from. */
    internalUrl: `http://127.0.0.1:${c.PORT}`,
    env,
  };
}
