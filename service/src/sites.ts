import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { SiteInfo, TemplateInfo } from "@banfimatei/video-kit/client";
import * as tar from "tar";
import type { Config } from "./config.js";

export const BUILTIN = "builtin";
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface SiteMeta extends SiteInfo {
  current: string;
  templates: TemplateInfo[];
  /** Earlier versions and when each stopped being current (retention ages them from then). */
  retired?: Record<string, string>;
}

type Composition = Omit<TemplateInfo, "site" | "schema">;

/**
 * Sites are `remotion bundle` outputs uploaded by projects, stored as
 * versions under DATA/sites/<name>/<version>/. A render captures the version
 * directory when it is submitted, so redeploying a site never swaps files
 * under a render in progress; old versions are swept by retention.
 */
export class Sites {
  private builtin: Composition[] = [];
  /** Deploys run one at a time: each unpacks up to 4× MAX_SITE_MB and starts a Chrome. */
  private deploying: Promise<unknown> = Promise.resolve();

  constructor(
    private cfg: Config,
    private listCompositions: (serveDir: string) => Promise<Composition[]>,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.cfg.sitesDir, { recursive: true });
    await mkdir(this.cfg.tmpDir, { recursive: true });
    if (!existsSync(path.join(this.cfg.builtinBundleDir, "index.html"))) {
      throw new Error(`No built-in bundle at ${this.cfg.builtinBundleDir}. Run \`npm run bundle\` in service/.`);
    }
    this.builtin = await this.listCompositions(this.cfg.builtinBundleDir);
  }

  static validName(name: string): boolean {
    return NAME.test(name) && name !== BUILTIN;
  }

  private metaFile(name: string) {
    return path.join(this.cfg.sitesDir, name, "meta.json");
  }

  async meta(name: string): Promise<SiteMeta | null> {
    if (!Sites.validName(name)) return null;
    try {
      return JSON.parse(await readFile(this.metaFile(name), "utf8")) as SiteMeta;
    } catch {
      return null;
    }
  }

  /** The directory to render `site` from right now. */
  async serveDir(site: string): Promise<string> {
    if (site === BUILTIN) return this.cfg.builtinBundleDir;
    const meta = await this.meta(site);
    if (!meta) throw new HttpError(404, `No site "${site}". Deploy one with PUT /v1/sites/${site}.`);
    return path.join(this.cfg.sitesDir, site, meta.current);
  }

  async hasComposition(site: string, id: string): Promise<boolean> {
    const list = site === BUILTIN ? this.builtin : (await this.meta(site))?.templates;
    return Boolean(list?.some((c) => c.id === id));
  }

  async templates(site: string, schemaOf: (id: string) => unknown): Promise<TemplateInfo[]> {
    if (site === BUILTIN) return this.builtin.map((c) => ({ ...c, site: BUILTIN, schema: schemaOf(c.id) }));
    const meta = await this.meta(site);
    if (!meta) throw new HttpError(404, `No site "${site}".`);
    return meta.templates;
  }

  async list(): Promise<SiteInfo[]> {
    const out: SiteInfo[] = [];
    for (const name of await readdir(this.cfg.sitesDir)) {
      const meta = await this.meta(name);
      if (meta) out.push({ name: meta.name, uploadedAt: meta.uploadedAt, bytes: meta.bytes, compositions: meta.compositions });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Store a gzipped tarball of a bundle as a new version of `name`: stream it
   * to disk under a size cap, extract only plain files and directories inside
   * the target, check it is a Remotion bundle by listing its compositions,
   * then point the site at it.
   */
  deploy(name: string, body: WebReadableStream<Uint8Array> | null): Promise<SiteInfo> {
    const run = this.deploying.then(() => this.deployNow(name, body));
    this.deploying = run.catch(() => undefined);
    return run;
  }

  private async deployNow(name: string, body: WebReadableStream<Uint8Array> | null): Promise<SiteInfo> {
    if (!Sites.validName(name)) {
      throw new HttpError(400, `Site names are lowercase letters, digits and dashes (max 63), and "${BUILTIN}" is reserved.`);
    }
    if (!body) throw new HttpError(400, "Send the site as a gzipped tarball in the request body.");
    const limit = this.cfg.MAX_SITE_MB * 1024 * 1024;
    const version = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const upload = path.join(this.cfg.tmpDir, `${version}.tgz`);
    const siteDir = path.join(this.cfg.sitesDir, name);
    const partial = path.join(siteDir, `.${version}.partial`);
    let bytes = 0;
    try {
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > limit) cb(new HttpError(413, `Site is over MAX_SITE_MB (${limit / 1024 / 1024} MB).`));
          else cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(body), counter, createWriteStream(upload));
      if (bytes === 0) throw new HttpError(400, "Empty upload.");

      await mkdir(partial, { recursive: true });
      // Never throw from inside tar's filter: it runs in a stream callback, so a
      // throw escapes the promise and takes the process down. Flag and skip.
      let unpacked = 0;
      let tooBig = false;
      let unsafe = "";
      await tar
        .x({
          file: upload,
          cwd: partial,
          strict: true,
          preservePaths: false,
          // Deploy time, not the archive's, so directory ages mean something here.
          noMtime: true,
          filter: (p, entry) => {
            const type = "type" in entry ? entry.type : undefined;
            if (type !== "File" && type !== "Directory" && type !== "OldFile") return false;
            const target = path.resolve(partial, p);
            if (path.isAbsolute(p) || (target !== partial && !target.startsWith(partial + path.sep))) {
              unsafe ||= p;
              return false;
            }
            unpacked += "size" in entry && typeof entry.size === "number" ? entry.size : 0;
            if (unpacked > limit * 4) tooBig = true;
            return !tooBig;
          },
        })
        .catch((err: unknown) => {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, `Not a readable gzipped tarball: ${(err as Error).message}`);
        });
      if (unsafe) throw new HttpError(400, `The tarball has a path outside its root (${unsafe.slice(0, 100)}); refusing it.`);
      if (tooBig) throw new HttpError(413, "Site unpacks to more than 4× MAX_SITE_MB.");
      if (!existsSync(path.join(partial, "index.html"))) {
        throw new HttpError(400, "No index.html at the tarball root: upload the output of `remotion bundle` (tar -czf site.tgz -C build .).");
      }
      let compositions: Composition[];
      try {
        compositions = await this.listCompositions(partial);
      } catch (err) {
        throw new HttpError(400, `The bundle did not load as a Remotion project: ${(err as Error).message.slice(0, 500)}`);
      }
      const finalDir = path.join(siteDir, version);
      await rename(partial, finalDir);
      const previous = await this.meta(name);
      const now = new Date().toISOString();
      const meta: SiteMeta = {
        name,
        uploadedAt: now,
        bytes,
        compositions: compositions.map((c) => c.id),
        current: version,
        templates: compositions.map((c) => ({ ...c, site: name })),
        retired: previous ? retiredVersions(siteDir, previous, now) : undefined,
      };
      const tmpMeta = `${this.metaFile(name)}.${version}.tmp`;
      await writeFile(tmpMeta, JSON.stringify(meta));
      await rename(tmpMeta, this.metaFile(name));
      return { name, uploadedAt: meta.uploadedAt, bytes, compositions: meta.compositions };
    } finally {
      await rm(upload, { force: true });
      await rm(partial, { recursive: true, force: true });
    }
  }

  /**
   * Delete a site. Refused (409) while `inUse` says a queued or running
   * render still reads one of its versions. Waits for any deploy in flight.
   */
  async remove(name: string, inUse: (serveDir: string) => boolean): Promise<boolean> {
    const run = this.deploying.then(async () => {
      if (!Sites.validName(name) || !(await this.meta(name))) return false;
      const siteDir = path.join(this.cfg.sitesDir, name);
      for (const v of await readdir(siteDir).catch(() => [] as string[])) {
        if (inUse(path.join(siteDir, v))) {
          throw new HttpError(409, `Site "${name}" has renders queued or running; cancel them or wait, then delete it.`);
        }
      }
      await rm(siteDir, { recursive: true, force: true });
      return true;
    });
    this.deploying = run.catch(() => undefined);
    return run;
  }

  /** Versions other than a site's current one, with the time since each was replaced. */
  async staleVersions(): Promise<Array<{ dir: string; ageMs: number }>> {
    const out: Array<{ dir: string; ageMs: number }> = [];
    for (const name of await readdir(this.cfg.sitesDir).catch(() => [] as string[])) {
      const meta = await this.meta(name);
      if (!meta) continue;
      for (const v of await readdir(path.join(this.cfg.sitesDir, name)).catch(() => [] as string[])) {
        // Orphaned `.partial` dirs from a crashed deploy age out here too (by mtime).
        if (v === meta.current || v === "meta.json" || v.endsWith(".tmp")) continue;
        const dir = path.join(this.cfg.sitesDir, name, v);
        const s = await stat(dir).catch(() => null);
        if (!s?.isDirectory()) continue;
        const retiredAt = meta.retired?.[v] ? Date.parse(meta.retired[v]) : s.mtimeMs;
        out.push({ dir, ageMs: Date.now() - retiredAt });
      }
    }
    return out;
  }
}

/** The previous meta's retired versions that still exist, plus its current one, retired now. */
function retiredVersions(siteDir: string, previous: SiteMeta, now: string): Record<string, string> {
  const kept = Object.entries(previous.retired ?? {}).filter(([v]) => existsSync(path.join(siteDir, v)));
  return { ...Object.fromEntries(kept), [previous.current]: now };
}
