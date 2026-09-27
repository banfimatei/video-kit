import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/**
 * A file body that opens its descriptor on first read and closes it on
 * cancel, so a HEAD, a client that hangs up early, or a response nobody
 * reads never leaks one.
 */
function lazyFileStream(file: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Buffer> | undefined;
  let node: ReturnType<typeof createReadStream> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!node) {
          node = createReadStream(file, range);
          iterator = node[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
        }
        const { value, done } = await iterator!.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      },
      cancel() {
        node?.destroy();
      },
    },
    { highWaterMark: 0 },
  );
}

/** `attachment`/`inline` with an ASCII fallback and an RFC 5987 UTF-8 name (non-ASCII in a header is a crash). */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Serve a file with Content-Length and single-range support (players and uploaders seek). HEAD gets headers only. */
export async function fileResponse(
  file: string,
  req: { method: string; range?: string },
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) return new Response("Not found", { status: 404 });
  const head = req.method === "HEAD";
  const ext = file.slice(file.lastIndexOf("."));
  const headers: Record<string, string> = {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    ...extraHeaders,
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.range ?? "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : s.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : s.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, s.size - 1);
    if (start > end || start >= s.size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${s.size}` } });
    }
    return new Response(head ? null : lazyFileStream(file, { start, end }), {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${s.size}` },
    });
  }
  return new Response(head ? null : lazyFileStream(file), {
    status: 200,
    headers: { ...headers, "Content-Length": String(s.size) },
  });
}
