# Content sources and scope — 30 October 2026

Cloud source: `468e29f3ff1e183bfb67830e9fdfb893807e8f9b`, unchanged from the brief.
Shared site source: `251b8f385091d5f490d509fcadb94ca060ac94b6` (design 1.0.3),
newer than the brief's 1.0.2 snapshot. The live Core route and central docs route
were checked with HTTP 200. OpenCloud's English site is `https://opencloud.eu/en`.

The current AGENTS.md, README, ARCHITECTURE, OWNER_UPLOADS, PRIVATE_FILES,
OFFLINE_READ, RECOVERY_WEB, THIRD_PARTY_LICENSES and workflow were read. The
homepage README, architecture, asset register, export script, shared templates,
navigation, projects and applications data were inspected. The tree was clean;
work is isolated on a feature worktree. No runtime or policy files were changed.

| Visitor statement | Source at the Cloud commit above |
| --- | --- |
| Owner-side encryption before Core fragmentation; private metadata remains private | README.md; docs/ARCHITECTURE.md; docs/PRIVATE_FILES.md |
| Core chooses redundant placement and contribution accounting | README.md; docs/ARCHITECTURE.md |
| Source-off repeated reads preserve copies | docs/OWNER_UPLOADS.md#evidence-and-remaining-scope; docs/PRIVATE_FILES.md |
| Reassembly, ciphertext verification and local authenticated decryption | docs/PRIVATE_FILES.md; docs/OFFLINE_READ.md |
| Original interface supports separate owner-private new-file uploads | docs/OWNER_UPLOADS.md; docs/RECOVERY_WEB.md |
| Local keys, catalogs and journals; accounts, sharing, writable sync and cross-device recovery unfinished | README.md; docs/OWNER_UPLOADS.md; docs/ARCHITECTURE.md |

The status distinguishes previously documented evidence from future work.
Trial [37218270756](https://github.com/VOLPAROSSA/volparossa/actions/runs/37218270756)
is tied to Cloud `ffdcfaa15cdd2a029dae545904b0a58603da4e17` and Core
`929c2ff909f4e9704046459e0434006397dc9110`. It was not rerun for this website.
Older lower-level guides retain historical open-work wording; the later joined
upload evidence and current README are authoritative for the stated scoped result.
The page does not imply every client works without a server.

## Copy and visual interpretation

The brief's main English headings, text and status are retained. Additions are
short HTML phase labels, the explicit recovery prerequisites, read-only imports,
the separate new-file space and privacy boundary, all required by the brief and
supported by the sources above. No numeric replica count, subscription tier,
secret-sharing threshold, SLA or production-ready claim is introduced.
The courtyard buildings explicitly represent devices. Golden links are scenery,
not a claim about participants' geography, failure independence or personal trust.

The original upstream OpenCloud screenshot is the documented fallback. No
integration screenshot or prepared source-built demo is present in the selected
workspace/repository. Producing one would require a new upstream source/dependency
build and runtime setup, beyond reusing an available isolated demo. The existing
verified upstream bytes and notices were therefore reused, with the exact required
caption. The image is an example, not a live upload form or integration evidence.

## Independent central documentation change

The companion homepage change adds only a Cloud reading-path card linking to
README, architecture, uploads, private-file recovery, local reads, original Files
UI and the evidence section. Technical Markdown stays in Cloud. It does not
publish the Cloud site or enable its application registry flag. Until that card
is live, Cloud buttons deliberately target the existing generic `/docs/` route.
