#!/usr/bin/env python3
"""Maintainer-only image exports. Pillow 12.3.0; no build/runtime dependency."""
from pathlib import Path
from PIL import Image
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'assets/scenes'
OUT.mkdir(parents=True, exist_ok=True)
# Technical crop boxes preserve the fox's ears, paws and full tail, and at least
# two workspaces on mobile. Masters remain untouched. Coordinates in source pixels.
CROPS = {
    'hero': {'desktop': (0, 65, 1536, 985), 'mobile': (400, 65, 1536, 985)},
    'courtyards': {'desktop': (0, 150, 1536, 850), 'mobile': (0, 0, 1536, 1024)},
    'valley': {'desktop': (0, 175, 1536, 815), 'mobile': (0, 175, 1536, 1024)},
}
variants = {}
for name, compositions in CROPS.items():
    master = Image.open(ROOT/'masters'/f'{name}.png').convert('RGB')
    variants[name] = {}
    for kind, box in compositions.items():
        source = master.crop(box)
        variants[name][kind] = []
        widths = (480, 800) if kind == 'mobile' else (960, 1536)
        for width in widths:
            size = (width, round(width*source.height/source.width))
            image = source.resize(size, Image.Resampling.LANCZOS)
            stem = f'{name}-{kind}-{width}'
            image.save(OUT/(stem+'.avif'), quality=59, speed=6)
            image.save(OUT/(stem+'.webp'), quality=83, method=6)
            image.save(OUT/(stem+'.jpg'), quality=85, optimize=True, progressive=True)
            variants[name][kind].append(dict(stem=stem, width=size[0], height=size[1]))
for name, maxsize in [('product-crystal',(768,1152)), ('encrypted',(500,500)), ('recovered',(500,500)), ('fragments',(900,600)), ('crystal-texture',(1200,800))]:
    image = Image.open(ROOT/'masters'/f'{name}.png')
    image.thumbnail(maxsize, Image.Resampling.LANCZOS)
    image.save(OUT/(name+'.webp'), quality=87, method=6)
# Crop only the clean artwork for the conventional social-card aspect ratio.
hero = Image.open(ROOT/'masters/hero.png').convert('RGB').crop((0,130,1536,936))
hero.resize((1200,630),Image.Resampling.LANCZOS).save(OUT/'social.jpg', quality=85, optimize=True)
(OUT/'variants.json').write_text(json.dumps(variants,indent=2)+'\n')
manifest = {'crop_boxes':CROPS, 'files':{}}
for directory in [ROOT/'masters', ROOT/'assets']:
    for p in sorted(directory.rglob('*')):
        if p.is_file():
            manifest['files'][p.relative_to(ROOT).as_posix()] = {'bytes':p.stat().st_size, 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
(ROOT/'asset-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Exported responsive imagery; original masters retained.')
