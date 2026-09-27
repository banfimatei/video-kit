import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { TERMINAL, type JobStore } from "./jobs.js";
import type { Sites } from "./sites.js";

const DAY = 86_400_000;

/** Delete finished renders past RETENTION_DAYS, stale voice clips, old site versions and orphaned temp files. */
export async function sweep(cfg: Config, store: JobStore, sites: Sites, log: (m: string) => void): Promise<void> {
  const now = Date.now();
  let removed = 0;
  for (const job of store.all()) {
    const done = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
    if (TERMINAL.has(job.status) && now - done > cfg.RETENTION_DAYS * DAY) {
      await rm(path.join(cfg.rendersDir, job.id), { recursive: true, force: true });
      await store.remove(job.id);
      removed++;
    }
  }
  const olderThan = async (dir: string, ms: number, keep?: (name: string) => boolean) => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (keep?.(name)) continue;
      const p = path.join(dir, name);
      const s = await stat(p).catch(() => null);
      if (s && now - s.mtimeMs > ms) {
        await rm(p, { recursive: true, force: true });
        removed++;
      }
    }
  };
  await olderThan(cfg.voiceDir, cfg.VOICE_CACHE_DAYS * DAY);
  await olderThan(cfg.tmpDir, DAY);
  // Render dirs with no job record (e.g. after a crash mid-write).
  await olderThan(cfg.rendersDir, DAY, (name) => Boolean(store.get(name)));
  for (const v of await sites.staleVersions()) {
    if (v.ageMs > DAY) {
      await rm(v.dir, { recursive: true, force: true });
      removed++;
    }
  }
  if (removed) log(`retention: removed ${removed} item(s)`);
}
