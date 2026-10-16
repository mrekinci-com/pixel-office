import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export function encrypt(text: string, key: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const value = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), value]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function decrypt(value: string, key: string, context: string): string {
  const [iv, tag, data] = value.split(".").map((b) => Buffer.from(b, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function equals(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function newKey(): string {
  return randomBytes(32).toString("base64url");
}
// Routing and static-file resolution must agree on the path before authorization.
export function canonicalRequestPath(url: string): string | null {
  const raw = url.split("?")[0];
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(decoded) ||
        /%2f|%5c/i.test(raw) || decoded.includes("//") ||
        decoded.split("/").some(part => part === "." || part === "..")) return null;
    return decoded;
  } catch { return null; }
}
