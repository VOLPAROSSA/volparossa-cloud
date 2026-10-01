# Private source-off file access

This developing owner-side read service joins an encrypted, immutable selection
catalog to the shared core and a read-only WebDAV interface. It is **not** a
replacement for OpenCloud accounts, OIDC, shared permissions, synchronization or
all web-application services. An optional [original Files recovery interface](RECOVERY_WEB.md)
uses this same service under an explicitly separate local authority.
A user can explicitly select their imported files;
this does not grant new rights to another user's account or shared links.

```text
Explicit owner selection -> encrypted catalog on owner device
                                      |
Authorized local DAV read -> core fragment restore -> authenticated GPG decrypt
                                      |                       |
                              encrypted peers          verified private file
                                                              |
                                                    response + private cleanup
```

The original DAV server is not used for catalog reads or file restoration.
Missing, changed or unavailable storage produces a visible failure, not an
origin request. The core remains responsible for placement, grants, charges,
uniform redundancy and network routing. This application creates none of those
authorities itself.

## Create an explicit selection

First import and deposit files with the [private-file commands](PRIVATE_FILES.md).
Keep each file's recovery bundle and the corresponding core configuration and
owner journal. Inside a mode-0700 owner directory, write a mode-0600 selection:

```json
{
  "version": 1,
  "files": [{
    "segments": ["your-space-id", "Documents", "notes.txt"],
    "bundle": "/absolute/private/notes-bundle",
    "config": "/absolute/private/notes-storage.json"
  }]
}
```

The path must match the authenticated source metadata. A local alias is not
authority to substitute a different imported file. Catalog creation performs a
real core restoration of each selected file and records the verified version,
content digest and size before encrypting the index. Temporary plaintext is
removed. There is no automatic account crawl.

```sh
node scripts/cloud-catalog.mjs create \
  --selection /absolute/private/selection.json \
  --catalog /absolute/private/new-catalog \
  --work-directory /absolute/private/work
```

The catalog and its recovery key stay owner-private. The catalog currently
references local file bundles, core configuration and owner journals; losing
those is **not** solved by retaining only the catalog. Second-device key and
journal recovery, peer storage of the catalog and concurrent catalog updates
remain required further work.

## Start the local read service

Create a separate mode-0600 configuration within a mode-0700 owner directory:

```json
{
  "version": 1,
  "catalog": "/absolute/private/new-catalog",
  "workDirectory": "/absolute/private/work",
  "bearerToken": "REPLACE_WITH_YOUR_RANDOM_PRIVATE_TOKEN",
  "port": 0,
  "maxOpenBytes": 268435456,
  "maxConcurrent": 2
}
```

Use at least 32 random bytes for the private token; the example is not a usable
credential. Do not put the token on the command line, in source control or in
logs. The service accepts only explicit private configuration:

```sh
node scripts/cloud-serve.mjs --config /absolute/private/read-service.json
```

It binds only `127.0.0.1`; port `0` selects an available port. The startup report
contains the bound origin, not the token, filenames, source URLs or recovery keys.
Importing a module does not start the listener. SIGINT/SIGTERM/SIGHUP cancel
active restoration, close connections and await private-file cleanup.

Read paths retain `/dav/spaces/{spaceId}/{path}`. Supported operations are
authenticated `PROPFIND` with depth 0 or 1, `HEAD`, `GET`, bounded single ranges
and ETag conditions. Writes are rejected. An exact Host check and Origin policy
protect the loopback boundary; cross-origin browser access requires an explicit
`allowedOrigins` list. This is not a public gateway or a replacement login flow.

Listing uses the selected catalog snapshot. Reading materializes and verifies
the file through the core, even for a range, then removes the private temporary
copy. Reads can therefore be more expensive than their returned range; there is
no hidden persistent plaintext cache or claim of optimized performance.

## Evidence boundaries

- Catalog tests use real GPG and synthetic authorized source files, with the
  storage seam explicitly identified as a fixture where injected.
- The transport tests use real HTTP but a synthetic backend.
- The optional pinned OpenCloud Web 8 SDK test exercises its actual listing,
  full read, ranged read and authentication behavior over that HTTP interface.
- A joined local trial also runs the actual encrypted catalog and read service
  through that SDK, with the synthetic source stopped and local ciphertext
  removed. Only its core storage adapter is injected; real GPG verification and
  temporary-file cleanup run on every materialized read.
- The separate [live SDK-to-peer trial](https://github.com/VOLPAROSSA/volparossa/actions/runs/36916040042)
  now passes on Cloud `a67b91fbed42ecd23ba215eb21ef54397fc9f06a` / core
  `5d9d347fc52e4cc13498ed3b6790d1f00de370c3`, without the injected adapter.
  The source is stopped, local ciphertext removed and provider A unavailable
  before four B/C reconstructions: CLI recovery, catalog creation, SDK full GET
  and SDK range GET. All 32 required protected MPTCP/TLS exchanges complete.
  Metadata, wrong-token and stale-ETag checks, retained physical charges,
  all-copy deletion, private cleanup and unchanged host state pass. Exact-source
  replay reconstructs the aggregate from all 44 original artifacts; ZIP SHA-256
  `f59a2c2baf693b5087c0827c0971589da23bf15610f96c885db6f2bbe0abdaef`.
  This proves the SDK/service path, not a running complete web application or
  server-independent OpenCloud.

See [third-party provenance](../THIRD_PARTY_LICENSES.md) for the exact optional SDK
and explicit staging procedure, and [Files recovery](RECOVERY_WEB.md) for the
source-built browser interface. The combined UI-to-peer proof, complete account
service, device synchronization, sharing/revocation, cross-device recovery and
writable service remain open.
