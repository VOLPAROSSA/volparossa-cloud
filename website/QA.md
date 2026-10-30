# Initial website review — 30 October 2026

This records the pre-publication review. The subsequent owner-authorized release
and live checks are recorded in [PR #21](https://github.com/VOLPAROSSA/volparossa-cloud/pull/21).

The build was reviewed against selected Cloud concept 01, the original crystal
fox/glass in 02, the third courtyard section only in 03, the original logo and
the shared-family reference 05. Both attached instruction files were read in full.
Source pins, interpretation and upstream screenshot fallback are recorded in
[CONTENT.md](CONTENT.md) and [ASSETS.md](ASSETS.md).

## Actual browser review

The complete rendered page, including every below-fold section, was captured
and visually inspected in Firefox on desktop and mobile. The hero, encryption,
courtyards and recovery were also reviewed individually. Refinement corrected
image/label overlap, kept the complete fox visible on mobile, and darkened the
hero text area without changing the fox silhouette. The screenshot is large,
uncropped beyond the documented upstream excerpt, and separately attributed.

[Desktop page](review/firefox-1440-full.webp) ·
[Mobile page](review/firefox-390-full.webp) ·
[Encrypt](review/firefox-1440-how-it-works.webp) ·
[Participants](review/firefox-1440-participants.webp) ·
[Recover](review/firefox-1440-recover.webp)

The scripted browser checks used Chromium 154 and Playwright's Firefox, at:

- Chromium: 320, 390, 768, 1440 and 1920 pixels wide.
- Firefox: 390, 1440, 1920 and 2560 pixels wide.
- Mobile landscape: 844×390.
- No JavaScript: 390×844, including native menu interaction.
- 200% root text enlargement: 1440×900.

All checks passed: no horizontal page overflow, missing visible images, artwork
outside its diagram area, failed responses, JavaScript errors or external runtime
asset requests. axe WCAG 2 A/AA and 2.1 AA reported **zero violations** at 390 and
1440. The keyboard skip link, main focus, menu and Escape operation passed. Both
explanation buttons replay the sequence and finish within five seconds; scrolling
them off screen cancels motion. Reduced motion, including changing that preference
at runtime, disables animation and hides replay controls. With no JS, the complete
ordered explanations and native menu remain available. Hidden-tab cancellation
is implemented through `visibilitychange`; no claim of a physical-device/tab
power measurement is made. See [browser results](review/browser-results.json).

Public destination checks returned HTTP 200 for the Core page, central docs,
Get involved, credits and OpenCloud's English homepage. GitHub documentation paths
and evidence anchors were checked against the pinned local source. The separate
central-docs card passed 390/1440 renders, seven source links and axe with zero
violations. The Cloud site's buttons retain the already live generic docs route.

## Performance

Lighthouse **13.6.0**, installed headless Chromium **154**, Linux container,
loopback Python HTTP server, default simulated mobile throttling; separate
`--preset=desktop` run. These are local lab measurements, not field performance.
The exact settings and metrics are retained in
[lighthouse-summary.json](review/lighthouse-summary.json).

| Profile | Performance | Accessibility | Best practices | LCP | Blocking time | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Mobile | 97 | 100 | 100 | 2.6 s | 50 ms | <0.001 |
| Desktop | 100 | 100 | 100 | 0.7 s | 0 ms | 0.001 |

- Initial CSS/JS: **12,714 bytes gzip**, including the shared theme and tokens.
- Mobile hero 800px WebP fallback: **120,810 bytes**; smaller AVIF is preferred.
- Desktop hero 1536px WebP fallback: **229,798 bytes**; AVIF is preferred.
- Initial mobile subresource transfer in the 390px browser check: **168,407 bytes**
  (fonts included; navigation HTML is separate). With HTML included, still below
  0.25 MB and the 1.5 MB target. Browser lazy-loading distance can preload more
  on larger viewports. No-JS browsers may eagerly load lazy images; that measured
  mobile subresource transfer was 437,402 bytes.
- All large lower scenes are lazy-loaded, with local AVIF/WebP/JPEG responsive
  variants and explicit dimensions. The hero is eager/high priority.

## Build, provenance and boundaries

Both default noindex and explicit production builds passed the offline checker:
project-prefix paths/anchors, metadata, source hashes, original icon Git blobs,
local assets, single H1/landmarks, no external runtime resources and byte budgets.
The unchanged theme manifest is verified during every build. The supplied logo's
pixels/alpha match the shared original. Distribution assets are separated from
masters, instructions, tests and private/runtime sources. No domain CNAME or
root-domain robots file is copied.

The original Python owner-upload boundary tests passed (9/9). The existing
full Node runtime suite was also attempted in this workspace: 92 passed, 6 failed,
3 explicitly unstaged SDK tests skipped. Rechecking the unchanged base in a
shorter checkout reduced this to 103 passed, 5 failed, 3 skipped; the catalog
subtests could then run. A diagnostic wrapper outside the source tree captured
the closed helper code **`SnapshotError AGENT_PARENT_PATH_TOO_LONG`** for owner
uploads. The workspace lacks a short per-user GnuPG socket directory, and nested
synthetic upload paths hit the helper's existing Unix-socket path-length guard.
The same upload failures reproduce on unchanged base commit
`468e29f3ff1e183bfb67830e9fdfb893807e8f9b`. No runtime, tests, guard or host setup
was altered to make this green. This is a local environment limitation, not
website or live peer-storage evidence. The existing hosted workflow for that
base passed: [run 39850931824](https://github.com/VOLPAROSSA/volparossa-cloud/actions/runs/39850931824).
The PR's hosted results are tracked in its checks and description.

No new real OpenCloud/Core storage trial, device recovery, Safari test or physical
mobile-device test is claimed. The page reports the separately documented scoped
trial, not these website checks, as its integration evidence.

## Review and future publication

The Cloud page and central docs card are separate reviewable changes. No merge,
workflow dispatch, Pages setting, DNS/CNAME, registry publication flag, host
networking or production deployment was performed. Pages was read-only inspected
and already reports Actions mode with HTTPS enforced. A manual main-only
publication workflow is prepared; its publish jobs are excluded from PR/push
validation. The release and live verification remain a separate reviewed step.
