/**
 * Paint the poster still over frame 0 of an mp4.
 *
 * Players and social sites that ignore cover art thumbnail the first frame,
 * which is often a fade from black. Replacing that one frame (same count,
 * audio copied) makes the idle image the poster. At 30fps it shows for
 * 1/30s, then the edit plays as rendered.
 *
 * Needs ffmpeg: the image has it, and a machine with ffmpeg on PATH or
 * Remotion's own binary does too. Without one, the mp4 is left as rendered
 * and the poster png still sits beside it.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function bakePosterFrame(video: string, poster: string, signal?: AbortSignal): Promise<void> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    console.warn("video-kit: ffmpeg not found, so the poster was not baked into frame 0. The poster png is unchanged.");
    return;
  }
  const tmp = `${video}.${randomUUID()}.poster.mp4`;
  try {
    await exec(
      ffmpeg,
      [
        "-y",
        "-i",
        video,
        "-i",
        poster,
        "-filter_complex",
        "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]",
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        tmp,
      ],
      { signal, timeout: 600_000 },
    );
    const { rename } = await import("node:fs/promises");
    await rename(tmp, video);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.warn(`video-kit: left the mp4 as rendered; frame 0 was not replaced (${message}).`);
  }
}

async function findFfmpeg(): Promise<string | null> {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && (await canRun(fromEnv))) return fromEnv;
  if (await canRun("ffmpeg")) return "ffmpeg";
  try {
    const { RenderInternals } = await import("@remotion/renderer");
    const bin = RenderInternals.getExecutablePath({
      type: "ffmpeg",
      indent: false,
      logLevel: "error",
      binariesDirectory: null,
    });
    return (await canRun(bin)) ? bin : null;
  } catch {
    return null;
  }
}

function canRun(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ["-version"], (err) => resolve(!err));
  });
}
