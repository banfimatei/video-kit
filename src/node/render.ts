/**
 * Render a composition from data: voice its narration, then bundle (or reuse
 * an already-bundled site), select the composition with the props, render
 * the video (or a still) and a poster. The one call both a local project and
 * the render service go through.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { WebpackOverrideFn } from "@remotion/bundler";
import type { Narration, Voiceover } from "../schema.js";
import { pickTtsProvider, voiceNarration, type TtsProvider } from "./tts.js";

type Props = Record<string, unknown>;
type Env = Record<string, string | undefined>;

export type RenderStage = "voicing" | "bundling" | "selecting" | "rendering" | "poster";

export interface RenderCompositionOptions {
  /** A Remotion entry point to bundle (e.g. src/index.ts). Give this or serveUrl. */
  entryPoint?: string;
  /** Public dir to bundle with `entryPoint`; voice clips land in `<publicDir>/voiceover`. Default ./public. */
  publicDir?: string;
  /** With `entryPoint`: what remotion.config.ts's overrideWebpackConfig would do (the config file isn't read). */
  webpackOverride?: WebpackOverrideFn;
  /** With `entryPoint`: bundle with Rspack instead of webpack. */
  rspack?: boolean;
  /** An already-bundled site: a `remotion bundle` directory or an http(s) URL. */
  serveUrl?: string;
  compositionId: string;
  inputProps: Props;
  /** Output file: .mp4 for a video, .png for a still. */
  output: string;
  /** Render one frame as PNG instead of a video. */
  still?: { frame: number };
  /** Also write `<output stem>.poster.png` at this frame (videos only). Default frame 60, clamped; false for none. */
  poster?: { frame: number } | false;
  /** TTS provider, "none", or undefined to pick by whichever key is set. */
  tts?: string | null;
  /** Where the composition's narration lives. Default `props.narration`. */
  narrationOf?: (props: Props) => Narration | undefined;
  /** How voiced clips go back into props. Default `{ ...props, voiceover }`. */
  withVoiceover?: (props: Props, voiceover: Voiceover) => Props;
  /**
   * Where clips are written and how the composition reaches them. Defaults
   * suit `entryPoint` (the public dir, `voiceover/<file>`); with a prebuilt
   * `serveUrl`, pass a directory and an http URL builder.
   */
  voice?: { dir: string; toSrc: (file: string) => string };
  browserExecutable?: string | null;
  /** Refuse compositions longer than this (after calculateMetadata). */
  maxDurationInSeconds?: number;
  concurrency?: number | string | null;
  onProgress?: (stage: RenderStage, progress: number) => void;
  env?: Env;
  /** Abort a running render. */
  signal?: AbortSignal;
}

export interface RenderCompositionResult {
  output: string;
  poster: string | null;
  /** The props actually rendered, voiceover included. */
  props: Props;
  voice: TtsProvider | null;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  durationInSeconds: number;
}

function defaultNarration(props: Props): Narration | undefined {
  const n = props.narration;
  if (!n || typeof n !== "object" || Array.isArray(n)) return undefined;
  return n as Narration;
}

