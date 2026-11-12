"""Regenerate public font ranges (fonttools[woff] required); no glyph changes."""
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
root = Path(__file__).resolve().parents[2]
source = root / 'apps/web/src/assets/DestinySymbols.woff2'
folder = root / 'apps/web/src/features/reports/public/symbols'
folder.mkdir(exist_ok=True)
cmap = TTFont(source, recalcTimestamp=False).getBestCmap()
blocks = sorted({cp // 64 for cp in cmap if cp > 32})
css = []
for block in blocks:
    points = [cp for cp in cmap if cp // 64 == block]
    font = TTFont(source, recalcTimestamp=False)
    options = subset.Options()
    options.flavor = 'woff2'
    worker = subset.Subsetter(options=options)
    worker.populate(unicodes=points)
    worker.subset(font)
    name = f'{block * 64:04x}.woff2'
    font.save(folder / name)
    ranges = ', '.join(f'U+{cp:X}' for cp in points)
    css.append(f"@font-face {{ font-family: ReportSymbols; src: url('./symbols/{name}?no-inline') format('woff2'); font-display: swap; unicode-range: {ranges}; }}")
(folder.parent / 'symbols.scss').write_text('\n'.join(css) + '\n')
