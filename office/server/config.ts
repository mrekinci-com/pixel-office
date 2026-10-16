import { translate, languageFrom } from "../shared/i18n/index.js";
import { resolve } from "node:path";
import { privateAddress } from './tududi-proxy.js';
export interface Config {
  port: number;
  dataDir: string;
  ownerPassword: string;
  secretKey: string;
  secureCookie: boolean;
  tududiUrl: string;
  tududiAdminEmail: string;
  tududiAdminPassword: string;
  publicOrigin?: string;
  tududiPublicUrl?: string;
  runnerKey?: string;
  tududiEmailDomain?: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const t = (key: string) => translate(languageFrom(env.LANG || "tr"),key);
  const secretKey = env.OFIS_SECRET_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(secretKey))
    throw new Error(t("OFIS_SECRET_KEY 64 haneli onaltılık bir anahtar olmalı."));
  const ownerPassword = env.OFIS_OWNER_PASSWORD || "";
  if (ownerPassword.length < 12)
    throw new Error(t("OFIS_OWNER_PASSWORD en az 12 karakter olmalı."));
  if (env.OFIS_RUNNER_KEY && env.OFIS_RUNNER_KEY.length < 32)
    throw new Error(t("OFIS_RUNNER_KEY en az 32 karakter olmalı."));
  const port = Number(env.PORT || 9400);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(t("PORT geçersiz."));
  const url = new URL(env.TUDUDI_BASE_URL || "http://127.0.0.1:9393");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port === "9292"
  )
    throw new Error(t("Tududi adresi geçersiz; kişisel Tududi kullanılamaz."));
  const publicUrl = env.OFIS_PUBLIC_URL ? new URL(env.OFIS_PUBLIC_URL) : null;
  if (
    publicUrl &&
    (!["http:", "https:"].includes(publicUrl.protocol) ||
      publicUrl.username ||
      publicUrl.password)
  )
    throw new Error(t("OFIS_PUBLIC_URL geçersiz."));
  const tududiPublic = env.TUDUDI_PUBLIC_URL ? new URL(env.TUDUDI_PUBLIC_URL) : null;
  if(tududiPublic && (!['http:','https:'].includes(tududiPublic.protocol) || !privateAddress(tududiPublic.hostname) || tududiPublic.username || tududiPublic.password || ['9292','9393'].includes(tududiPublic.port))) throw new Error(t('TUDUDI_PUBLIC_URL ayrı vekilin özel ağ adresi olmalı.'));
  const emailDomain=env.TUDUDI_EMAIL_DOMAIN;
  if(emailDomain && !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(emailDomain))throw new Error(t('Tududi e-posta alan adı geçersiz.'));
  return {
    port,
    tududiEmailDomain:emailDomain,
    dataDir: resolve(env.OFIS_DATA_DIR || "data"),
    ownerPassword,
    secretKey,
    secureCookie: publicUrl?.protocol === "https:" || env.OFIS_COOKIE_SECURE === "true",
    tududiUrl: url.origin,
    tududiAdminEmail: env.TUDUDI_ADMIN_EMAIL || "",
    tududiAdminPassword: env.TUDUDI_ADMIN_PASSWORD || "",
    publicOrigin: publicUrl?.origin,
    tududiPublicUrl: tududiPublic?.origin,
    runnerKey: env.OFIS_RUNNER_KEY || "",
  };
}
