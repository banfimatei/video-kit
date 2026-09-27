import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/** Serve a file with Content-Length and single-range support (players and uploaders seek). */
export async function fileResponse(file: string, rangeHeader: string | undefined, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) return new Response("Not found", { status: 404 });
  const ext = file.slice(file.lastIndexOf("."));
  const headers: Record<string, string> = {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    ...extraHeaders,
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : s.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : s.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, s.size - 1);
    if (start > end || start >= s.size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${s.size}` } });
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${s.size}` },
    });
  }
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(s.size) } });
}
