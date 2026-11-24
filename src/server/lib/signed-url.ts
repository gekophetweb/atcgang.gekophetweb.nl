import { createHmac, timingSafeEqual } from "node:crypto";

export type Variant = "thumb" | "large" | "original";

const sig = (secret: string, photoId: string, variant: Variant, exp: number) =>
  createHmac("sha256", secret).update(`photo:${photoId}:${variant}:${exp}`).digest("base64url");

/** Short-lived URL to a photo that works without a session (for MCP clients and emails). */
export function signPhotoUrl(baseUrl: string, secret: string, photoId: string, variant: Variant, ttlSeconds = 3600, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  return `${baseUrl}/photos/${photoId}/${variant}?exp=${exp}&sig=${sig(secret, photoId, variant, exp)}`;
}

export function verifyPhotoSignature(secret: string, photoId: string, variant: Variant, exp: string | undefined, signature: string | undefined, now = Date.now()) {
  if (!exp || !signature) return false;
  const e = Number(exp);
  if (!Number.isInteger(e) || e * 1000 < now) return false;
  const expected = Buffer.from(sig(secret, photoId, variant, e));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
