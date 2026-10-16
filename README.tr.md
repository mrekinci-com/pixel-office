# Pixel Office

Güvenlik sınırları, desteklenen kurulum ve özel açık bildirimi:
[SECURITY.md](SECURITY.md).

[English](README.md) · [Türkçe](README.tr.md)

## Nedir?

Piksel Ofis, yapay zekâ ajanlarını aynı şirkette çalışan bir ekip gibi yönetmenizi sağlar. Bölümleri ve çalışanları siz kurarsınız; görevlerini, konuşmalarını ve durumlarını canlı bir piksel ofiste izlersiniz. Her ajanın ayrı Tududi hesabı, görevleri ve çalışma defteri vardır. Genel Müdür terminalinden ekiple konuşabilir, işleri dağıtabilir ve sonuçları takip edebilirsiniz.

Her iş kolu için kullanılabilir. Hazır bir şirket veya belirli bir sektöre ait verilerle başlamaz. Arayüz Türkçe ve İngilizcedir. Yeni ofis, tarayıcı dilinden bağımsız olarak İngilizce açılır. Türkçe, TR/EN düğmesinden veya ofis dili ayarından seçilir. Tercih sol alttaki kullanıcı menüsünden veya Kullanım ve kota ekranındaki Ofis dili ayarından değiştirilip saklanır. Mevcut ofislerin saklanan dili korunur; kullanıcı talimatları, adları, notları ve eski olayları çevrilmez.

## Ekran görüntüleri

Görüntülerin tamamında hayalî deneme verileri kullanılmıştır. Çalıştırıcı bağlantısı ve Genel Müdür oturumu sahtedir; gerçek model çağrısı yapılmamıştır. Görüntüler İngilizce arayüzle hazırlanmıştır.

![Dört ajan çalışırken ofis ve genel ekip sohbeti](docs/images/office.png)

![Yazar ve denetçi işe alıp tanıtım görevlerini dağıtan Genel Müdür terminali](docs/images/director.png)

| Büyütülmüş ofis · aydınlık tema | Ajanlar · hazır hesaplar | Görevler ve notlar |
| --- | --- | --- |
| [![Aydınlık temada büyütülmüş piksel ofis](docs/images/office-expanded.png)](docs/images/office-expanded.png) | [![Tududi hesapları hazır yedi hayalî ajan](docs/images/agents.png)](docs/images/agents.png) | [![Örnek ürün tanıtımı görev panosu](docs/images/tasks.png)](docs/images/tasks.png) |

## Gereksinimler

- Docker Engine ve Docker Compose eklentisi.
- Linux sunucu, Node.js **24 veya üstü**, `bubblewrap` (`bwrap`), `tmux`, Python 3. Çalıştırıcı sunucuda, kapsayıcıların dışında çalışır. Kullanıcı ad alanları açık olmalıdır.
- Codex CLI **0.138 veya üstü** ve Codex kullanabilen bir Codex/ChatGPT hesabı. Hesabın model erişimi ve kullanım sınırları geçerlidir. CLI seçenekleri 0.159.1 ile sınanmıştır; asgari terminal sürümü bütün sürümlerle uyum garantisi değildir.
- Node bağımlılıkları kurulurken `node-pty` için gerekirse `make` ve C++ derleyicisi.
- Uyarlanmış Tududi imajı: **`pixel-office-tududi:0.87-po.5`**. Standart Tududi imajı bu kurulumun yerine geçmez. Kaynağı ayrı `https://github.com/mrekinci-com/pixel-office-tududi` deposunda yayımlanacaktır; o deponun imaj hazırlama adımlarını izleyin.

Node.js ve Codex, servisi çalıştıracak Linux kullanıcısının erişebildiği konumlarda olmalıdır. Windows/macOS üzerinde çalıştırıcı desteği yoktur.

## Kurulum

`OFIS_*` ortam değişkenleri ve `PIKSEL_OFIS_TUDUDI_IMAGE` adı eski kurulumlarla uyum için korunur. İngilizce klasör ve hizmet adlarıyla da aynı değişkenleri kullanın; `OFFICE_*` takma adları eklenmemiştir.

Compose proje adı `pixel-office`; hizmetler `office`, `tududi` ve `tududi-proxy`; kapsayıcılar `pixel-office`, `pixel-office-tududi` ve `pixel-office-tududi-proxy` olur. Sunucudaki hizmet adı `pixel-office-runner.service` olur.

