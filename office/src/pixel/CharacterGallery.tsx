import { t as tx } from "../i18n";
import { hairStyles, hairLabels, type Appearance } from "../../shared/types";
import { Avatar } from "./OfficeCanvas";
export function CharacterGallery() {
  const base: Appearance = {
    skin: "#e5b88f",
    hair: "#443830",
    shirt: "#638e84",
    pants: "#3c4b5a",
    style: "kisa",
  };
  const variants = [
    ...hairStyles.map((style, i) => ({
      label: tx(hairLabels[i]),
      appearance: {
        ...base,
        style,
        skin: ["#e9bb8f", "#bc825f", "#875639"][i % 3],
        hair: ["#3c3445", "#85543c", "#b8a67f"][i % 3],
        shirt: ["#438f8b", "#b57581", "#6486b1", "#bd9845"][i % 4],
      },
    })),
    { label: tx("Gözlük"), appearance: { ...base, glasses: true } },
    { label: tx("Kravat"), appearance: { ...base, tie: true } },
    { label: tx("Kulaklık"), appearance: { ...base, headphones: true } },
  ];
  return (
    <div className="character-gallery" aria-label={tx("Karakter görünüm örnekleri")}>
      {variants.map((v) => (
        <div key={v.label}>
          <Avatar appearance={v.appearance} size={60} />
          <span>{v.label}</span>
        </div>
      ))}
      <p>{tx("Ten, saç ve kıyafet renklerini dilediğiniz gibi seçebilirsiniz.")}</p>
    </div>
  );
}
