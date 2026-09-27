#!/usr/bin/env node
/**
 * video-kit — talk to the render service (VIDEO_KIT_URL, VIDEO_KIT_API_KEY)
 * or render locally.
 *
 *   video-kit templates [--site name]
 *   video-kit sites
 *   video-kit site deploy <name> [--entry src/index.ts] [--public public] [--bundle dir] [--rspack]
 *   video-kit render <composition> [--site name] [--props file.json] [--tts provider]
 *                    [--still frame] [--out file.mp4] [--local [--entry src/index.ts] [--rspack]]
 *
 * Flags take `--name value` or `--name=value`. remotion.config.ts is not read:
 * if your bundle depends on it, run `npx remotion bundle` and pass --bundle build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createVideoKitClient, type RenderJob } from "../client/index.js";
import { renderComposition } from "./render.js";
import { bundleSite, packSite } from "./site.js";

/** Flags that never take a value. */
const SWITCHES = new Set(["local", "rspack", "help"]);

const flags = new Map<string, string>();
const positional: string[] = [];

function parseArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) {
      positional.push(argv[i]);
      continue;
    }
    const [, name, inline] = m;
    if (inline !== undefined) flags.set(name, inline);
    else if (SWITCHES.has(name)) flags.set(name, "true");
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags.set(name, argv[++i]);
    else throw new Error(`--${name} needs a value (--${name} value or --${name}=value).`);
  }
}
const flag = (name: string) => flags.get(name);

/** --still as a frame number, or undefined when absent. */
function stillFrame(): number | undefined {
  const v = flag("still");
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`--still needs a frame number (a non-negative integer), not "${v}".`);
  return Number(v);
}

function client() {
  const baseUrl = process.env.VIDEO_KIT_URL;
  const apiKey = process.env.VIDEO_KIT_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("Set VIDEO_KIT_URL and VIDEO_KIT_API_KEY to talk to the render service.");
  }
  return createVideoKitClient({ baseUrl, apiKey });
}

function progressLine(job: RenderJob) {
  const pct = Math.round(job.progress * 100);
  process.stderr.write(`\r${job.status}${job.stage ? ` · ${job.stage}` : ""} ${pct}%   `);
}

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));
  const [cmd, sub, arg] = positional;
  if (cmd === "templates") {
    console.log(JSON.stringify(await client().templates(flag("site")), null, 2));
  } else if (cmd === "sites") {
    console.log(JSON.stringify(await client().sites(), null, 2));
  } else if (cmd === "site" && sub === "deploy" && arg) {
    const dir =
      flag("bundle") ??
      (await bundleSite({
        entryPoint: flag("entry") ?? "src/index.ts",
        publicDir: flag("public") ?? "public",
        rspack: flag("rspack") === "true",
      }));
    const tarball = await packSite(dir);
    console.error(`Uploading ${(tarball.length / 1e6).toFixed(1)} MB as site "${arg}"…`);
    console.log(JSON.stringify(await client().deploySite(arg, tarball), null, 2));
  } else if (cmd === "render" && sub) {
    const props = flag("props") ? JSON.parse(readFileSync(flag("props")!, "utf8")) : {};
    const still = stillFrame();
    const out = flag("out") ?? (still !== undefined ? `${sub}.png` : `${sub}.mp4`);
    if (flag("local")) {
      const result = await renderComposition({
        entryPoint: flag("entry") ?? "src/index.ts",
        publicDir: flag("public"),
        compositionId: sub,
        inputProps: props,
        output: out,
        still: still !== undefined ? { frame: still } : undefined,
        tts: flag("tts"),
        rspack: flag("rspack") === "true",
        onProgress: (stage, p) => process.stderr.write(`\r${stage} ${Math.round(p * 100)}%   `),
      });
      console.error(`\nWrote ${result.output} (${result.durationInSeconds.toFixed(1)}s, voice: ${result.voice ?? "none"})`);
      return;
    }
    const kit = client();
    const job = await kit.renderAndWait(
      { site: flag("site"), composition: sub, props, tts: flag("tts"), kind: still !== undefined ? "still" : "video", frame: still },
      { onProgress: progressLine },
    );
    writeFileSync(out, await kit.download(job));
    console.error(`\nWrote ${out} (${job.result?.durationInSeconds.toFixed(1)}s, voice: ${job.result?.voice ?? "none"})`);
    console.log(JSON.stringify(job.result, null, 2));
  } else {
    const doc = readFileSync(new URL(import.meta.url), "utf8").split("\n");
    const start = doc.findIndex((l) => l.startsWith("/**"));
    const end = doc.findIndex((l, i) => i > start && l.trim() === "*/");
    console.error(doc.slice(start + 1, end).join("\n").replace(/^ \* ?/gm, "").trim());
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
