import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { bakePosterFrame } from "../src/node/poster.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function ffmpeg(): Promise<boolean> {
  try {
    await exec("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Mean red of one frame, as raw rgb24. */
async function meanRed(file: string, frame: number): Promise<number> {
  const { stdout } = await exec(
    "ffmpeg",
    ["-i", file, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 },
  );
  const buf = stdout as unknown as Buffer;
  let red = 0;
  const pixels = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) red += buf[i];
  return red / pixels;
}

describe("bakePosterFrame", () => {
  it("paints the poster over frame 0 and leaves the next frame and the audio", async () => {
    if (!(await ffmpeg())) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), "vk-poster-"));
    dirs.push(dir);
    const video = path.join(dir, "video.mp4");
    const poster = path.join(dir, "poster.png");
    await exec("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=16x16:d=0.4:r=10",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:d=0.4",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      video,
    ]);
    await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=16x16:d=0.1", "-frames:v", "1", poster]);
    const before = await readFile(video);
    await bakePosterFrame(video, poster);
    const after = await readFile(video);
    expect(after.equals(before)).toBe(false);
    expect(await meanRed(video, 0)).toBeGreaterThan(180);
    expect(await meanRed(video, 1)).toBeLessThan(40);
    const probe = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", video]);
    expect(probe.stdout).toContain("audio");
  });
});
