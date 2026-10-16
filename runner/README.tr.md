# Pixel Office çalıştırıcı

Claude yalnız sohbet ve yetkili Ofis araçlarını kullanır. Kimlik dosyasıyla aynı profili paylaşan yerleşik dosya ve kabuk araçları kapalıdır. Dosya işleri için Codex seçin; eski Claude ajanlarının klasör erişimini sohbet düzeyine alın. [Güvenlik modeli](../SECURITY.md) bu sınırı açıklar.

[English](README.md) · [Türkçe](README.tr.md)

Ofis kapsayıcısından ayrı, sunucuda çalışan Node.js 24 + TypeScript sürecidir. Genel kurulum adımları [ana belgede](../README.md) bulunur.

Gereksinimler: Node.js 24+, Codex CLI ≥0.138 (seçenekler 0.159.1 ile sınandı); isteğe bağlı Claude CLI seçenekleri 2.1.285 için hazırlanmıştır, Linux `bubblewrap` (`bwrap`), kullanıcı/PID ad alanları ve Codex kabuk sondası için `/usr/bin/python3`. Duman sondası ayrıca `/usr/bin/curl` ister. İzolasyon yoksa gerçek ajan işi **başlatılmaz**. `bwrap` kurma veya izolasyonu kapatma işlemi bu uygulamanın içinden yapılmaz.

```sh
npm ci --cache .cache/npm
npm run typecheck
npm run build
npm test
```

`.env.example` dosyasını `.env` adıyla hazırlayın (0600). Ofis'in `.env` dosyasındaki `OFIS_RUNNER_KEY` ile aynı, en az 32 karakterlik rastgele anahtarı kullanın. Anahtarı komut satırına, kayda veya depoya yazmayın. Ofis tarafında bu değer boşsa iç çalıştırıcı API'si kapalıdır.

| Değişken | Anlamı |
| --- | --- |
| `OFIS_URL` | `http://127.0.0.1:9400` veya ayrı deneme için `http://127.0.0.1:9401`; farklı adres reddedilir. |
| `OFIS_RUNNER_KEY` | Ofis ile ortak iç API anahtarı; modele veya MCP sürecine geçmez. |
| `OFIS_WORK_DIR` | Mutlak çalışma kökü; `<kök>/office/<ajan kimliği>`, tek seferlik profiller `<kök>/.runtime/<çalışma kimliği>`, iş/kalıcı profiller `<kök>/.oturum/<ajan>/<nesil>`. |
| `OFIS_ALLOWED_ROOTS` | Bağlantı için izinli mutlak kökler; `:` ile ayrılır. Boşsa bağlantı yok. |
| `OFIS_PROTECTED_ROOTS` | İlave kesin yasak kökler; depo kökü ve çalışma kökü zaten yasak. |
| `OFIS_CONCURRENCY` | Yerel kapasite (varsayılan 2). Panel sınırıyla küçük olan uygulanır. |
| `OFIS_CODEX_MODEL` | Panel önerisinde gösterilecek, bu kurulumda kullanılan model. Varsayılan `gpt-6.1-sol`; kota/erişim garantisi değildir. |
| `OFIS_CLAUDE_AUTH_FILE` | Ayrı Claude hesabının özel kimlik dosyası; yalnız `claudeAiOauth` kopyalanır. |
| `OFIS_CODEX_AUTH_FILE` | Ayrı Codex hesabının `auth.json` dosyası; yalnız kimlik alanları kopyalanır. |
| `OFIS_CLAUDE_BIN`, `OFIS_CODEX_BIN`, `OFIS_BWRAP_BIN` | İsteğe bağlı komut yolları; varsayılanlar `claude`, `codex`, `bwrap`. |

Kimlik dosyaları modele erişim için gereken **ayrı hizmet hesabına** ait olmalı. Kullanıcının kişisel HOME klasörü, `.claude`/`.codex` ayarları, kancaları, eklentileri, becerileri veya oturumları bağlanmaz. Yeni oturumda boş HOME hazırlanır; gerekli kimlik alanları kopyalanır. Tek seferlik profil süreç bitince silinir; iş başına ve kalıcı profiller oturum kapanana veya yenilenene kadar korunur. Yenilenen kimlik alanları yalnız çalışma kökündeki `.auth/` kasasında saklanır; kişisel ayarlar saklanmaz. Hesap değiştirirken bu özel önbellek de yönetici tarafından yenilenmelidir. Kişisel kimlik dosyası otomatik aranmaz. `--bare` Claude OAuth'ını kapattığı için kullanılmaz; onun yerine `--restricted`, boş ayar kaynakları, özel HOME ve beceri/kanca kapatma birlikte kullanılır.

Elle başlatma:

```sh
npm start
```

