# Cloud asset and rights register — 30 October 2026

The supplied Crystal Archive concepts are visual references, not page assets.
The full mockup is never rendered behind HTML. All headings, captions, phase
labels, controls and links are real HTML. No private user files or account
screens were used. Artwork and implementation are materially AI-assisted.

## Shared design

`vendor/theme/theme-version.json` records design 1.0.3 from
`VOLPAROSSA/volparossa.github.io@251b8f385091d5f490d509fcadb94ca060ac94b6`.
The exporter ran from a clean detached checkout at that exact commit. Original
font WOFF2 files and SIL notices, project logo/alpha and technical derivatives,
GitHub Octicon/MIT notice, OpenCloud SVG and upstream notices travel unchanged.
Their full hashes and sources remain in the export manifest/notices.

The supplied original logo was visually inspected against the shared logo. No
new fox/V mark was generated. The OpenCloud mark retains its original colour,
proportions and protective space. Its use identifies the upstream project and
does not imply partnership, endorsement or trademark permission. The existing
asset register's [press terms](https://opencloud.eu/en/press/terms-of-use),
attribution and commercial-use consent condition are retained in
`vendor/theme/notices/ASSETS.md`; no third party was contacted.

## Real interface example

`assets/upstream/cloud-screen.webp` is **byte-identical** to the reviewed
homepage screenshot at the theme commit. It is the original OpenCloud Favorites
example, not a newly captured integration session or a reconstructed AI UI.

- Upstream: `opencloud-eu/docs`,
  `docs/user/files-and-folders/img/favorites/favorites-personal.png`.
- Original Git blob: `711096d42d694bc146741a48b3bf228cdf92ffba`.
- Original source SHA-256:
  `1d11ef2b6942b880090b1366cd83853bdb6a66b448e96ae81dde1c5e08783de7`.
- Source: OpenCloud GmbH. The upstream AGPL documentation notice is retained as
  `vendor/theme/assets/upstream/OPENCLOUD-DOCS-LICENSE.txt` and copied into output.
- Existing upstream transformation: crop (8,61)–(1272,711), then resize to
  1000×514; the profile header/outer frame are omitted and all three public sample
  files remain. **No new screenshot crop or functionality edit** was performed.
- The public caption explicitly says: “OpenCloud interface example. The
  VOLPAROSSA integration is in development.” Source, full example and license
  links appear immediately below. The screenshot is fitted with `contain`.

See `CONTENT.md` for why the brief's documented upstream fallback was selected.
The original software/documentation licenses are not replaced by the site GPL.

## Clean generated artwork

Six original PNG masters are retained in `masters/`; `generation.json` contains
the exact prompts, reference filenames and generation date. OpenAI image
generation created each separate clean scene/object without website text/UI.
The three object masters preserve true alpha. No generated mark is used.

| Master | Purpose and reference |
| --- | --- |
| `hero.png` | Translucent amber fox and separated facets; first section of concept 02, subordinate to selected 01. Dark left area for HTML. |
| `product-crystal.png` | Isolated decorative landscape crystal from concept 02's product section. Imagined scenery appears only in this decorative object. |
| `encrypted.png` | Opaque abstract patterned amber object for encrypted data, with no readable contents. Selected concept 01. |
| `fragments.png` | Matching separate abstract facets, reused in encryption and recovery. Selected concept 01. Counts are symbolic, not a recovery threshold. |
| `courtyards.png` | Third section of concept 03 only: three distinct workspaces, equal golden connections, sandstone courtyards at sunset. |
| `valley.png` | Selected concept 01's closing valley and amber formations, dark left foreground. |

`export_images.py` documents every crop in source pixel coordinates. Desktop
courtyards retain all three workspaces; mobile uses the complete wider scene.
Mobile fox composition removes the left text space while retaining the fox's
head, feet and tail. Exports are AVIF/WebP/JPEG at responsive widths; transparent
objects are WebP. JPEG is the scene fallback. `asset-manifest.json` records every
local master/export/icon/CSS/JS digest and size; theme assets have their own
unchanged manifest. The original masters are not copied to public output.

`src/page.html` supplies exact labels and accessible ordered steps. The document
outline is authored SVG. Lock, key, cube, laptop, check and play glyphs use
original [Lucide](https://github.com/lucide-icons/lucide) geometry pinned at
`a630cec77eac6568b989e87e4947a8bfe45caacd`; original SVGs, Git blob/source records
and the full ISC/Feather MIT notice are in `assets/icons/lucide/`. Rendering changes
only the SVG root attributes for size, inherited colour and decorative semantics.

## Byte and source verification

The original source ZIP and references remain outside the publication tree.
`reference-manifest.json` records their SHA-256 identities so the visual choice
is reviewable without accidentally publishing the mockups or attached brief.
The builder checks every vendored theme hash; the offline checker additionally
checks public paths, image presence, metadata and output separation. Fonts and
all imagery are local. No image service, tracker or font CDN runs in the browser.
