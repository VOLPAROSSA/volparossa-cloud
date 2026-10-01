# OpenCloud integration: executable slices and boundaries

## Source contract

Use the production server baseline
`opencloud-eu/opencloud@1770793f2657e153836c32d32dd6d256b8531d3d` (v7.2.4).
File access uses the authenticated `/dav/spaces/{resourceID}/{path}` surface.
Preserve the source version with a strong ETag and conditional requests; a file
that changes during import must not be silently assembled from multiple versions.

The first adapter accepts explicit resource IDs and path segments. It does not
crawl all accounts, acquire credentials automatically, follow redirects with a
bearer token or silently fall back to public HTTP. Loopback HTTP is only an
explicit synthetic-test option. Token refresh, account enrollment and a browser
login flow remain separate work.

## Source-off file access

1. Import an explicitly authorized selection via WebDAV, retaining authenticated
   source identity, resource ID and version in private metadata.
2. Encrypt each file and a versioned directory catalog on the authorized device.
   Send only opaque objects to the shared core's private fragment storage.
3. Recover the catalog and needed file fragments on an authorized owner device.
   Supply read-only DAV listing, HEAD, GET, ranges and conditional requests.
4. Test the actual pinned OpenCloud web-client file adapter with the source server
   stopped and no original-file fallback. Test loss of a storage provider without
   inventing receipts or dropping the core's retention/accounting rules.

The one-file slice implements authorized import, private encrypted source
metadata, a per-file recovery key, a core-storage command adapter and atomic
owner recovery. Its protected-peer trial now passes with the synthetic source
off, local ciphertext removed and one of three providers unavailable; two
restores retain the surviving copies and preserve their actual charges until
retirement (core run36909989038, Cloud541cc826).

The developing read service adds a GPG-encrypted immutable owner catalog,
authenticated loopback DAV listing/reads and an actual pinned OpenCloud Web SDK
check. The joined SDK/protected-peer trial now passes with the source and one
provider offline (core run36916040042). The new source-built original Files UI
uses an explicit owner-recovery token, read-only capability projection and
catalog-bound resource IDs, not a fabricated OIDC session. Its UI trial and
the peer trial remain separate until a joined original-UI proof passes. Owner
keys, file bundles and core journals are still local dependencies. No OIDC,
LibreGraph, writable synchronization or sharing service is replaced by this
read interface. Whole-instance backups are useful for recovery but are not a
substitute for the live file-access path.

[Executable private-file recovery and its limits](PRIVATE_FILES.md)

[Encrypted catalog and source-off read service](OFFLINE_READ.md)

## Backend functions that must not disappear

OpenCloud storage and application services have separate responsibilities:

| Surface | What remains necessary when the original server is off |
| --- | --- |
| OIDC and accounts | Authenticate the user; preserve issuer, account and device identities. |
| LibreGraph | Spaces, directory metadata, users, groups and permissions. |
| DAV and synchronization | Versioned reads/writes, conditional updates, locks and conflicts. |
| Sharing | Recipient authority, public-link policy, revocation and received shares. |
| Events, search and previews | Synchronization events and privacy-scoped derived data. |

An S3-compatible blob layer alone does not supply these functions. OpenCloud's
`decomposeds3` driver still keeps metadata separately on filesystem storage.
Offline sharing revocation and concurrent edits need explicit consistency rules;
never treat old cached permission metadata as indefinite new authority.

## Shared storage contract

Storage placement, lease renewal, replacement, charges and redundancy belong to
VOLPAROSSA core. Cloud must not introduce its own replica-count setting or a
second contribution ledger. Use the uniform policy for new storage; preserve
readability and all physical charges for older archives during migration.
Replacement may temporarily retain more copies without changing the desired
redundancy level. No data is retired merely to make a displayed quota smaller.

Files, catalogs, owner journals and recovery keys have different sensitivity and
recovery roles. A deployable solution must recover the encrypted catalog and
necessary owner state on another authorized device, not depend on the original
server's only local journal. Never claim that an encrypted blob by itself solves
account or key recovery.

## Existing upstream encryption is not universal client support

Rolling OpenCloud releases 7.5 and newer add browser vaults based on rclone-crypt;
the selected production 7.2.4 baseline predates them. The inspected Web v8.0.0
implementation encrypts both file data and names, but buffers complete files and
still uses the backend for WebDAV/authentication. Native desktop/mobile vault
decryption has not been verified for this integration. Do not advertise it as
cross-client private storage or as an offline backend.

## Useful additional integration

Use owner-side search, thumbnails and AI assistance first. Remote compute is an
option only with an explicit suitable privacy boundary; arbitrary peers cannot
read documents simply because OpenCloud normally indexes them on a server.
Public caching requires an explicit public-content decision. Private file names,
embeddings, thumbnails and access history never become public-cache or model
training material automatically.

The shared immune/policy mechanisms can enforce resource limits, authenticated
operations and accountable abuse responses without promising that opaque
encrypted files have been inspected or proven lawful.

## Primary references

- [Production v7.2.4](https://github.com/opencloud-eu/opencloud/releases/tag/v7.2.4)
- [WebDAV API](https://docs.opencloud.eu/docs/next/dev/server/apis/http/webdav/)
- [LibreGraph API](https://docs.opencloud.eu/docs/next/dev/server/apis/http/graph/)
- [Pinned storage configuration](https://github.com/opencloud-eu/opencloud/blob/1770793f2657e153836c32d32dd6d256b8531d3d/services/storage-users/pkg/config/config.go)
- [Pinned sharing service](https://github.com/opencloud-eu/opencloud/blob/1770793f2657e153836c32d32dd6d256b8531d3d/services/sharing/README.md)
- [Web vault engine](https://github.com/opencloud-eu/web/blob/11e699ac82fda4dd113ac3ceb2ecb2dd74574045/packages/web-app-rclone-crypt/src/crypto/engine.ts)
- [Web file-read adapter](https://github.com/opencloud-eu/web/blob/11e699ac82fda4dd113ac3ceb2ecb2dd74574045/packages/web-client/src/webdav/getFileContents.ts)
