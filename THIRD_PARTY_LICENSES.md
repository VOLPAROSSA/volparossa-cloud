# Third-party provenance

Original VOLPAROSSA integration code is GPL-3.0-only. This repository currently
contains no vendored OpenCloud implementation or executable distribution.

| Component | Exact source examined | License and use |
| --- | --- | --- |
| OpenCloud server v7.2.4 | `opencloud-eu/opencloud@1770793f2657e153836c32d32dd6d256b8531d3d` | Apache-2.0; production WebDAV/backend compatibility target. |
| OpenCloud Web v8.0.0 | `opencloud-eu/web@11e699ac82fda4dd113ac3ceb2ecb2dd74574045` | AGPL-3.0; examined for client and vault integration surfaces, not bundled or executed. |
| VOLPAROSSA Image helpers | `VOLPAROSSA/volparossa-image@9e925bdb1bde4d7686868e7aa826fd8144aca91e` | GPL-3.0-only; unchanged OpenPGP process helpers and private core-storage bridge, including their complete license. |

Keep original license/notice files with any future incorporated upstream source;
the project's GPL-3.0-only label does not replace upstream component licenses.

- [Server license at the pin](https://github.com/opencloud-eu/opencloud/blob/1770793f2657e153836c32d32dd6d256b8531d3d/LICENSE)
- [Web source at the pin](https://github.com/opencloud-eu/web/tree/11e699ac82fda4dd113ac3ceb2ecb2dd74574045)
- [Image source at the pin](https://github.com/VOLPAROSSA/volparossa-image/tree/9e925bdb1bde4d7686868e7aa826fd8144aca91e)

`third_party/volparossa-image-source.json` records the exact original paths,
local paths, byte lengths and SHA-256 digests. The three files under
`vendor/volparossa-image/` are unmodified. Cloud reuses the isolated GnuPG process,
private output publication and core-owned storage contracts, not the Immich
snapshot format or a claim of Immich compatibility. GnuPG is an explicitly
required, already installed executable; no GnuPG binary is bundled or fetched.
