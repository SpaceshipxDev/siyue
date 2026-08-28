// Offline "is this IP in the United States?" — binary search over a merged
// range table (ipdeny aggregated US zone, IPv4 + IPv6/64). No network, no
// native deps, no MaxMind licence. Any parse failure → false (Chinese UI),
// so a bad header can never change what a Chinese user sees.
import ranges from "./us-ranges.json";

const V4: number[] = ranges.v4;
let V6: bigint[] | null = null;

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = +m[i];
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

function ipv6Hi64(ip: string): bigint | null {
  // Expand :: then take the first four hextets.
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  let [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  let parts: string[];
  if (ip.includes("::")) {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    parts = [...h, ...Array(fill).fill("0"), ...t];
  } else parts = h;
  if (parts.length !== 8) return null;
  try {
    return BigInt("0x" + parts.slice(0, 4).map((x) => x.padStart(4, "0")).join(""));
  } catch {
    return null;
  }
}

function inRanges4(n: number): boolean {
  let lo = 0, hi = V4.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = V4[mid * 2], e = V4[mid * 2 + 1];
    if (n < s) hi = mid - 1;
    else if (n > e) lo = mid + 1;
    else return true;
  }
  return false;
}

function inRanges6(n: bigint): boolean {
  if (!V6) V6 = (ranges.v6 as string[]).map((x) => BigInt("0x" + x));
  let lo = 0, hi = V6.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = V6[mid * 2], e = V6[mid * 2 + 1];
    if (n < s) hi = mid - 1;
    else if (n > e) lo = mid + 1;
    else return true;
  }
  return false;
}

export function isUsIp(raw: string | null | undefined): boolean {
  try {
    if (!raw) return false;
    let ip = raw.trim();
    if (ip.startsWith("[")) ip = ip.slice(1, ip.indexOf("]"));
    if (ip.startsWith("::ffff:")) ip = ip.slice(7);
    const v4 = ipv4ToInt(ip);
    if (v4 !== null) return inRanges4(v4);
    if (ip.includes(":")) {
      const hi = ipv6Hi64(ip);
      return hi !== null && inRanges6(hi);
    }
    return false;
  } catch {
    return false;
  }
}

/** Client IP as Caddy hands it to us: last hop of X-Forwarded-For (Caddy
 *  replaces untrusted incoming XFF with the real peer), else X-Real-IP. */
export function clientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return headers.get("x-real-ip");
}
