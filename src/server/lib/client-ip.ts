/**
 * Real client IP. Behind the Cloudflare Tunnel the only way into `web` is cloudflared,
 * so CF-Connecting-IP can be trusted; otherwise fall back to the first X-Forwarded-For hop.
 */
export function clientIp(headers: Headers, trustCf: boolean): string {
  if (trustCf) {
    const cf = headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
  }
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}
