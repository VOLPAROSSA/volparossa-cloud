# Third-party provenance

Original VOLPAROSSA integration code is GPL-3.0-only. This repository currently
contains no vendored OpenCloud implementation or executable distribution.

| Component | Exact source examined | License and use |
| --- | --- | --- |
| OpenCloud server v7.2.4 | `opencloud-eu/opencloud@1770793f2657e153836c32d32dd6d256b8531d3d` | Apache-2.0; production WebDAV/backend compatibility target. |
| OpenCloud Web v8.0.0 | `opencloud-eu/web@11e699ac82fda4dd113ac3ceb2ecb2dd74574045` | AGPL-3.0; examined for client and vault integration surfaces. Its separately integrity-pinned published SDK is used in an explicit optional interoperability test, not bundled as an application runtime. |
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

## Optional real OpenCloud Web SDK trial

`third_party/opencloud-web-sdk.json` pins the official published
`@opencloud-eu/web-client@8.0.0` archive and its SHA-512 registry integrity.
`scripts/stage_web_sdk.py --download --yes --output /absolute/worktree/build/NEW`
explicitly downloads and verifies it into a new ignored worktree directory.
All 109 files, including the unchanged upstream license and bundled code, are
retained. No package scripts, package-manager installation or global changes run.
The staged archive SHA-256 is
`8954d9ad90e44a6f62d0e32d3280ca92fd7b0ce30042fe07cdde5c653e0739b3`.
The corresponding version's source was inspected separately; this is not a
reproducible source-to-package build claim or a redistribution of that SDK.

The optional SDK test runs the original `webdav` factory, XML response parser,
HTTP transport, `listFiles` and `getFileContents` against a real loopback listener.
Its backend is explicitly synthetic. It proves the tested SDK reads/listings and
authentication boundary, not protected peer recovery or the complete OpenCloud UI.
Normal tests skip this trial unless `VOLPAROSSA_CLOUD_WEB_SDK` explicitly points
at the staged verified SDK; they never download executable dependencies.

- [Published SDK identity](https://registry.npmjs.org/@opencloud-eu/web-client/8.0.0)
- [Original read adapter](https://github.com/opencloud-eu/web/blob/11e699ac82fda4dd113ac3ceb2ecb2dd74574045/packages/web-client/src/webdav/getFileContents.ts)
- [Original listing adapter](https://github.com/opencloud-eu/web/blob/11e699ac82fda4dd113ac3ceb2ecb2dd74574045/packages/web-client/src/webdav/listFiles.ts)
