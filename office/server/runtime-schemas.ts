import { directorOperations, defaultDirectorSettings, toolGroups } from "../shared/director.js";
import { z } from "zod";
import { defaultPolicy, defaultSettings } from "../shared/runtime.js";
export const policySchema = z
  .object({
    permission: z
      .enum(["chat", "workspace", "folders"])
      .default(defaultPolicy.permission),
    commands: z.boolean().default(false),
    network: z.boolean().default(false),
    timeoutMinutes: z.number().int().min(1).max(60).default(15),
    maxCalls: z.number().int().min(1).max(500).default(80),
    dailyRuns: z.number().int().min(1).max(1000).default(50),
    dailyMinutes: z.number().int().min(1).max(1440).default(120),
    sessionTurnLimit: z.number().int().min(1).max(10000).nullable().optional(),
    sessionTokenLimit: z.number().int().min(1).max(1000000000).nullable().optional(),
    inputTokenBudget: z.number().int().min(1).max(100000000).default(defaultPolicy.inputTokenBudget),
  })
  .strict()
  .refine((p) => !p.network, "Ağ erişimi güvenli köprü kurulana kadar kapalıdır.")
  .refine(
    (p) => p.permission !== "chat" || !p.commands,
    "Sohbet düzeyinde komut kullanılamaz.",
  );
export const directorSettingsSchema = z.object({ownerApprovalTypes:z.array(z.string().trim().min(1).max(80)).max(50).default(defaultDirectorSettings.ownerApprovalTypes),destructiveApproval:z.boolean().default(true),batchSeconds:z.number().int().min(1).max(3600).default(60),dailyTokenBudget:z.number().int().min(1).max(1000000000).default(defaultDirectorSettings.dailyTokenBudget),contextTokenLimit:z.number().int().min(1000).max(1000000).default(60000),responseCharLimit:z.number().int().min(500).max(10000).default(3000),chatEffort:z.enum(['low','medium','high']).default('low'),workEffort:z.enum(['low','medium','high']).default('medium'),followupTokenBudget:z.number().int().min(1).max(1000000000).default(100000),hourlyRuns:z.number().int().min(1).max(100).default(12)}).strict();
export const settingsSchema = z
  .object({
    language: z.enum(["tr", "en"]).optional(),
    director: directorSettingsSchema.default(defaultDirectorSettings),
    defaultRunner:z.enum(["claude","codex"]).default("codex"),
    inputPricePerMillion:z.number().min(0).max(1000000).default(0),
    outputPricePerMillion:z.number().min(0).max(1000000).default(0),
    timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('tr-TR', { timeZone: value }); return true; } catch { return false; } }, 'Geçerli bir saat dilimi seçin.').default(defaultSettings.timeZone),
    emailDomain: z.string().toLowerCase().regex(/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/).default(defaultSettings.emailDomain),
    budgetUncached: z.boolean().default(false),
    cachedInputWeight:z.number().min(0).max(1).default(0.1),
    chatTurnLimit: z.number().int().min(1).max(100).default(12),
    dailyTokenBudget: z.number().int().min(1).max(1000000000).default(defaultSettings.dailyTokenBudget),
    sessionTurnLimit: z.number().int().min(1).max(10000).default(defaultSettings.sessionTurnLimit),
    sessionTokenLimit: z.number().int().min(1).max(1000000000).default(defaultSettings.sessionTokenLimit),
    defaultModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/).default(defaultSettings.defaultModel),
    defaultEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
    sharedWriters: z.array(z.string().uuid()).max(100).default([]),
    concurrency: z.number().int().min(1).max(16),
    maxDepth: z.number().int().min(1).max(20),
    chainRuns: z.number().int().min(1).max(100),
    dailyRuns: z.number().int().min(1).max(10000),
    dailyMinutes: z.number().int().min(1).max(14400),
    approvalRules: z.array(z.string().trim().min(1).max(500)).max(50),
    chainTokenBudget: z.number().int().min(1).max(1000000000).default(defaultSettings.chainTokenBudget),
    greeterAgentId: z.string().uuid().nullable().default(null),
  })
  .strict()
  .default({...defaultSettings,director:defaultDirectorSettings,defaultRunner:"codex",inputPricePerMillion:0,outputPricePerMillion:0,budgetUncached:false,cachedInputWeight:0.1,chatTurnLimit:12});