export async function renderComposition(opts: RenderCompositionOptions): Promise<RenderCompositionResult> {
  if (!opts.entryPoint === !opts.serveUrl) {
    throw new Error("renderComposition: give exactly one of entryPoint or serveUrl.");
  }
  const env = opts.env ?? process.env;
  const progress = opts.onProgress ?? (() => undefined);
  const signal = opts.signal;
  // Between stages: Remotion only cancels renderMedia/renderStill themselves.
  const checkpoint = () => signal?.throwIfAborted();
  checkpoint();
  const publicDir = path.resolve(opts.publicDir ?? "public");
  let props = opts.inputProps;

  // Voice first: with an entry point, the clips must be in public/ before bundle() copies it.
  let provider: TtsProvider | null = null;
  const narration = (opts.narrationOf ?? defaultNarration)(props);
  if (narration && !props.voiceover && Object.values(narration).some((t) => t && t.trim())) {
    provider = pickTtsProvider(opts.tts, env);
    if (provider) {
      progress("voicing", 0);
      const voice = opts.voice ?? {
        dir: path.join(publicDir, "voiceover"),
        toSrc: (file: string) => `voiceover/${file}`,
      };
      if (!opts.voice && opts.serveUrl) {
        throw new Error("renderComposition: voicing a prebuilt serveUrl needs `voice` (a dir and an http URL builder).");
      }
      const voiceover = await voiceNarration(narration, { provider, dir: voice.dir, toSrc: voice.toSrc, env, signal });
      props = (opts.withVoiceover ?? ((p, v) => ({ ...p, voiceover: v })))(props, voiceover);
      progress("voicing", 1);
    }
  }

  const { renderMedia, renderStill, selectComposition } = await import("@remotion/renderer");
  let serveUrl = opts.serveUrl;
  checkpoint();
  if (opts.entryPoint) {
    const { bundle } = await import("@remotion/bundler");
    progress("bundling", 0);
    serveUrl = await bundle({
      entryPoint: path.resolve(opts.entryPoint),
      publicDir,
      webpackOverride: opts.webpackOverride,
      rspack: opts.rspack ?? false,
      onProgress: (p) => progress("bundling", p / 100),
    });
  }

  checkpoint();
  progress("selecting", 0);
  const browserExecutable = opts.browserExecutable ?? env.REMOTION_BROWSER_EXECUTABLE ?? null;
  const composition = await selectComposition({
    serveUrl: serveUrl!,
    id: opts.compositionId,
    inputProps: props,
    browserExecutable,
  });
  const seconds = composition.durationInFrames / composition.fps;
  if (opts.maxDurationInSeconds && !opts.still && seconds > opts.maxDurationInSeconds) {
    throw new Error(
      `Composition "${opts.compositionId}" is ${seconds.toFixed(1)}s; the limit is ${opts.maxDurationInSeconds}s.`,
    );
  }

  checkpoint();
  const output = path.resolve(opts.output);
  await mkdir(path.dirname(output), { recursive: true });
  const cancel = signal ? await cancelSignalFrom(signal) : undefined;

  let poster: string | null = null;
  if (opts.still) {
    const frame = Math.min(Math.max(0, Math.round(opts.still.frame)), composition.durationInFrames - 1);
    progress("rendering", 0);
    await renderStill({
      composition,
      serveUrl: serveUrl!,
      output,
      frame,
      inputProps: props,
      browserExecutable,
      imageFormat: "png",
      cancelSignal: cancel,
    });
    progress("rendering", 1);
  } else {
    await renderMedia({
      composition,
      serveUrl: serveUrl!,
      codec: "h264",
      // PNG frames: standard-range yuv420p, no JPEG artifacts on type, smaller files.
      imageFormat: "png",
      outputLocation: output,
      inputProps: props,
      browserExecutable,
      concurrency: opts.concurrency ?? null,
      cancelSignal: cancel,
      onProgress: ({ progress: p }) => progress("rendering", p),
    });
    if (opts.poster !== false) {
      checkpoint();
      const frame = Math.min(opts.poster?.frame ?? 60, composition.durationInFrames - 1);
      poster = output.replace(/\.[^./]+$/, "") + ".poster.png";
      progress("poster", 0);
      await renderStill({
        composition,
        serveUrl: serveUrl!,
        output: poster,
        frame,
        inputProps: props,
        browserExecutable,
        imageFormat: "png",
        cancelSignal: cancel,
      });
      progress("poster", 1);
    }
  }
  // Canceled after the last frame: the caller asked for no result, so don't report one.
  checkpoint();

  return {
    output,
    poster,
    props,
    voice: provider,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
    durationInSeconds: seconds,
  };
}

/** Bridge an AbortSignal to Remotion's cancel signal. */
async function cancelSignalFrom(signal: AbortSignal) {
  const { makeCancelSignal } = await import("@remotion/renderer");
  const { cancelSignal, cancel } = makeCancelSignal();
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", () => cancel(), { once: true });
  return cancelSignal;
}