Bu bölüm yeni ve ayrı bir kurulum içindir. Kurulum klasörünün yolunda `%` kullanmayın; sınanan Compose sürümü bu yolu çözemiyor. Mevcut kurulumda veri ve gizli ayar dosyalarını koruyun; aynı proje adını ve portları ikinci kurulumla paylaşmayın.

```sh
git clone https://github.com/mrekinci-com/pixel-office.git
cd pixel-office
bash scripts/install.sh
```

Betik mesajları `LANG` değerine göre Türkçe veya İngilizce gösterilir. Hazırlama komutu kapsayıcı veya servis başlatmaz; paket kurmaz. Örneklerden dört yerel dosya hazırlar: kök `.env`, `tududi/.env`, `office/.env`, `runner/.env`. Rastgele sahip şifresi, Tududi şifresi, oturum sırrı, Ofis şifreleme anahtarı ve ortak çalıştırıcı anahtarı üretir. Sırları ekrana yazmaz; yeni ayar dosyaları yalnız sahibince okunur (0600). Mevcut ayarları değiştirmez; uyuşmayan anahtar veya yönetici bilgisinde durur.

1. `tududi/.env` içindeki `TUDUDI_USER_EMAIL` değerini ilk başlatmadan önce kendi yönetici adresinizle değiştirin. Aynı adresi `office/.env` içindeki `TUDUDI_ADMIN_EMAIL` alanına da yazın. Şifre değiştirirseniz iki dosyada da aynı olmalıdır. Bunlar yalnız ajanların kullandığı ayrı Tududi'nin yöneticisidir.
2. `office/.env` içindeki `OFIS_OWNER_PASSWORD` panel giriş şifrenizdir. Güvenli bir parola yöneticisinde saklayın. `OFIS_SECRET_KEY` kalıcıdır; değişirse eski şifreli hesap bilgileri açılamaz. `OFIS_RUNNER_KEY`, Ofis ve çalıştırıcıda aynı kalmalıdır.
3. `runner/.env` içinde `OFIS_CODEX_AUTH_FILE` değerini bu iş için ayırdığınız Codex hesabının özel `auth.json` dosyasının mutlak yoluna ayarlayın. `OFIS_CODEX_MODELS` ve `OFIS_CODEX_MODEL` alanlarını hesabınızın kullanabildiği modellerle doldurun; model erişimi kendiliğinden bulunmaz. Kimlik dosyasını depoya kopyalamayın.
4. Dosya bağlantısı için `OFIS_ALLOWED_ROOTS` alanına izin verdiğiniz mutlak klasör köklerini `:` ile ayırarak yazın. Boşsa ek klasör açılmaz. Diğer uygulamalarınızı korumak için köklerini `OFIS_PROTECTED_ROOTS` alanına aynı biçimde ekleyin. Depo, çalışma kökü, sistem yolları ve özel ayar klasörleri zaten korumalıdır. `OFIS_WORK_DIR` yalnız bu çalıştırıcıya ait olmalıdır.
5. Tududi imajını ayrı deponun yönergeleriyle hazırlayın. Başka adla hazırladıysanız kök `.env` içindeki `PIKSEL_OFIS_TUDUDI_IMAGE` değerini değiştirin.

Yeni veri klasörlerine kapsayıcıdaki UID 1000 kullanıcısı yazabilmelidir. Linux kullanıcınızın kimliği farklıysa yalnız bu yeni kurulumun `office/data`, `tududi/db` ve `tududi/uploads` klasörlerinin sahipliğini UID/GID 1000 için düzenleyin. Hazırlama komutu sahiplik değiştirmez.

### Erişim adresi

Varsayılan kurulum yalnız sunucunun `127.0.0.1` adresinde dinler:

| Adres | Kullanım |
| --- | --- |
| `http://127.0.0.1:9400` | Ofis paneli |
| `http://127.0.0.1:9394` | Ajanın Tududi hesabına geçiş vekili |
| `http://127.0.0.1:9393` | Ayrı Tududi'nin sunucu içi adresi |

