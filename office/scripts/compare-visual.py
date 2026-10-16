"""Compare new screenshots pixel by pixel against saved baselines without changing them."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops

baseline, current = map(Path, sys.argv[1:3])
results = []
failed = False
for name in sys.argv[3:]:
    a = Image.open(baseline / name).convert('RGB')
    b = Image.open(current / name).convert('RGB')
    if a.size != b.size:
        results.append({'file': name, 'error': 'Image dimensions changed.', 'before': a.size, 'after': b.size})
        failed = True
        continue
    diff = ImageChops.difference(a, b)
    # Ignore tiny antialiasing differences without hiding displaced rings.
    red, green, blue = diff.split()
    maximum = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    # Diagonal icon edges showed 13/255 antialiasing differences at the same
    # position. Limit tolerance to 16/255; allow no changed-pixel count tolerance.
    changed = sum(maximum.histogram()[17:])
    ratio = changed / (a.width * a.height)
    entry = {'file': name, 'changedPixels': changed, 'ratio': ratio, 'passed': changed == 0}
    results.append(entry)
    diff_path = current / ('fark-' + name)
    if not entry['passed']:
        failed = True
        diff.save(diff_path)
        print(f"Unexpected image difference: {name}: {changed} pixels (%{ratio * 100:.4f})")
    else:
        diff_path.unlink(missing_ok=True)
(current.parent / 'karsilastirma.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
if failed:
    sys.exit(1)
print(f'{len(results)} saved screenshot comparisons passed.')
