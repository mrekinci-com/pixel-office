import { toolDescriptionsEn } from "../../office/shared/i18n/tool-descriptions.js";
import { runnerLanguage } from "./i18n.js";
import { directorOperations } from "../../office/shared/director.js";
export const tools = [
  ["yonetim_durum","Yalnız Genel Müdür: varsayılan ofis cevabı kısa sayılar ve dikkat isteyenlerdir. Ayrıntı için ayrinti:true, ilgili alan/kimlik veya kuyruk durumuna göre tur filtresi kullan. Ofis, ajan, çalışma kanıtı/dökümü, olaylar, bağlantılar, zamanlamalar, kullanım, ajan Tududi verisi veya çöp kutusu okur.",{alan:{type:"string",enum:["ofis","ajan","calisma","olaylar","baglantilar","zamanlamalar","kullanim","tududi","cop_kutusu","ayarlar","onaylar"]},kimlik:{type:"string"},ayrinti:{type:"boolean"},tur:{type:"string"}},[]],
  ["yonetim_islem","Yalnız Genel Müdür: sahibin panel doğrulamalarıyla yönetir. Birden çok işi islemler listesinde topla (en çok 20); sırayla uygulanır, önceki sonuca $1.id gibi başvurulur. Hata veya sahip kararı beklenirse kalanlar uygulanmaz; uygulananlar geri alınmaz. Tek işlem için islem kullan. kimlik işlem hedefi, ajan Tududi hesabı, veri panel alanlarıdır. Yeni klasör ve yıkıcı işlem sahibin onayına gider. Komut tanımı ve klasör erişimini genişletme her zaman sahibin kararını bekler. fabrika_ayarlari_onizle: kimlik ile tek ajan, kimlik olmadan tüm ajanlar için sıfırlama önizlemesi önerir; veri boş olur. Her zaman sahip onayı ister, silmeyi çalıştıramaz. Sahibe ayrılmış yetkileri değiştiremez. ajan_olustur/duzenle için name,title,department_id,prompt,runner,model,effort,appearance ve isteğe bağlı policy,tool_groups,session_mode alanları. ajan_calistir: text, kabul (bitiş ölçütü), kaynaklar:{klasorler:[kimlik],komutlar:[kimlik],belgeler:[{klasor:kimlik,yol:göreli yol}]}, secenekler, is (sabit iş kimliği). Gerekmeyen kaynak listesi boş olur; geliştirmede yazılabilir klasör ve komut şart; belge isteğe bağlıdır. Kesik belge listesinde bulunmayan yol doğrulanamadı uyarısıdır; ajan dosyayı kontrol eder. Eksik kaynakta iş açma, kaynağın adı ve nedenini sahibe bildir.",{islem:{type:"string",enum:directorOperations},kimlik:{type:"string"},ajan:{type:"string"},veri:{type:"object",additionalProperties:true},islemler:{type:"array",minItems:1,maxItems:20,items:{type:"object",properties:{islem:{type:"string",enum:directorOperations},kimlik:{type:"string"},ajan:{type:"string"},veri:{type:"object",additionalProperties:true}},required:["islem"],additionalProperties:false}}},[]],
  ["yonetim_defteri","Yalnız Genel Müdür: açık işler, kimde, sıradaki adım ve bekleyen soruları tek kalıcı Durum defteri notunda günceller. Yalnız açık işler veya kararlar değişirse kullan; selam ve bilgi sorusunda kullanma. Otomatik takipte zorunludur.",{metin:{type:"string",maxLength:8000}},["metin"]],
  ["yonetim_izle","Yalnız Genel Müdür: çalışmanın bitiş/başarısızlık/bütçe sonucunu otomatik mod özetine bağlar; boş model turu açmaz.",{calisma:{type:"string"},is:{type:"string"}},["calisma"]],
  ["komut_calistir","Sahibin sabit komutunu adıyla çalıştırır; komuta argüman ekleyemezsiniz. Çıkış kodu ve maskeli kanıt döner.",{ad:{type:"string"}},["ad"]],
  ["engel_bildir","Eksik araç veya erişim engelini bildirir; aynı engel ikinci kez gelirse zincir durur.",{engel:{type:"string"}},["engel"]],
  ["yayina_hazir","İnceleyicinin KABUL kararını kayıtlı komut ve fark kanıtlarıyla sahibin onayına sunar. Yayın elle yapılır.",{karar:{type:"string"}},["karar"]],
  ["is_notu_yaz","Mevcut işin amaç, yapılan, sıradaki adım ve dosya adlarını Tududi görevine kaydeder. Her tur sonunda kullanın.",{metin:{type:"string",maxLength:1500}},["metin"]],
  ["sohbet_gecmisi","Gerektiğinde son birkaç sohbet mesajını getirir.",{adet:{type:"integer",minimum:1,maximum:30}},[]],
  ["tududi_not_oku","Kimlik veya başlıkla yalnız bir notun içeriğini getirir. Yanlış işaretlenen notlar kullanılmaz.",{kimlik:{type:"string"},baslik:{type:"string"}},[]],
  ["tududi_ara","Tududi aramasından en çok beş kısa not ve görev sonucu döner.",{sorgu:{type:"string"},proje:{type:"string"}},["sorgu"]],
  ["ortak_notlar","Ortak defterdeki not başlıklarını listeler.",{},[]],
  ["ortak_not_oku","Ortak defterden tek not okur.",{kimlik:{type:"string"}},["kimlik"]],
  ["ortak_not_yaz","Yalnız sahibin seçtiği ajan ortak deftere kısa bilgi yazabilir.",{baslik:{type:"string"},icerik:{type:"string",maxLength:4000}},["baslik","icerik"]],
  [
    "mesaj_gonder",
    "Bir ajana, bölüm kimliğine, genel veya sahip alıcısına mesaj gönderir. Cevap gerekmiyorsa yeni çalışma başlatmaz. GM cevap isterse kaynaklar ve kabul alanlarını verir.",
    {
      kime: { type: "string" },
      kaynaklar:{type:"object",additionalProperties:true},kabul:{type:"string",maxLength:2000},
      metin: { type: "string" },
      cevap_bekleniyor: { type: "boolean", default: false },
      dosyalar: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
    },
    ["kime", "metin"],
  ],
  [
    "gelen_kutusu",
    "Okunmamış mesajları ve açık görev devirlerini getirir; mesajları okundu işaretler.",
    {},
    [],
  ],
  [
    "gorev_devret",
    "GM kaynaklar ve kabul alanlarını verir; eksik kaynakta iş açmaz. Alıcının kendi Tududi hesabında görev açar ve onu çalıştırır. Dosya için dosyalar alanında kendi klasörünüzdeki göreli yolları verin; mutlak yol yazmayın.",
    {
      kime: { type: "string" },
      kaynaklar:{type:"object",additionalProperties:true},kabul:{type:"string",maxLength:2000},
      baslik: { type: "string" },
      aciklama: { type: "string" },
      not_kimligi: { type: "string" },
      is:{type:"string"},
      secenekler:{type:"object",properties:{model:{type:"string"},effort:{type:"string",enum:["low","medium","high","xhigh","max"]},acceptance:{type:"array",items:{type:"string"},maxItems:10},prepared:{type:"string",maxLength:8000}},additionalProperties:false},
      dosyalar: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
    },
    ["kime", "baslik"],
  ],
  [
    "gorev_durumu",
    "Yalnız size devredilen görevi günceller.",
    {
      gorev: { type: "string" },
      durum: { type: "string", enum: ["devam ediyor", "bitti", "yapılamadı"] },
      not: { type: "string" },
    },
    ["gorev", "durum", "not"],
  ],
  ["tududi_gorevler", "Süzülmüş kısa görev listesini getirir.", { durum: {type:"integer",minimum:0,maximum:4},proje:{type:"string"} }, []],
  ["tududi_gorev_oku", "Yalnız seçilen görevin ayrıntısını getirir; uzun isteği bu araçla okuyun.", {kimlik:{type:"string"}}, ["kimlik"]],
  [
    "tududi_gorev_ekle",
    "Kendi Tududi hesabınızda görev ekler.",
    { name: { type: "string" }, description: { type: "string" } },
    ["name"],
  ],
  [
    "tududi_gorev_guncelle",
    "Kendi Tududi görevinizin durumunu günceller (0: yeni, 1: sürüyor, 2: bitti, 3: arşiv, 4: beklemede).",
    {
      gorev: { type: "string" },
      durum: { type: "integer", minimum: 0, maximum: 4 },
    },
    ["gorev", "durum"],
  ],
  ["tududi_notlar", "Yalnız not başlığı, tarih ve boyut döner; içerik için tududi_not_oku kullanın.", {proje:{type:"string"}}, []],
  [
    "tududi_not_yaz",
    "Kendi Tududi hesabınızda not yazar.",
    { baslik: { type: "string" }, icerik: { type: "string",maxLength:4000 },proje:{type:"string"} },
    ["baslik", "icerik"],
  ],
  [
    "hafiza_oku",
    "Sonraki çalıştırmalara taşınan kısa hafıza notunu okur.",
    {},
    [],
  ],
  [
    "hafiza_yaz",
    "Hafıza notunu değiştirir; en çok 8000 karakter.",
    { metin: { type: "string", maxLength: 8000 } },
    ["metin"],
  ],
  [
    "durum_bildir",
    "Ofis balonundaki kısa çalışma bilgisini değiştirir.",
    { kisa_metin: { type: "string", maxLength: 180 } },
    ["kisa_metin"],
  ],
  [
    "onay_iste",
    "Son işlem: onay ister, karar gelince yeni çalışma başlar. Klasöre yazmak için baglanti ve dosyalar verin. Bağlantısız dosyalar yalnız ektir; sahibe dosya vermek için teslim_et kullanın.",
    {
      baslik: { type: "string" },
      ayrinti: { type: "string" },
      tur: { type: "string" },
      baglanti: { type: "string" },
      dosyalar: { type: "array", items: { type: "string" } },
    },
    ["baslik", "ayrinti", "tur"],
  ],
  [
    "teslim_et",
    "Kendi çalışma klasörünüzdeki dosyaları değişmez bir çıktı olarak teslim eder.",
    {
      baslik: { type: "string" },
      ozet: { type: "string" },
      dosyalar: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 20,
      },
    },
    ["baslik", "ozet", "dosyalar"],
  ],
].map(([name, description, properties, required]) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
}));

export function toolsForNames(names?:string[]) {return tools.filter(t=>names ? names.includes(String(t.name)) : !String(t.name).startsWith("yonetim_")).map(tool=>({...tool,description:runnerLanguage() === "en" ? toolDescriptionsEn[String(tool.name)] : tool.description}));}
