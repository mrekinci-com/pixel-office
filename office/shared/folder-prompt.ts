import { translate, type Language } from "./i18n/index.js";
import type { FolderLink } from "./runtime.js";

// Keep the full catalog on the server; include only an initial list in the prompt.
// A byte cap also bounds long paths and multibyte Turkish characters.
export function promptFolders(links: FolderLink[], language: Language = "tr"): (FolderLink & { belge_ozeti: string })[] {
  return links.map(({ documents, ...link }) => {
    if (!documents) return { ...link, belge_ozeti: translate(language,"Belge listesi henüz alınmadı. dizin-haritasi/{0}.txt dosyasını ve ilgili klasörü kontrol et.",[link.id]) };
    const selected: string[] = [];
    let bytes = 0;
    for (const path of documents || []) {
      const next = new TextEncoder().encode(JSON.stringify(path)).byteLength + 1;
      if (selected.length >= 200 || bytes + next > 16 * 1024) break;
      selected.push(path); bytes += next;
    }
    const remaining = (documents?.length || 0) - selected.length;
    return { ...link, documents: selected,
      documents_truncated: !!link.documents_truncated || remaining > 0,
      belge_ozeti: translate(language,"{0} dosya daha{1}. Ayrıntı için dizin-haritasi/{2}.txt dosyasını ve ilgili klasörü kontrol et.",[remaining,link.documents_truncated ? translate(language,"; tam katalog da sınırlıdır, klasörde başka dosyalar olabilir") : "",link.id]) };
  });
}