`systemd/pixel-office-runner.service.example` örneğinin Node yolu ve PATH'i kurulumunuza göre ayarlanmalıdır. Dosya burada yalnız hazırlanmıştır. Tek çalıştırıcı servisi varsayılır. SIGTERM/SIGINT alt süreçleri kapatır, Ofis kaydını bırakır. Aynı makine ve çalışma kökünden gelen yeni kimlik, eski kimlik 5 saniyedir kalp atmıyorsa devralabilir. Başka makine/eski sürüm için 45 saniye sınırı korunur. Çökme sonrası eski işler en çok bir kez yeniden denenir.

Klasör içindeki özel ayar/gizli dosyalar ve kök dışına çıkan sembolik bağlantılar da reddedilir; tarama en çok 50.000 girdiyle sınırlıdır.

Klasör bağlantısı panelde oluşturulunca çalıştırıcı gerçek yolu, ret listesini ve izinli kökü doğrular. Salt okunur bağlantı salt okunur bağlanır. “Onayla yazar” bağlantısı da ajan sürecine salt okunur bağlanır ve Codex'e yazılabilir ek kök olarak verilmez. Ajan aynı göreli yolu kendi klasöründe hazırlar; `onay_iste(baglanti, dosyalar)` içerikleri ve önce/sonra farkını kaydeder. Karar sonrası çalıştırıcı kaydedilmiş baytları kopyalar; çalışma dosyası değiştirilse bile onay içeriği değişmez. Hedef değişmişse veya yol sembolik bağlantıysa kopyalama reddedilir. Çoklu dosya kopyalama tek veritabanı işlemi değildir; yarıda kalan kopyalama otomatik tekrarlanmaz.

Dosyalar tek başına en çok 1 MB, bir teslim/onay en çok 20 dosya olabilir. Gizli dosyalar ve bilinen sırları içeren metinler teslim edilemez. Bağlantısız `onay_iste(dosyalar)` değişmez dosya eki oluşturur; eki kopyalama yetkisi vermez. Güvenlik sınırları [ana belgede](../README.md) açıklanır.

Testler gerçek model çağrısı veya dinlenen HTTP portu kullanmaz. Sahte CLI, gerçek stdio MCP ile konuşur; yalnız test kodundaki dosya köprüsü istekleri Fastify `inject` yöntemine taşır. Üretimde bu köprü/başlatıcı kullanılmaz ve izolasyonsuz başlatma için ortam anahtarı yoktur.

Codex, çalışma klasörü ve bağlantı düzeyinde kabuk kullanır; sohbet düzeyinde kapalıdır. Her çalışmadan önce **aynı dış bwrap bağlamalarında, aynı Codex ayarlarıyla** model çağrısı yapmadan iç kum havuzu sondası çalışır. IPv4/IPv6 TCP ve IPv4 UDP soketi açmanın EPERM/EACCES ile reddedildiği görülmezse iş başlamaz. Zaman aşımı, boş çıktı, farklı hata kodu ve yalnız bağlantı reddi başarı sayılmaz. Kabuğa yalnız PATH=/usr/bin:/bin, özel HOME/TMPDIR ve LANG=C.UTF-8 verilir. Sonda başarısı sonraki gerçek CLI çalışmasının matematiksel garantisi değildir.

**Komutların ağ erişimi kapalıdır.** Panel anahtarı açılamaz, sunucu yeni ağ iznini reddeder, eski izin de çalıştırıcıda reddedilir. Dış bwrap model ve MCP için ana makinenin ağını paylaşmayı sürdürür; bütün süreç için alan adı/yerel IP çıkış filtresi bu sürümde yoktur. Ayrı ağ ad alanı + Unix MCP köprüsü + CONNECT vekili uygulanmadı. CLI’nin ajana özel profilinde hizmet hesabının kimliği vardır; kabuk için profil yolu `deny` olur. Gerçek reddin sonda ile doğrulanması iş başlamadan gerekir. Kişisel ayarlar taşınmaz.

Gerçek duman denemesi, ayrı deneme Ofisi ve çalıştırıcısı hazırken yapılır:

```sh
npm run smoke:real -- --ofis-url http://127.0.0.1:9401 --work-dir "$PWD/work-test" --runner codex
npm run smoke:real -- --ofis-url http://127.0.0.1:9401 --work-dir "$PWD/work-test" --runner claude
npm run smoke:real -- --ofis-url http://127.0.0.1:9401 --work-dir "$PWD/work-test" --runner all
```

Betik 9401 için office/.env.test ve runner/.env.test dosyalarını okur. 9400 ancak --canli ile seçilir; bu durumda .env dosyaları kullanılır. Ajanların Tududi'si 9393 olmalı. Servis ve betikte OFIS_WORK_DIR/OFIS_ALLOWED_ROOTS aynı olmalı. İzinli kökte geçici klasörler kullanılır. Mevcut ajan/bölüm/kurallara dokunulmaz. Genel ofis kotası/yoğunluğu denemeyi engelleyebilir; betik bunları yükseltmez.

