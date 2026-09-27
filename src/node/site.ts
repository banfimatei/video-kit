/**
 * Turn a Remotion project into a "site" the render service can render: bundle
 * it and pack the bundle as a gzipped tarball.
 *
 * Unlike `remotion bundle`, this doesn't read remotion.config.ts (Remotion's
 * bundler API can't). Pass `webpackOverride` for what the config did, or run
 * `npx remotion bundle` yourself and pack that directory.
 */
import type { WebpackOverrideFn } from "@remotion/bundler";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

export interface BundleSiteOptions {
  entryPoint: string;
  publicDir?: string;
  outDir?: string;
  /** What remotion.config.ts's Config.overrideWebpackConfig would do. */
  webpackOverride?: WebpackOverrideFn;
  /** Bundle with Rspack (faster; Remotion calls it experimental). Default: webpack, like `remotion bundle`. */
  rspack?: boolean;
}

export async function bundleSite(opts: BundleSiteOptions): Promise<string> {
  const { bundle } = await import("@remotion/bundler");
  return bundle({
    entryPoint: path.resolve(opts.entryPoint),
    publicDir: path.resolve(opts.publicDir ?? "public"),
    outDir: opts.outDir ? path.resolve(opts.outDir) : undefined,
    webpackOverride: opts.webpackOverride,
    rspack: opts.rspack ?? false,
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
