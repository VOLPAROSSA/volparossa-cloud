# Cloud concept fidelity review

## Hero correction — 31 October 2026

The owner's final clarification requests a generous, screen-filling hero and the
fox's forward-moving anatomy from the concept. Starting from published commit
`2a61e1a5a3f1a8b5b5aa1ae4192972b4bd16e527`, the hero master was edited to remove
the false plume between the legs, retain one main tail, and separate the natural
leg shapes. The exact edit prompt and reference lineage are in
[ASSETS.md](ASSETS.md) and [masters/generation.json](masters/generation.json).

The desktop hero now fills the viewport with content-safe minimum heights.
Contained, right-aligned artwork preserves the feet on tall and wide screens;
mobile keeps the complete fox below the copy. All other sections retain their
published artwork and styling. The desktop/mobile full-page screenshots below
have been refreshed, together with the hero detail views:

[1440px hero](review/firefox-1440-top.webp) ·
[2560px hero](review/hero-firefox-2560.webp) ·
[390px hero](review/firefox-390-top.webp)

Targeted checks passed in Chromium at 320, 390, 768, 1440, 1920, 2560 and 3440px,
plus 844×390 landscape, no JavaScript and 200% text enlargement. Firefox passed
at 390, 1440, 1920 and 2560px. All loaded hero images remain contained with no
horizontal overflow or header overlap. Desktop hero heights match the viewport
at 1440×900, 1920×1080, 2560×1440 and 3440×1440. Actual Firefox desktop/mobile
screenshots were inspected; zero axe A/AA and 2.1 AA violations were reported at
390 and 1440px. [Current browser results](review/hero-results.json).

A fresh mobile Lighthouse run reports **96 performance, 100 accessibility and
100 best practices**, with LCP 2.7s, blocking time 20ms and CLS 0. These are local
lab measurements using the same tool and throttling described below.
[Current Lighthouse metrics](review/hero-lighthouse-summary.json).
Preview and production builds pass the offline checker and `git diff --check`;
CSS/JS totals **13,885 bytes gzip**. Hero and social derivatives, asset hashes
and provenance were regenerated from the corrected master.

## Previous full-page review (PR #22)

The broader checks and measurements below describe the preceding all-sections
revision. They were not rerun for this narrowly scoped hero correction.

The owner requested a closer match to the selected Crystal Archive concept after
publication of PR #21. This revision starts from published Cloud commit
`5bfbf975b01e14135160937f22edeb4a476f4c43`. Both supplied briefs and the selected
reference were revisited; the unchanged source/theme pins and screenshot choice
are recorded in [CONTENT.md](CONTENT.md) and [ASSETS.md](ASSETS.md).

## Visual comparison

The complete actual page was compared with selected concept 01, including every
section below the fold. The finished desktop/mobile Firefox renders are retained:

[Desktop page](review/firefox-1440-full.webp) ·
[Mobile page](review/firefox-390-full.webp)

| Section | Fidelity correction |
| --- | --- |
| [Hero](review/firefox-1440-top.webp) | Larger shared brand, full fox silhouette and quieter left copy area. The compact height was subsequently replaced by the screen-filling treatment above. |
| [OpenCloud](review/firefox-1440-opencloud.webp) | Larger original brand, central real interface, full-height amber landscape crystal and soft paper-to-dark edge transition. |
| [Encrypt](review/firefox-1440-how-it-works.webp) | Luminous angular encrypted crystal and matching facets, fine SVG light paths, textured burgundy background and a shaded document outline. |
| [Participants](review/firefox-1440-participants.webp) | Title on a feathered parchment transition over the wide courtyard scene, followed by a compact three-part explanation band. |
| [Recover](review/firefox-1440-recover.webp) | Large returning facets flow toward a reassembled glass document. Explicit verification, local decryption and the ordinary file remain in the ordered HTML explanation. |
| [Development](review/firefox-1440-development.webp) | Compact introduction beside proof and unfinished-work columns. Owner-local recovery limitations stay visible. Supplementary evidence/privacy scope uses a native disclosure. |
| Closing/footer | Shallower valley panorama, a single-line desktop headline and tighter shared footer spacing. |

At 1440px, that revision was approximately 16% shorter than the original 5339px render,
closer to the selected reference's overall rhythm. The real attributed upstream
interface, shared navigation order and explicit development limitations remain
intentional differences from the concept's invented interface and abbreviated
copy. All text and controls are HTML, not a screenshot of the concept.

During actual visual review, 200% text enlargement exposed a header/hero overlap;
font-relative spacing fixed it, and a geometry assertion now guards it. A final
paint-only mask adjustment removed a straight seam beside the product crystal;
the mobile/desktop Firefox product and full-page renders were refreshed afterward.
External-link arrows use exact decorative SVG geometry so a missing fallback
font cannot turn them into empty glyph boxes.

## Browser and accessibility checks

All scripted checks passed on Chromium 154 and Playwright Firefox:

- Chromium: 320, 390, 768, 1440 and 1920px.
- Firefox: 390, 1440, 1920 and 2560px.
- Mobile landscape 844×390, no JavaScript at 390×844, 200% text at 1440×900.
- No horizontal overflow, header/content overlap, missing visible images,
  artwork escaping its area, JavaScript errors, failed requests or external
  runtime asset requests.
- Zero axe WCAG A/AA and 2.1 AA violations at 390 and 1440px.
- Keyboard skip/main focus, native menu, Escape, both finite replays and
  offscreen cancellation; reduced motion including live preference changes.
- Native evidence disclosure works with JavaScript disabled and from the
  keyboard. Ordered explanations remain complete without animation.

[Machine-readable browser results](review/browser-results.json). Screenshots
were inspected at actual desktop/mobile widths, not only as a page thumbnail.
No physical-device or Safari testing is claimed.

## Performance and build

Lighthouse 13.6.0, headless Chromium 154, Linux container, Python loopback HTTP
server; default simulated mobile throttling and a separate desktop preset.
These are local lab measurements, not field guarantees. The measurement preceded
only the final decorative edge-mask paint adjustment described above.

| Profile | Performance | Accessibility | Best practices | LCP | Blocking time | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Mobile | 95 | 100 | 100 | 2.9 s | 70 ms | 0 |
| Desktop | 99 | 100 | 100 | 1.0 s | 0 ms | 0.001 |

[Settings and metrics](review/lighthouse-summary.json). CSS/JS totals **13,888
bytes gzip**. The Chromium 390px initial subresource transfer was **543,125
bytes**, including local fonts and the new texture; navigation HTML is separate.
With HTML it remains below the 1.5MB mobile target. Lighthouse's full measured
mobile transfer was 803KiB. Responsive hero files retain their previous budgets.
All later scene images are lazy-loaded; masters are not shipped.

Both noindex preview and explicit production builds pass the offline checker:
project-prefix paths, anchors, metadata, public-output boundaries, asset hashes,
original icon blobs, shared-theme identity and byte budgets. `git diff --check`
passes. The runtime, patches, storage policy, host network and domain settings
are unchanged. No new storage trial is claimed; hosted repository checks and the
manual main-only publication are recorded in the refinement pull request.