const str = (n: number) => z.string().trim().min(1).max(n);
const uid = str(120);
export const workOptionsSchema = z.object({model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/).optional(),effort:z.enum(["low","medium","high","xhigh","max"]).optional(),acceptance:z.array(z.string().uuid()).max(10).default([]),prepared:z.string().max(8000).default("")}).strict();
export const managementActionSchema=z.object({islem:z.enum(directorOperations),kimlik:z.string().max(120).optional(),ajan:z.string().uuid().optional(),veri:z.record(z.string(),z.unknown()).default({})}).strict();
const batchActionSchema=managementActionSchema.extend({ajan:z.string().max(120).optional()});
export const assignmentResourcesSchema=z.object({klasorler:z.array(z.string().uuid()).max(20),komutlar:z.array(z.string().uuid()).max(20),belgeler:z.array(z.object({klasor:z.string().uuid(),yol:z.string().min(1).max(500)}).strict()).max(10).default([])}).strict();
export const toolSchemas = {
  yonetim_durum:z.object({alan:z.enum(["ofis","ajan","calisma","olaylar","baglantilar","zamanlamalar","kullanim","tududi","cop_kutusu","ayarlar","onaylar"]).default("ofis"),kimlik:z.string().uuid().optional(),ayrinti:z.boolean().default(false),tur:z.string().max(80).optional()}).strict(),
  yonetim_islem:z.union([managementActionSchema,z.object({islemler:z.array(batchActionSchema).min(1).max(20)}).strict()]),
  yonetim_defteri:z.object({metin:z.string().max(8000)}).strict(),
  yonetim_izle:z.object({calisma:z.string().uuid(),is:z.string().min(1).max(200).optional()}).strict(),
  mesaj_gonder: z
    .object({
      kime: str(120),
      metin: str(10000),
      cevap_bekleniyor: z.boolean().default(false),
      kaynaklar:assignmentResourcesSchema.optional(),kabul:str(2000).optional(),
      dosyalar: z.array(str(500)).min(1).max(20).optional(),
    })
    .strict(),
  gelen_kutusu: z.object({}).strict(),
  gorev_devret: z
    .object({
      kime: z.string().uuid(),
      baslik: str(200),
      aciklama: z.string().max(20000).default(""),
      not_kimligi: uid.optional(),
      kaynaklar:assignmentResourcesSchema.optional(),kabul:str(2000).optional(),
      is: str(200).optional(),
      secenekler: workOptionsSchema.optional(),
      dosyalar: z.array(str(500)).min(1).max(20).optional(),
    })
    .strict(),
  gorev_durumu: z
    .object({
      gorev: z.string().uuid(),
      durum: z.enum(["devam ediyor", "bitti", "yapılamadı"]),
      not: str(2000),
    })
    .strict(),
  komut_calistir: z.object({ ad: str(100) }).strict(),
  engel_bildir: z.object({ engel: str(1000) }).strict(),
  yayina_hazir: z.object({ karar: str(2000) }).strict(),
  is_notu_yaz: z.object({ metin: str(1500) }).strict(),
  sohbet_gecmisi: z.object({ adet: z.number().int().min(1).max(30).default(10) }).strict(),
  ortak_notlar: z.object({}).strict(),
  ortak_not_oku: z.object({ kimlik: str(120) }).strict(),
  ortak_not_yaz: z.object({ baslik: str(200), icerik: str(4000) }).strict(),
  tududi_ara: z.object({ sorgu: str(200), proje: uid.optional() }).strict(),
  tududi_not_oku: z.object({ baslik: str(200).optional(), kimlik: uid.optional() }).strict().refine(b => !!b.baslik !== !!b.kimlik),
  tududi_gorevler: z.object({ durum: z.number().int().min(0).max(4).optional(), proje: uid.optional() }).strict(),
  tududi_gorev_oku: z.object({kimlik:uid}).strict(),
  tududi_gorev_ekle: z
    .object({ name: str(200), description: z.string().max(20000).optional() })
    .strict(),
  tududi_gorev_guncelle: z
    .object({ gorev: uid, durum: z.number().int().min(0).max(4) })
    .strict(),
  tududi_notlar: z.object({ proje: uid.optional() }).strict(),
  tududi_not_yaz: z.object({ baslik: str(200), icerik: str(4000), proje: uid.optional() }).strict(),
  hafiza_oku: z.object({}).strict(),
  hafiza_yaz: z.object({ metin: z.string().max(8000) }).strict(),
  durum_bildir: z.object({ kisa_metin: str(180) }).strict(),
  onay_iste: z
    .object({
      baslik: str(200),
      ayrinti: str(20000),
      tur: str(80),
      baglanti: z.string().uuid().optional(),
      dosyalar: z.array(str(500)).min(1).max(20).optional(),
    })
    .strict(),
  teslim_et: z
    .object({
      baslik: str(200),
      ozet: str(2000),
      dosyalar: z.array(str(500)).min(1).max(20),
    })
    .strict(),
};
export type ToolName = keyof typeof toolSchemas;
