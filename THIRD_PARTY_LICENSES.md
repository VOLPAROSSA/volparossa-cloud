# Third-party provenance

Original VOLPAROSSA integration code is GPL-3.0-only. This repository currently
contains no vendored OpenCloud implementation or executable distribution.

| Component | Exact source examined | License and use |
| --- | --- | --- |
| OpenCloud server v7.2.4 | `opencloud-eu/opencloud@1770793f2657e153836c32d32dd6d256b8531d3d` | Apache-2.0; production WebDAV/backend compatibility target. |
| OpenCloud Web v8.0.0 | `opencloud-eu/web@11e699ac82fda4dd113ac3ceb2ecb2dd74574045` | AGPL-3.0; examined for client and vault integration surfaces, not bundled or executed. |

Keep original license/notice files with any future incorporated upstream source;
the project's GPL-3.0-only label does not replace upstream component licenses.

- [Server license at the pin](https://github.com/opencloud-eu/opencloud/blob/1770793f2657e153836c32d32dd6d256b8531d3d/LICENSE)
- [Web source at the pin](https://github.com/opencloud-eu/web/tree/11e699ac82fda4dd113ac3ceb2ecb2dd74574045)
