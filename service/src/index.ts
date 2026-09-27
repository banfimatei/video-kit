import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { getCompositions } from "@remotion/renderer";
import { loadConfig, SERVICE_ROOT } from "./config.js";
import { JobStore, RenderQueue } from "./jobs.js";
import { sweep } from "./retention.js";
import { createRunner } from "./runner.js";
import { createApp } from "./server.js";
import { BUILTIN, Sites } from "./sites.js";

const log = (msg: string) => console.log(`[video-kit] ${msg}`);

async function main(): Promise<void> {
  // Local development: service/.env, if there is one (the image never has one; variables already set win).
  const envFile = path.join(SERVICE_ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const cfg = loadConfig();
  const { version } = JSON.parse(await readFile(path.join(SERVICE_ROOT, "package.json"), "utf8")) as { version: string };
  for (const dir of [cfg.jobsDir, cfg.rendersDir, cfg.sitesDir, cfg.voiceDir, cfg.tmpDir]) await mkdir(dir, { recursive: true });

  const store = new JobStore(cfg.jobsDir);
  const { interrupted, queued } = await store.init();
  if (interrupted) log(`marked ${interrupted} render(s) that were running at the last stop as failed`);

  const sites = new Sites(cfg, async (serveDir) =>
    (await getCompositions(serveDir, { browserExecutable: cfg.REMOTION_BROWSER_EXECUTABLE ?? null })).map((c) => ({
      id: c.id,
      width: c.width,
      height: c.height,
      fps: c.fps,
      durationInFrames: c.durationInFrames,
      defaultProps: c.defaultProps as Record<string, unknown>,
    })),
  );
  await sites.init();

  const runner = createRunner(cfg, store, log);
  const queue = new RenderQueue(cfg.RENDER_CONCURRENCY, cfg.MAX_QUEUE, runner.run, (id, err) => {
    log(`render ${id} crashed: ${(err as Error)?.message ?? String(err)}`);
    runner.finish(id, "failed", "The render crashed inside the service.");
  });
  let stopping = false;
  const app = createApp({ cfg, store, queue, sites, runner, version, draining: () => stopping });

  // Renders that were still waiting at the last stop never started: run them now.
  for (const id of queued) {
    const job = store.get(id)!;
    if (job.site === BUILTIN) store.update(id, { serveDir: cfg.builtinBundleDir }, false);
    else if (!existsSync(job.serveDir)) {
      runner.finish(id, "failed", "Its site version was deleted while it waited. Submit it again.");
      continue;
    }
    queue.push(id);
  }
  if (queued.length) log(`re-queued ${queued.length} render(s) waiting from before the restart`);
  const pending = runner.redeliver();
  if (pending) log(`delivering ${pending} webhook(s) left over from before the restart`);

  const server = createAdaptorServer({ fetch: app.fetch });
  const listen = (host: string) => server.listen(cfg.PORT, host);
  server.once("listening", () => {
    const a = server.address();
    const where = a && typeof a === "object" ? `${a.address}:${a.port}` : String(a);
    log(`listening on ${where} (data ${cfg.dataDir}, ${cfg.RENDER_CONCURRENCY} render(s) at a time)`);
    log(
      cfg.DRAINING_SECONDS > 15
        ? `on redeploy, running renders get ${cfg.DRAINING_SECONDS - 15}s to finish (draining window ${cfg.DRAINING_SECONDS}s)`
        : "on redeploy, running renders are stopped at once: set RAILWAY_DEPLOYMENT_DRAINING_SECONDS (a variable, e.g. 300) to let them finish",
    );
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    // "::" needs IPv6; fall back to IPv4 where the host has none.
    if (err.code === "EAFNOSUPPORT" && cfg.HOST === "::") listen("0.0.0.0");
    else throw err;
  });
  listen(cfg.HOST);

  const runSweep = () => sweep(cfg, store, sites, log).catch((err) => log(`retention failed: ${(err as Error).message}`));
  void runSweep();
  const timer = setInterval(runSweep, 3_600_000);
  timer.unref();

  /**
   * Railway sends SIGTERM, then SIGKILL after RAILWAY_DEPLOYMENT_DRAINING_SECONDS
   * (default 0). Within that window: take no new work, let running renders
   * finish, and only abort (as failed, "restarted") what is still running
   * near the deadline. Waiting renders stay queued on disk and run after the
   * restart. Undelivered webhooks stay pending and go out after it too.
   *
   * Remotion kills every browser it has open on SIGTERM (its own listener),
   * so a render can only outlive the signal if it isn't SIGTERM: the image's
   * dumb-init rewrites the container's SIGTERM to SIGUSR2, which means
   * "drain". A SIGTERM that reaches node directly stops at once.
   */
  const stop = async (signal: string, drain: boolean) => {
    if (stopping) return;
    stopping = true;
    const windowMs = cfg.DRAINING_SECONDS * 1000;
    const graceMs = drain ? Math.max(0, windowMs - 15_000) : 0;
    log(`${signal}: stopping; ${queue.size.running} running, ${queue.size.queued} waiting; ${Math.round(graceMs / 1000)}s to finish`);
    // Keep listening while renders drain: their Chrome fetches voice clips
    // from this server. New renders and deploys get a 503 meanwhile.
    queue.pause();
    await queue.drain(graceMs);
    if (queue.size.running) {
      log(`aborting ${queue.size.running} render(s) still running`);
      queue.abortRunning("shutdown");
      await queue.drain(Math.min(10_000, Math.max(2_000, windowMs - graceMs - 5_000)));
    }
    await runner.settle(3_000);
    await store.flush();
    server.close();
    process.exit(0);
  };
  process.on("SIGUSR2", () => void stop("SIGUSR2", true));
  process.on("SIGTERM", () => void stop("SIGTERM", false));
  process.on("SIGINT", () => void stop("SIGINT", false));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
