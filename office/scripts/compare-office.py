"""Measure scene coverage and compare side by side with the full reference.

Example (from the repository root):
  python3 office/scripts/compare-office.py --reference <image-path>

Use native-resolution PNGs and measurements produced by browser tests.
Treat the entire flat-floor palette, including grout/texture, as floor. Exclude
whole 64×96 agent rectangles to obtain a conservative lower bound on
furniture coverage. DOM signs are excluded as well.
The reference is neither cropped nor imported into app assets. Requires Pillow.
"""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageColor, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument("--scene", action="store_true", help="Compare only the scene instead of the full application")
parser.add_argument("--reference", type=Path, help="The user’s complete reference image")
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
output = root / "office/.test-data/screenshots"
meta = json.loads((output / "ofis-olcum-girdi.json").read_text())
native = Image.open(output / meta["image"]).convert("RGB")
assert list(native.size) == [meta["width"], meta["height"]], "PNG dimensions do not match the world."
interior = meta["interior"]
area = interior["w"] * interior["h"]
floor_colors = {ImageColor.getrgb(color) for color in meta["floorColors"]}
actor_mask = Image.new("1", native.size)
mask_draw = ImageDraw.Draw(actor_mask)
for actor in meta["actors"]:
    mask_draw.rectangle((actor["x"], actor["y"], actor["x"] + actor["w"] - 1, actor["y"] + actor["h"] - 1), fill=1)
pixels, actors = native.load(), actor_mask.load()
non_floor = covered = 0
for y in range(interior["y"], interior["y"] + interior["h"]):
    for x in range(interior["x"], interior["x"] + interior["w"]):
        if pixels[x, y] not in floor_colors:
            non_floor += 1
            if not actors[x, y]:
                covered += 1
result = {
    "method": "Native PNG excluding all flat floor/grout/texture colors, agent rectangles and DOM signs. Count furniture, walls, rugs and their small shadows.",
    "interior_pixels": area,
    "non_floor_pixels": non_floor,
    "covered_pixels_without_actors": covered,
    "coverage_ratio": covered / area,
    **meta["geometry"],
}
(output / "ofis-olcum.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(f"Island / interior width: %{result['island_ratio'] * 100:.2f}")
print(f"Interior scene coverage (agents excluded): %{result['coverage_ratio'] * 100:.2f} ({covered:,} / {area:,} pixels)")
print(f"World aspect ratio: {result['aspect_ratio']:.4f}; row step / desk+chair: {result['row_step_ratio']:.4f}")

if args.reference:
    reference = Image.open(args.reference).convert("RGB")
    scene = Image.open(output / ("ofis-sahne.png" if args.scene else "ofis.png")).convert("RGB")
    height = 1080
    reference = reference.resize((round(reference.width * height / reference.height), height), Image.Resampling.LANCZOS)
    scene = scene.resize((round(scene.width * height / scene.height), height), Image.Resampling.NEAREST)
    comparison = Image.new("RGB", (reference.width + scene.width + 64, height + 114), "#eef0f6")
    draw = ImageDraw.Draw(comparison)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)
    except OSError:
        font = small = ImageFont.load_default()
    draw.text((20, 17), "Octask · user layout reference", font=font, fill="#161a2e")
    draw.text((reference.width + 44, 17), "Pixel Office · new application layout", font=font, fill="#161a2e")
    comparison.paste(reference, (16, 60))
    comparison.paste(scene, (reference.width + 48, 60))
    draw.text((16, height + 82), "The full reference is shown only for review. Octask artwork is not used in the application.", font=small, fill="#434a66")
    comparison.save(output / "karsilastirma.png")
    print("Side-by-side comparison saved to office/.test-data/screenshots/karsilastirma.png.")

assert result["island_ratio"] >= 0.15, "Island width is below target."
assert result["coverage_ratio"] >= 0.38, "Scene coverage is below the 38% target; revise the layout."
