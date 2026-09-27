/**
 * Turn a Remotion project into a "site" the render service can render: bundle
 * it (as `remotion bundle` would) and pack the bundle as a gzipped tarball.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

export async function bundleSite(opts: { entryPoint: string; publicDir?: string; outDir?: string }): Promise<string> {
  const { bundle } = await import("@remotion/bundler");
  return bundle({
    entryPoint: path.resolve(opts.entryPoint),
    publicDir: path.resolve(opts.publicDir ?? "public"),
    outDir: opts.outDir ? path.resolve(opts.outDir) : undefined,
    rspack: true,
  });
}

/** Gzipped tarball of a bundle directory, with paths relative to it. */
export async function packSite(bundleDir: string): Promise<Buffer> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "video-kit-site-"));
  const file = path.join(tmp, "site.tgz");
  try {
    await tar.create({ gzip: true, file, cwd: path.resolve(bundleDir), portable: true }, ["."]);
    return await readFile(file);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
