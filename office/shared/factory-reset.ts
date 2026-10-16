// Kerem's factory reset design, ported from the GM team's reviewed patch.
export const resetScope = 'Seçilen ajanların Tududi hesaplarındaki tüm görevler (tamamlanan, arşivlenen, alt görevler ve tekrarlayan görevlerin mevcut kayıtları dahil), notlar ve projeler silinir. Projeye bağlı notlar da silinir. Alanlar, etiketler ve Tududi’nin ilişki geçmişi bu sıfırlamanın kapsamı dışındadır. Başkasına ait veya yalnız paylaşımla erişilen kayıtlar silinmez. Hafıza, iş notu, konuşma oturumları, bekleyen işler, zamanlamalar ve zamanlama geçmişi temizlenir. Kullanım ve çalışma sayıları korunur; çalışma içerikleri temizlenir. Teslim dosyaları, geçmiş onaylar, komut sonuçları, ortak notlar, mesajlar, devirler, olaylar ve günlük özetler kalır. Kimlik, izin, hesap, bağlantı, komut, bölüm ve şirket kuralları korunur. Yedek uygulama veritabanında şifrelenir, yalnız sahip indirir; indirilen dosya okunabilir veri içerir. Otomatik geri yükleme yoktur; kimlikler ve süreçler birebir geri getirilemez.';
export const resetCountLabels: Record<string, string> = {
    Task: 'Görevler', Note: 'Notlar', Project: 'Projeler', memories: 'Hafıza', work_items: 'İş kalemleri', agent_sessions: 'Oturumlar', notebook_cache: 'Defter önbelleği', notebook_marks: 'Not işaretleri', notebook_writes: 'Not yazım kayıtları', scheduled_tasks: 'Zamanlanmış işler', schedule_history:'Zamanlama geçmişi', schedule_retirements: 'Bekleyen iş kapatmaları', login_tickets: 'Geçici girişler', pending: 'Bekleyen çalışmalar', content: 'İçeriği temizlenecek çalışmalar', approvals: 'Bekleyen onaylar', command_jobs: 'Bekleyen komutlar', director_state: 'Genel Müdür defteri ve takibi',
};
export type ResetState = 'preview' | 'quiescing' | 'deleting' | 'partial' | 'completed';
export interface ResetResult {
    id: string;
    name: string;
    ok: boolean;
    remaining: string[];
    counts: Record<string, number> | null;
}
export interface ResetView {
    id: string;
    state: ResetState;
    scope: string;
    error?: string;
    backupReady: boolean;
    agents: {
        id: string;
        name: string;
        counts: Record<string, number>;
    }[];
    results?: ResetResult[];
}
