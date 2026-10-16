# Artwork and font sources

The office artwork in this folder is original work targeting the visual quality of Octask. No Octask artwork, logo or fragments taken from screenshots are included. No external furniture or character pack was used.

## Original office and character artwork

Author / production: OpenAI's built-in `imagegen` tool for the Pixel Office project. Cropping, pixel grid alignment, palette limits, color masks and animation adaptation were performed by this repository's pipeline. These assets are not presented as the work of an external artist.

The following images and atlas definitions created for this project may be redistributed under **CC0 1.0 Universal**. This is a reuse notice for this project's original artwork, not the license of a third-party pack. License text: [Creative Commons CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en). No guarantee is made concerning independent third-party rights or trademarks.

| File | Source / derivation | License |
| --- | --- | --- |
| `source/furniture.png` | Original 24-piece furniture sheet generated for this project; prompt: `source/GENERATION.md` | CC0-1.0 |
| `source/furniture-a1-5.png` | 24 additional pieces matching the original furniture style; built-in `imagegen`, prompt: `source/GENERATION.md` | CC0-1.0 |
| `source/furniture-a1-5.json` | Reviewed crop boxes, scales and source coordinates for desk screens | CC0-1.0 |
| `source/desk-laptop.png` | Additional workstation with an ultrawide monitor and laptop in the original style; built-in `imagegen`, prompt: `source/GENERATION.md` | CC0-1.0 |
| `source/characters.png` | Original 36-pose character sheet generated for this project; prompt: `source/GENERATION.md` | CC0-1.0 |
| `office-atlas.png` | Three original sources (`furniture.png`, `furniture-a1-5.png`, `desk-laptop.png`); cropping, normalized scales, original shared 128-color palette and alpha cleanup | CC0-1.0 |
| `office-atlas.json` | 49 objects and screen coordinates for six desk variants extracted by `scripts/prepare-art.py` | CC0-1.0 |
| `character-atlas.png` | `source/characters.png`; 32 × 48 pixels, 64 colors, six appearances and 108 frames | CC0-1.0 |
| `character-atlas.json` | Pose/frame coordinates extracted by `scripts/prepare-art.py` | CC0-1.0 |
| `character-masks.png` | Skin, hair, upper and lower clothing masks extracted from `source/characters.png` colors | CC0-1.0 |

There is no external asset repository. See the [generation prompts](source/GENERATION.md) and [atlas pipeline](../../scripts/prepare-art.py). Source images came from the generation tool rather than a downloaded pack or website. Walls, tiles, screen contents and signs are drawn in the same palette by `office/src/pixel/furniture.ts`.

## Bundled fonts

The fonts were downloaded on October 10, 2026 from the official Google Fonts open-source repository. The `OFL.txt` in each directory was reviewed: SIL Open Font License 1.1 permits redistributing fonts with the application. The license texts are preserved unchanged in the files below. TTF files were packaged as WOFF2 without modifying glyphs or names; Turkish glyphs are retained. The application does not contact Google Fonts at runtime.

| File | Author | License / file | Source and reviewed license |
| --- | --- | --- | --- |
| `fonts/Figtree.woff2` | The Figtree Project Authors; Erik Kennedy | SIL OFL 1.1 — `fonts/Figtree-OFL.txt` | [Source](https://github.com/google/fonts/tree/main/ofl/figtree), [license](https://github.com/google/fonts/blob/main/ofl/figtree/OFL.txt) |
| `fonts/BricolageGrotesque.woff2` | The Bricolage Grotesque Project Authors; Atelier Triay | SIL OFL 1.1 — `fonts/BricolageGrotesque-OFL.txt` | [Source](https://github.com/google/fonts/tree/main/ofl/bricolagegrotesque), [license](https://github.com/google/fonts/blob/main/ofl/bricolagegrotesque/OFL.txt) |
| `fonts/Tiny5.woff2` | The Tiny5 Project Authors; Gissio | SIL OFL 1.1 — `fonts/Tiny5-OFL.txt` | [Source](https://github.com/google/fonts/tree/main/ofl/tiny5), [license](https://github.com/google/fonts/blob/main/ofl/tiny5/OFL.txt) |
| `fonts/JetBrainsMono.woff2` | The JetBrains Mono Project Authors | SIL OFL 1.1 — `fonts/JetBrainsMono-OFL.txt` | [Source](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono), [license](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt) |

Each `fonts/*-OFL.txt` is identical to the corresponding official `OFL.txt` linked above. `SHA256SUMS` lists SHA-256 hashes for source artwork, atlases and fonts.
