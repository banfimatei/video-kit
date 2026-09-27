import dns, { type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** Addresses a webhook must never reach: loopback, private, link-local, CGNAT, metadata, multicast… */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  // Not ::ffff:0:0/96: BlockList checks every IPv4 address against IPv6 rules
  // in that mapped form, so it would block all of IPv4. Mapped addresses are
  // unwrapped and judged as IPv4 below.
  ["64:ff9b::", 96], // NAT64 can reach private IPv4
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** `::ffff:7f00:1` or `::ffff:127.0.0.1` → `127.0.0.1`; null for any other address. */
function unmapIpv4(ip: string): string | null {
  let host: string;
  try {
    host = new URL(`http://[${ip}]/`).hostname.slice(1, -1); // canonical: ::ffff:7f00:1
  } catch {
    return null;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE.check(ip, "ipv4");
  if (family === 6) {
    const v4 = unmapIpv4(ip);
    return v4 ? PRIVATE.check(v4, "ipv4") : PRIVATE.check(ip, "ipv6");
  }
  return true; // not an address at all: refuse
}

const PRIVATE_NAME = /(^|\.)(localhost|internal|local|localdomain|home\.arpa)$/i;

export class UnsafeTargetError extends Error {}

/**
 * Throw unless `url` is http(s) on a host that resolves only to public
 * addresses. With `allowPrivate`, only the scheme is checked.
 */
export async function assertPublicUrl(url: string, allowPrivate = false): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UnsafeTargetError("Not a URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UnsafeTargetError("Only http(s) URLs are allowed.");
  if (u.username || u.password) throw new UnsafeTargetError("URLs with credentials are not allowed.");
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeTargetError(`${host} is a private address.`);
    return u;
  }
  if (PRIVATE_NAME.test(host.replace(/\.$/, ""))) throw new UnsafeTargetError(`${host} is a private host name.`);
  let addresses: LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new UnsafeTargetError(`${host} does not resolve (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) throw new UnsafeTargetError(`${host} resolves to a private address (${bad.address}).`);
  return u;
}

/**
 * A `lookup` for http(s).request that refuses private addresses. Checking at
 * connect time, on the address actually dialed, closes the DNS-rebinding gap
 * between assertPublicUrl() and the request.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as unknown as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) {
      const e: NodeJS.ErrnoException = new Error(`${hostname} resolves to a private address (${bad?.address ?? "none"})`);
      e.code = "EPRIVATE";
      return callback(e, "", 0);
    }
    if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

/**
 * POST a JSON body; resolves to the status code. No redirects are followed.
 * Unless `allowPrivate`, the target is re-checked and pinned to public
 * addresses for this connection.
 */
export async function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  { timeoutMs = 10_000, allowPrivate = false }: { timeoutMs?: number; allowPrivate?: boolean } = {},
): Promise<number> {
  const u = await assertPublicUrl(url, allowPrivate);
  const client = u.protocol === "https:" ? https : http;
  return new Promise<number>((resolve, reject) => {
    const req = client.request(
      u,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        lookup: allowPrivate ? undefined : publicOnlyLookup,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}
