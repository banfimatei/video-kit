import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { getCompositions } from "@remotion/renderer";
import { loadConfig, SERVICE_ROOT } from "./config.js";
import { JobStore, RenderQueue } from "./jobs.js";
import { sweep } from "./retention.js";
import { createRunner } from "./runner.js";
import { createApp } from "./server.js";
import { Sites } from "./sites.js";

const log = (msg: string) => console.log(`[video-kit] ${msg}`);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { version } = JSON.parse(await readFile(path.join(SERVICE_ROOT, "package.json"), "utf8")) as { version: string };
  for (const dir of [cfg.jobsDir, cfg.rendersDir, cfg.sitesDir, cfg.voiceDir, cfg.tmpDir]) await mkdir(dir, { recursive: true });

  const store = new JobStore(cfg.jobsDir);
  const interrupted = await store.init();
  if (interrupted) log(`marked ${interrupted} interrupted render(s) failed`);

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
  const queue = new RenderQueue(cfg.RENDER_CONCURRENCY, cfg.MAX_QUEUE, runner.run);
  const app = createApp({ cfg, store, queue, sites, runner, version });

  const server = createAdaptorServer({ fetch: app.fetch });
  const listen = (host: string) => server.listen(cfg.PORT, host);
  server.once("listening", () => {
    const a = server.address();
    const where = a && typeof a === "object" ? `${a.address}:${a.port}` : String(a);
    log(`listening on ${where} (data ${cfg.dataDir}, ${cfg.RENDER_CONCURRENCY} render(s) at a time)`);
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

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping; aborting ${queue.size.running} running render(s)`);
    server.close();
    queue.abortAll();
    await queue.drain(10_000);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
