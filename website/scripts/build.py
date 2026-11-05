#!/usr/bin/env python3
"""Build the isolated Cloud website; defaults to a noindex review preview."""
import argparse
import hashlib
from html import escape
import importlib.util
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
THEME = ROOT / 'vendor/theme'
DATA = json.loads((ROOT / 'src/content.json').read_text())


def render(source, values):
    def replace(match):
        key = match.group(1)
        if key not in values:
            raise ValueError(f'Unknown template variable: {key}')
        return str(values[key])
    return re.sub(r'{{(\w+)}}', replace, source)


def icon(name):
    svg = (ROOT / 'assets/icons/lucide' / f'{name}.svg').read_text()
    return re.sub(r'<svg\b[^>]*>', '<svg class="cloud-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">', svg, count=1)


def picture(name, hero=False):
    inventory = json.loads((ROOT / 'assets/scenes/variants.json').read_text())
    group = inventory[name]
    sources = []
    for kind, media in [('mobile', '(max-width: 800px)'), ('desktop', None)]:
        if kind not in group:
            continue
        items = group[kind]
        condition = f' media="{media}"' if media else ''
        for ext, mime in [('avif','image/avif'), ('webp','image/webp'), ('jpg','image/jpeg')]:
            srcset = ', '.join(f'assets/scenes/{item["stem"]}.{ext} {item["width"]}w' for item in items)
            sources.append(f'<source{condition} type="{mime}" srcset="{srcset}" sizes="100vw" width="{items[-1]["width"]}" height="{items[-1]["height"]}">')
    fallback = group['desktop'][-1]
    loading = 'fetchpriority="high"' if hero else 'loading="lazy" decoding="async"'
    return '<picture class="cloud-picture">' + ''.join(sources) + f'<img src="assets/scenes/{fallback["stem"]}.jpg" width="{fallback["width"]}" height="{fallback["height"]}" alt="" {loading}></picture>'


def build(output, production):
    # The export is immutable: abort rather than silently updating shared components.
    manifest = json.loads((THEME / 'theme-version.json').read_text())
    if manifest['source_commit'] != DATA['theme_commit']:
        raise SystemExit('Unexpected shared theme source')
    for name, expected in manifest['files'].items():
        if hashlib.sha256((THEME / name).read_bytes()).hexdigest() != expected:
            raise SystemExit('Changed vendored theme file: ' + name)
    output = output.resolve()
    if output == ROOT or output in ROOT.parents or output.is_relative_to(ROOT / 'src') or output.is_relative_to(THEME) or output.is_relative_to(ROOT / 'assets'):
        raise SystemExit('Output must be a dedicated build directory')
    if output.exists() and any(output.iterdir()) and not (output / '.cloud-website-build').exists():
        raise SystemExit('Refusing to replace a directory not owned by this builder')
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    (output / '.cloud-website-build').write_text('Public static Cloud website output\n')
    shutil.copytree(THEME / 'assets', output / 'assets')
    shutil.copytree(ROOT / 'assets', output / 'assets', dirs_exist_ok=True)
    shutil.copy2(THEME / 'favicon.ico', output / 'favicon.ico')
    shutil.copy2(THEME / 'LICENSE', output / 'LICENSE')
    (output / '.nojekyll').touch()
    spec = importlib.util.spec_from_file_location('shared_navigation', THEME / 'shared/navigation.py')
    navigation_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(navigation_module)
    nav = json.loads((THEME / 'data/navigation.json').read_text())
    projects = json.loads((THEME / 'data/projects.json').read_text())
    links = navigation_module.site_links(nav, projects, 'https://volparossa.org/', {'github': DATA['repository'], 'core': DATA['core']})
    github = (THEME / 'assets/icons/github.svg').read_text().replace('<svg ', '<svg class="github-icon" aria-hidden="true" focusable="false" ', 1)
    # Cloud's breadcrumb carries aria-current; common navigation order is unchanged.
    values = {**links, 'root':'', 'github_icon':github}
    values['nav_links'] = navigation_module.navigation_links(nav['main'], links, github_icon=github)
    values['footer_links'] = navigation_module.navigation_links(nav['footer'], links, github_icon=github, footer=True)
    values['header'] = render((THEME / 'templates/header.html').read_text(), values)
    values['footer'] = render((THEME / 'templates/footer.html').read_text(), values).replace('Independent open-source project · In development', 'Independent project. Integration in development.')
    values.update({key:escape(str(value), quote=True) for key,value in DATA.items() if isinstance(value,str)})
    values.update(screenshot_caption=escape(DATA['screenshot']['caption']), screenshot_source=escape(DATA['screenshot']['source']), trial_url=DATA['trial']['url'])
    values.update(hero_picture=picture('hero', True), courtyards_picture=picture('courtyards'), valley_picture=picture('valley'))
    values.update({key+'_icon':icon(name) for key,name in {'lock':'lock-keyhole','key':'key-round','cube':'box','devices':'laptop','check':'circle-check','play':'play'}.items()})
    # Exact document outline is code, not an image of generated text. ID-free for reuse.
    for name in ['document', 'recovered_document']:
        values[name+'_icon'] = f'<svg class="file-document" viewBox="0 0 110 145" aria-hidden="true" focusable="false"><defs><linearGradient id="{name}-paper" x2="1" y2="1"><stop stop-color="#fff0d4"/><stop offset=".45" stop-color="#dfb579"/><stop offset="1" stop-color="#a96a36"/></linearGradient><linearGradient id="{name}-edge" x2="0" y2="1"><stop stop-color="#ffdc9b"/><stop offset="1" stop-color="#91521f"/></linearGradient></defs><path d="M18 5h53l26 27v108H18z" fill="#6c361c" stroke="#edb366" stroke-width="3"/><path d="M14 3h54l25 27v107H14z" fill="url(#{name}-paper)" stroke="#f6ca83" stroke-width="1.5"/><path d="M68 3v28h25" fill="url(#{name}-edge)" stroke="#ffdda3" stroke-width="1.5"/><path d="M27 54h49M27 68h49M27 82h49M27 96h36M27 110h41" stroke="#825732" stroke-width="3" stroke-linecap="round"/><path d="M27 52h49M27 66h49M27 80h49M27 94h36M27 108h41" stroke="#ffe6be" stroke-width="1" stroke-linecap="round"/></svg>'
    values['content'] = render((ROOT / 'src/page.html').read_text(), values)
    values.update(social_image=DATA['canonical']+'assets/scenes/social.jpg', social_alt='A fox sculpted from luminous amber glass on a dark burgundy background.', body_class='cloud-page')
    robots = 'index,follow' if production else 'noindex,nofollow'
    values['head_extra'] = f'<meta name="robots" content="{robots}"><link rel="stylesheet" href="assets/cloud.css"><script src="assets/cloud.js" defer></script>'
    html = render((THEME / 'templates/layout.html').read_text(), values)
    # A text-node-only replacement avoids missing-arrow glyphs in minimal browsers.
    external_arrow = '<svg class="external-arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 13 13 3M3 3h10v10"/></svg>'
    html = re.sub(r'(>[^<>]*)↗', lambda match: match.group(1)+external_arrow, html)
    (output / 'index.html').write_text(html)
    if production:
        (output / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>'+DATA['canonical']+'</loc></url></urlset>\n')
    # No root-domain robots.txt or CNAME belongs to this project publication.
    print(f'Built {"production" if production else "noindex preview"}: {output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'preview/volparossa-cloud')
    parser.add_argument('--production', action='store_true', help='Explicitly build indexable publication metadata')
    args = parser.parse_args()
    build(args.output, args.production)
