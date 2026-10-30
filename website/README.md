# VOLPAROSSA Cloud website

The Crystal Archive product page: the amber fox, the original OpenCloud interface
example, and three explanations of encryption/fragmentation, shared storage and
owner-local recovery. All visitor text is English; the page works without JavaScript.

This is an isolated static website. It does not run the Cloud service, import
files, start Core or change OpenCloud patches. The root package/test commands are
unchanged. The existing GPL-3.0-only project license applies to original website
code; fonts, icons and upstream images retain their own notices.

## Build, check and preview

Python 3 standard library is the only build dependency. From the repository root:

```sh
python3 website/scripts/build.py
python3 website/scripts/check_site.py
python3 -m http.server 8770 --bind 127.0.0.1 --directory website/preview
```

Open **http://127.0.0.1:8770/volparossa-cloud/**, including the repository prefix.
The default build is `noindex,nofollow`; refreshing the project path works.
The builder only replaces a directory carrying its own build marker. Generated
output is ignored and contains only the page, local distribution assets/notices
and favicon. Masters, review images and source references are not published.

The separate explicit publication artifact can be inspected without deploying:

```sh
python3 website/scripts/build.py --production --output website/dist/volparossa-cloud
python3 website/scripts/check_site.py --production --output website/dist/volparossa-cloud
```

Its canonical, Open Graph URL and sitemap use
`https://volparossa.org/volparossa-cloud/`. It contains no CNAME or root-domain
robots policy. Production builds use indexable metadata only when explicitly
selected; publication is controlled by the separate manual workflow below.

## Shared theme and content maintenance

`vendor/theme/` is the unmodified source-only export of shared design **1.0.3**
from homepage commit `251b8f385091d5f490d509fcadb94ca060ac94b6`. Its manifest
pins every exported file. The build verifies that manifest and uses the original
navigation renderer, header, footer, fonts, logo, GitHub icon and base CSS/JS.
Only the footer status sentence is specialized at render time. The Cloud
breadcrumb identifies the current application; the shared menu order is retained.

Update the theme by running the owning repository's `scripts/export_theme.py
--source-only --output <new-directory>` from a clean reviewed exact commit, then
review an explicit vendor update. Do not independently edit the vendored files.
Cloud composition and finite animations live in `assets/cloud.css` and
`assets/cloud.js`. Neither runtime fetches nor remote fonts are used.

`src/page.html` contains semantic content. `src/content.json` holds source and
trial pins, review date and destinations. Update the review date only when
reviewing the underlying evidence. The existing Cloud trial was not rerun for
this website. See [CONTENT.md](CONTENT.md) and [ASSETS.md](ASSETS.md).

Documentation buttons use the verified live Cloud reading path at
`https://volparossa.org/docs/#cloud`. Homepage PR #9 published the maintained
source links before this release. The application publication flag is enabled
separately after the Cloud production page passes its live release check.

## Optional browser QA

Node is a development tool only. A pinned `package-lock.json` lives within this
website directory, separate from the Cloud runtime. With compatible installed
Chromium and Playwright Firefox browsers:

```sh
cd website
npm ci --ignore-scripts
CHROME_PATH=/usr/bin/chromium npm run qa
```

`SITE_QA_URL` and `SITE_QA_OUTPUT` override the preview URL and artifact directory.
The checker covers Chromium at 320/390/768/1440/1920 px, Firefox at
390/1440/1920/2560 px, axe accessibility, keyboard/menu operation, replay,
reduced motion, no JavaScript, landscape and 200% text enlargement. Screenshots
and results go to ignored `qa/`; selected evidence is retained in `review/`.
Firefox is the version pinned by Playwright's browser package. Install missing
browsers separately using the pinned Playwright tooling if your environment
needs them; building the public site never downloads a browser or dependencies.

For Lighthouse, with the preview server running:

```sh
CHROME_PATH=/usr/bin/chromium node node_modules/lighthouse/cli/index.js \
  http://127.0.0.1:8770/volparossa-cloud/ \
  --chrome-flags='--headless --no-sandbox' \
  --only-categories=performance,accessibility,best-practices \
  --output=json --output-path=qa/lighthouse-mobile.json
```

Add `--preset=desktop` for the desktop measurement. See [QA.md](QA.md) for actual
measured conditions and limitations, not a promise about visitor devices.

## Artwork exports

Clean generated PNG masters and prompts are retained in `masters/`; the supplied
mockups are not publication assets. `scripts/export_images.py` uses Pillow 12.3.0
with AVIF/WebP support for documented crops, responsive encodes and SHA-256
inventory. Pillow is only needed to regenerate artwork, not to build the site.
The encrypted object/facets are transparent; the exact labels, locks, keys,
arrows and sequence are HTML/SVG. The refined process illustrations use luminous
angular fragments, an encrypted polyhedron and a reassembled glass document,
connected by restrained SVG paths on a dark crystalline texture. Counts of
decorative shards are not protocol
parameters. The object family is reused for recovery.

## Publication preparation

`.github/workflows/cloud-website.yml` validates PRs and preserves a noindex
preview artifact. A push to main still validates only. Production build and
Pages deployment require a separate **manual workflow_dispatch on main**; PR
code receives no deployment token. All Actions use fixed reviewed SHA pins.

The read-only Pages inspection on 30 October 2026 returned `build_type=workflow`,
HTTPS enforced and URL `https://volparossa.org/volparossa-cloud/`. No setting,
source, DNS, CNAME or domain route was changed. Existing configuration is checked
without automatic enablement during the future manual publication workflow.
After approval, merge and dispatch on main; verify the deployed project path and
only then update the homepage application's published flag in a separate change.
The owner authorized publication after reviewing the prepared PR. Release results
and the live verification are recorded in PR #21 and the associated Actions runs.
