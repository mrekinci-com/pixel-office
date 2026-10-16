# Pixel Office paneli

[English](README.md) · [Türkçe](README.tr.md)

Türkçe ve İngilizce yönetim paneli; React/Canvas arayüzünü ve Fastify sunucusunu aynı porttan sunar. Bölümler, çalışanlar, sohbetler, görevler, notlar, iş başına oturumlar, zamanlanmış işler, dosya onayları ve Genel Müdür terminali burada yönetilir. Şirket, yerleşik Genel Müdür dışında örnek çalışan ve bölüm olmadan başlar.

Yeni kurulum için [ana belgeyi](../README.md) izleyin. Bu klasörün `.env.example` dosyası sunucu ayarlarını, kökteki `.env.example` ise Compose adres ve imaj ayarlarını tanımlar. Tududi uyarlanmış ayrı imajdan, çalıştırıcı ise aynı kaynak sürümünden kurulmalıdır.

## Yerel geliştirme

Node.js 24 veya üstü gerekir. Komutlar bu klasörde çalıştırılır:

```sh
npm ci --cache .cache/npm --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

`build`, arayüzü `dist/client`, sunucuyu `dist/server` içine yazar. Hazır derlemeyi `npm start` çalıştırır ve `.env` dosyasını okur. Geliştirme için `npm run dev` sunucuyu, ayrı terminalde `npm run dev:ui` Vite'ı çalıştırır. Vite API isteklerini 9400'e aktarır. Komutlar kendiniz çalıştırdığınızda sunucu başlatır.

Kök kurulum yardımcısının yerine yalnız panel ayarı hazırlamak isterseniz `node scripts/prepare-env.mjs` mevcut olmayan `.env` içine anahtarları yazar. Bu eski yardımcı sahip şifresini veya Tududi bilgilerini doldurmaz; bunları elle ayarlamak gerekir.

## Sunucu ayarları

| Değişken | Anlamı |
| --- | --- |
| `OFIS_OWNER_PASSWORD` | Tek sahip hesabının giriş şifresi; en az 12 karakter. |
| `OFIS_SECRET_KEY` | Şifreleme ve oturum imzası için 64 onaltılık hane; kalıcı tutulur. |
| `OFIS_RUNNER_KEY` | Çalıştırıcıyla ortak, en az 32 karakter; boşsa çalışma API'si kapalıdır. |
| `OFIS_DATA_DIR` | SQLite dizini; yerelde `./data`, kapsayıcıda `/app/data`. |
| `PORT` | Sunucu portu; varsayılan 9400. |
| `OFIS_PUBLIC_URL` | Tarayıcıdan açılan panel adresi; kaynak kontrolünde kullanılır. |
| `OFIS_COOKIE_SECURE` | Yerel HTTP'de `false`; HTTPS dış adresinde güvenli çerez zorunludur. |
| `OFIS_BIND` | Yerel varsayılan `127.0.0.1`; imaj içinde açıkça `0.0.0.0`. |
| `TUDUDI_BASE_URL` | Ayrı Tududi'nin iç adresi; varsayılan `http://127.0.0.1:9393`. |
| `TUDUDI_ADMIN_EMAIL`, `TUDUDI_ADMIN_PASSWORD` | Ayrı Tududi'nin hesap açabilen yöneticisi. |
| `TUDUDI_EMAIL_DOMAIN` | Ajan e-posta alan adı; gerçek posta gönderimi değildir. |
| `TUDUDI_PUBLIC_URL` | Ayrı vekilin sayısal yerel/özel adresi; varsayılan Compose'ta 9394. |

Compose, panel portunu, veri yolunu ve Tududi iç adresini kendisi verir. Dış adresleri kök `OFIS_PRIVATE_IP` ayarından üretir. HTTPS ters vekil kuruyorsanız **yerel Compose ekinde** `office.environment.OFIS_PUBLIC_URL` değerini dış HTTPS adresiyle değiştirin; `office/.env` içinde `OFIS_COOKIE_SECURE=true` yapın. Tududi geçiş vekili sayısal özel adreste kalmalıdır. Farklı alan adı/HTTPS üzerinden Tududi geçişi ayrıca uyarlanıp sınanmalıdır.

Oturumlar 12 saat sürer; `httpOnly`, `SameSite=Strict` imzalı çerez kullanılır. Giriş denemeleri sınırlandırılır. Sahip değişiklikleri aynı kaynaktan ve `X-Ofis-Islem: 1` başlığıyla yapılır. Ajan anahtarı yönetim API'sine veya sahip oturumuna erişemez. Her ajana ayrı Tududi hesabı ve anahtar üretilir; hesap sırları AES-256-GCM ile şifrelenir. `OFIS_SECRET_KEY` veritabanıyla birlikte güvenli şekilde yedeklenmelidir.

Hesap kurulamazsa panel yeniden denemeye izin verir. Ajan silerken hesabı koruma veya silme seçilir; hesap silme hatasında kayıt korunur. Veri geçişleri `server/db.ts` içinde sıra numarasıyla uygulanır; yeni geçiş var olan veritabanını silmemelidir.

## İsteğe bağlı kontroller

`npm test` model veya canlı Tududi çağırmaz. `npm run test:live` ve `npm run test:live:b1` ise ayarlanmış ayrı Tududi'de geçici hesap açar ve temizler; yalnız özel test kopyasında kullanılmalıdır.

Tarayıcı/görsel testler için Playwright Chromium ve sistem kitaplıkları gerekir. `bash scripts/prepare-browser.sh` Ubuntu 24.04 kitaplıklarını sistem kurulumu yapmadan `.cache` altında hazırlayabilir; paket indirir. Bu kontroller Chromium üzerinden uygulamayı denetler:

```sh
npm run test:browser
npm run test:visual
```

Görsel tabanlar (`tests/__screenshots__`, yaklaşık 180 MB) depoda yayımlanmaz; kendi makinenizde bir kez `npm run test:visual -- --update-baselines` ile oluşturun, sonraki değişiklikleri `npm run test:visual` ile karşılaştırın. `npm run test:visual -- --update-baselines` kayıtları değiştirir; görsel değişiklikleri inceleyerek kullanın. Geçici görüntüler ve raporlar `.test-data` altındadır. Tanıtım görüntüleri için `npm run screenshots` kullanılır; seçenekleri `scripts/screenshots.ts` içinde tanımlıdır. Görsel testler Python ve Pillow da ister.

Görsel kaynakları ve lisansları: [ASSET-LICENSES.md](public/assets/ASSET-LICENSES.md), [üretim notları](public/assets/source/GENERATION.md). Atlasları yeniden üretmek için Pillow bulunan Python ile `python3 scripts/prepare-art.py` çalıştırılır; normal uygulama ve derleme bunu gerektirmez. Sahne karşılaştırıcısı `scripts/compare-office.py`, testlerin `.test-data/screenshots` altında oluşturduğu görüntüleri kullanır.

Eski kurulumda ajan şifresi saklanmamışsa `scripts/legacy-account-login.mjs` yerel işletmeci aracıdır. Varsayılanı yalnız listelemedir; `--uygula` veri değiştirir. Yeni kurulum için gerekmez.

Ofis dili sol alttaki kullanıcı menüsünden veya Kullanım ve kota ekranından değiştirilir. Yeni ofis tarayıcı dilinden bağımsız olarak İngilizce açılır; Türkçe, TR/EN düğmesinden veya ofis dili ayarından seçilir. Mevcut ofislerin saklanan dili korunur. Kullanıcı verileri ve eski olay kayıtları çevrilmez.