En çok 90 model çalıştırması. Üç oturum biçiminin 2 ve 6 adımlı karşılaştırması iki sağlayıcı için tek başına 48 çalışma gerektirir. Hazırlık/yenileme ve bütçe yeniden denemelerinin kullanımı karşılaştırma toplamına dahildir. İlk çalışma cevap/hafıza/dosya/Tududi adımlarını birleştirir; devir iki, onay+ret üç, bağlantı iki ve zincir iki çalıştırmayla sınırlıdır. Yalıtım sondaları model çağrısı kullanmaz. GEÇTİ/KALDI tablosu, süre, token ve maskeli tanı basılır; bir KALDI bile çıkış kodunu 1 yapar. `--keep` yalnız yeni deneme kayıtlarını korur, çalışan işleri yine durdurur. Normal temizlik, süreç çıkışı doğrulanmadan ajanı silmez; çıkış veya hesap silme hatasında kayıtlar korunur ve KALDI yazılır. SIGTERM/SIGINT de temizlik yoluna girer; SIGKILL/güç kesintisi garanti edilemez.

`--runner claude` dosya ve kabuk senaryolarını DENENMEDİ olarak kaydeder; bunlar Codex gerektirir. Karma sağlayıcılı dosya devri de denenmez. Claude hesabının girişi yoksa deneme başlamaz; kimlik alanının bulunması hesabın geçerli veya modelde yetkili olduğunun kanıtı değildir.

## Ayrı deneme ve kalıcı oturum

`npm run test:box`, yapılandırılmış gerçek bwrap ile yalnız depodaki geçici klasörde Node/hazır bağımlılık okuma, yazma sınırları, dış ağ arayüzlerinin yokluğu, süre ve durdurmayı sınar. Ofis/Tududi isteği, model çağrısı veya bağımlılık indirme yapmaz; geçici klasörü siler. Yerel `.env` dosyasındaki bwrap yolu kullanılır. Sahte CLI testlerinden ayrı çalıştırılır.

Duman sürücüsü varsayılan olarak 127.0.0.1:9401 ile `.env.test` dosyalarını kullanır. `--work-dir` zorunludur; canlı Ofise karşı çalışmak için ayrıca `--canli` gerekir. Çalışma kökü ve `runner/test-code` önce oluşturulmalıdır. Hazırlık ve gerçek CLI sınırları [ana belgede](../README.md) açıklanır.

Kalıcı profiller `.oturum/<ajan>/<nesil>` altında 0700 ile saklanır. Tek seferlik profil iş sonunda kaldırılır. Model listeleri hesaptan otomatik keşfedilmez; `OFIS_CODEX_MODELS` ve `OFIS_CLAUDE_MODELS` hesabın gerçekten kullanabildiği modellerle doldurulur.

## İş başına oturum ve ölçüm

Varsayılan iş başına oturumdur. Aynı işin devamı aynı sağlayıcı kimliğiyle sürer; yeni iş taze konuşma açar. Açık işlerin profilleri birlikte korunur. Yenileme eşikleri 12 tur / son çalışmada 150.000 girdi token'dır; çalışma bütçesi aşılırsa aynı iş taze oturumda bir kez yeniden denenir. Ofis ve çalıştırıcı aynı kaynak sürümünden derlenmelidir.

Duman karşılaştırmasının her biçimi/adım sayısı ayrı geçici ajan kullanır. Aynı sağlayıcının karşılaştırma ajanları önce birlikte oluşturulur; diğer ajanların rehberi ölçüm ortasında büyümez. Senaryolar taze oturumla başlar. `token-karsilastirma.json` toplam, önbellekli, önbelleksiz kullanım ile bütün çalışmaları kaydeder. `simulated:true` gerçek token tasarrufu değildir. Gerçek günlük/zincir bütçeleri yükseltilmez; yetmezse senaryo başarısız kalır.

`npm run test:box` ayrıca Codex kutusunun onaylı klasöre doğrudan yazmayı reddettiğini ve Claude dosya işinin başlamadan reddedildiğini model çağırmadan sınar. Modelin RED demesi yalıtım kanıtı sayılmaz. Claude ajanları gerçek hesapla doğrulanmış değildir.

Ofis dili sol alttaki kullanıcı menüsünden veya Kullanım ve kota ekranından değiştirilir. Yeni ofiste tarayıcı Türkçeyse Türkçe, diğer dillerde İngilizce seçilir; mevcut ofisler geçişte Türkçe kalır. Kullanıcı verileri ve eski olay kayıtları çevrilmez.