Özel ağdan erişmek için kök `.env` içindeki `OFIS_PRIVATE_IP` alanına sunucunuzun **sayısal özel IPv4 adresini** yazın ve `bash scripts/install.sh` komutunu yeniden çalıştırın. Bu, 9400 ek portu için yerel `docker-compose.override.yml` dosyasını hazırlar. Adres boşken ek port eşlemesi oluşturulmaz. Vekil aynı özel adreste 9394'ü kullanır; 9393 yerel kalır. Genel adres veya `0.0.0.0` kullanmayın. Yalnız yerele dönmek için adresi boşaltın ve yerel Compose ekindeki özel portu kaldırın.

Ofis'in kaynak denetimi ve Tududi geçişi aynı sayısal özel adresi kullanır. Paneli bu adres üzerinden açın. Kök `.env` ve yerel Compose eki yayına girmez. HTTPS ters vekil için dış adres ve güvenli çerez ayarlarını [Ofis belgesine](office/README.tr.md) göre ayrıca düzenleyin.

### Kapsayıcıları başlatma

Ayarları kontrol ettikten sonra depo kökünde kendiniz çalıştırın:

```sh
docker compose config --quiet
docker compose up -d --build
```

Tam `docker compose config` çıktısı gizli değerler içerebilir; paylaşmayın. Ofis, Tududi'nin ağ alanını paylaşır. Üçüncü kapsayıcı Tududi geçiş vekilidir ve ana makinenin ağında yalnız ayarlı yerel/özel adreste dinler. Bu Compose düzeni Linux içindir. Tududi'nin ilk açılışı tamamlanmadan ajan hesabı kurulumu bekleyebilir; panelde yeniden deneyebilirsiniz.

### Çalıştırıcı kullanıcı servisi

Önce derleyin:

```sh
cd runner
npm ci
npm run typecheck
npm test
npm run build
cd ..
```

Hazırlama komutu [servis şablonunu](runner/systemd/pixel-office-runner.service.example) kurulum ve Node yollarıyla `.cache/install/pixel-office-runner.service` içine doldurur. Bu dosyayı gözden geçirin; Codex başka dizindeyse `Environment=PATH=...` satırına o dizini ekleyin. Terminalde bulunan bir komut systemd'nin daha dar arama yolunda bulunmayabilir.

Servisi kurmak ve başlatmak istediğinizde şu komutları kendiniz çalıştırın:

```sh
mkdir -p "$HOME/.config/systemd/user"
cp .cache/install/pixel-office-runner.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now pixel-office-runner.service
```

Oturum kapandığında da çalışması gerekiyorsa sistem yöneticisi bu kullanıcı için kalıcı kullanıcı servislerini etkinleştirmelidir. Çalıştırıcı, kendi Linux hesabının yetkileriyle yönetim yapar; ayrı bir Linux hizmet hesabı kullanılması uygundur. Elle çalıştırma ve sınırlar: [çalıştırıcı belgesi](runner/README.tr.md).

## İlk giriş ve ilk iş

1. Panelin 9400 adresini açın. `office/.env` içindeki sahip şifresiyle giriş yapın; kullanıcı adı gerekmez.
2. Şirket kurallarını ve bölümleri oluşturun. Çalışan eklerken Codex'i, hesabınızda açık bir modeli ve görev talimatını seçin. Her çalışana ayrı Tududi hesabı açılır; hazır olmayan hesaplar panelde görünür.
3. Çalıştırıcının bağlı olduğunu kontrol edin. Genel Müdür terminalinden ilk görevi verin veya çalışana doğrudan yazın. İşler, mesajlar ve durumlar ofiste izlenir.
4. Gerekli klasörleri ve sabit komutları panelde tanımlayın. Yazma ve onay ayarlarını yalnız ihtiyacı olan çalışanlara verin. İşin tamamlanması kendi başına yayın başlatmaz.

## Güvenlik modeli ve sınırlar

Her ajan ayrı çalışma klasörü ve Tududi hesabıyla çalışır. Linux kutusu (`bubblewrap`) yalnız gereken çalışma zamanı dosyalarını, ajanın profilini ve izinli bağlantıları açar. Kişisel HOME, kişisel ayarlar ve diğer ajanların alanları bağlanmaz. Hizmet hesabının gerekli kimlik alanları özel profile kopyalanır; aynı hesabın kotası ajanlar arasında paylaşılabilir.

