import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time compare of two secrets of any length (hash first, so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m ? m[1].trim() : null;
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** `?exp=<unix seconds>&sig=<hmac(path|exp)>` for a file path, valid for `ttlSeconds`. */
export function signPath(secret: string, filePath: string, ttlSeconds: number, now = Date.now()) {
  const exp = Math.floor(now / 1000) + Math.floor(ttlSeconds);
  return { exp, query: `exp=${exp}&sig=${sign(secret, `${filePath}|${exp}`)}` };
}

/**
 * True for a valid, unexpired signature. `maxTtlSeconds` refuses links that
 * expire further out than the service ever issues, so a leaked key can't
 * mint links that last forever.
 */
export function verifySignedPath(
  secret: string,
  filePath: string,
  exp: string | undefined,
  sig: string | undefined,
  { now = Date.now(), maxTtlSeconds }: { now?: number; maxTtlSeconds?: number } = {},
): boolean {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  const expMs = Number(exp) * 1000;
  if (expMs < now) return false;
  if (maxTtlSeconds !== undefined && expMs > now + maxTtlSeconds * 1000) return false;
  return safeEqual(sign(secret, `${filePath}|${exp}`), sig);
}

/** Webhook body signature: `sha256=<hex hmac>` in X-Video-Kit-Signature. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