Codex kabuk komutlarının ağ erişimi kapalıdır; dosya ve ağ yalıtımı gerçek sondayla doğrulanamazsa iş başlamaz. Model sağlayıcısına erişen CLI ve güvenilir araç köprüsü sunucu ağını kullanır. Bütün süreç ağını alan adına göre süzen bir çıkış vekili bu sürümde yoktur. İzinli klasöre bağlanan sabit komutlar ayrı, ağı kapalı kutuda çalışır.

Sahibe ayrılmış işlemleri ajan anahtarı yapamaz. “Onayla yazar” bağlantıları ajana salt okunur açılır; ajan değişikliği kendi alanında hazırlar, sahip içeriği onaylar ve çalıştırıcı onaylanan baytları kopyalar. Hedef değişmişse işlem reddedilir. Çok dosyalı kopyalama tek işlemde geri alınamaz. Doğrudan yazılabilir bağlantıyı ayrıca seçerseniz o bağlantının verdiği yetki geçerlidir.

Ofis hesap sırlarını şifreli saklar; sahip oturumu imzalı, `httpOnly` çerez kullanır. Sırlar ve veri klasörleri git dışında tutulur. Sunucuya ve Linux hizmet hesabına erişimi de koruyun.

**Codex ile çalışma desteklenir. Claude ajanlarının seçenekleri hazırlanmıştır; gerçek Claude hesabıyla çalışma doğrulanmadı.** Model erişimi ve CLI uyumu hesabınıza bağlıdır. Yeni kurulumda gerçek iş vermeden önce ayrı deneme ortamınızda kontrol edin. Ajan çıktıları insan denetimi gerektirir.

## Geliştirme ve test

Her iki klasörde `npm ci` ardından `npm run typecheck`, `npm test` ve `npm run build` çalıştırılır. Ana testler sahte sağlayıcılarla çalışır; model hesabı veya canlı Tududi gerekmez. Kurulum yardımcısının testleri kökten `node --test scripts/install.test.mjs` ile çalışır.

İsteğe bağlı tarayıcı/görsel testler [Ofis belgesinde](office/README.tr.md) açıklanır. Görsel tabanlar `office/tests/__screenshots__` altındadır; iç belgelere ihtiyaç duymaz. İç geliştirme kayıtları ve yerel veriler [yayın hariç listesi](release-exclude.txt) ile temiz dağıtımdan çıkarılır. Mevcut deponun geçmişi temiz yayın olarak gönderilmemelidir.

## Yedekleme

Genel yedek aracı `python3 scripts/backup.py` komutudur; son 14 tamamlanmış yedeği `yedek/gunluk` altında tutar. Farklı çalışma kökünde `--work-dir` ile `OFIS_WORK_DIR` değerini verin; seçenekler `--help` ile görünür. Ofis/Tududi SQLite verilerini yedekleme yöntemiyle, yüklemeleri ve ajanların çalışma dosyalarını kopyalar. Kimlik dosyalarını, özel profilleri, `.env` dosyalarını ve sembolik bağlantıları almaz; bağlı dış klasörler yalnız `--folders-dir` ile ayrıca seçilirse alınır. Araç servisleri değiştirmez. Her veritabanı kendi içinde tutarlıdır; bütün hizmetlerde aynı işlem anının kopyası değildir. Bu aracın testi `python3 -B scripts/backup_test.py` ile çalışır.

Çalışan SQLite veritabanlarını yalnız ana dosyayı kopyalayarak yedeklemeyin; SQLite yedekleme yöntemini veya durdurulmuş servislerin tutarlı kopyasını kullanın. `office/data`, Tududi verileri ve ajan çalışma klasörleriyle birlikte gizli ayar ve hizmet kimliklerini ayrı, güvenli yerde saklayın. Özellikle Ofis veritabanı `OFIS_SECRET_KEY` olmadan eski hesap sırlarını açamaz. Yedekleri ve `.env` dosyalarını açık depoda yayımlamayın.

## Lisans

Kod [MIT lisansı](LICENSE) altındadır. Telif hakkı (c) 2026 mrekinci. Özgün görseller ve yazı tiplerinin ayrı CC0/OFL bildirimleri [görsel lisansları](office/public/assets/ASSET-LICENSES.md) dosyasındadır. Uyarlanmış Tududi ayrı depoda kendi lisansıyla dağıtılır.
