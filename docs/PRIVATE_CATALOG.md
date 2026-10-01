# Owner-private catalog and verified reads

The catalog is an **explicit, immutable selection of already imported and
deposited files**. It lets the owner list selected spaces and restore those
versions without contacting the original OpenCloud DAV server. It is not an
OpenCloud account database, sharing authority or replacement synchronization
service. See [offline read setup](OFFLINE_READ.md) for the selection and service
commands.

## What stays private

The owner-only catalog directory contains `catalog.pgp`, `recovery.key` and a
closed `receipt.json`, each mode 0600. The directory and work directory must be
mode 0700, owned by the current user, without symlink redirection. The receipt
contains only the encrypted object's identity, size and format—not file names,
source URLs, content hashes or recovery secrets.

The index inside `catalog.pgp` contains the selected space/path segments, exact
content version, size, digest and local bundle/core-configuration references.
It is encrypted with the existing vendored Image OpenPGP/GnuPG mechanism;
there is no custom cipher or new key-distribution protocol. The random owner
key goes to GPG through a private descriptor, never an argument or environment
variable. Index decryption returns data through a private process pipe only
after authenticated GPG completion. It creates no plaintext index file.

The selection JSON is itself sensitive: keep it mode 0600 in an owner-only
directory. An authenticated local read client can of course see selected names
and the contents it requests; storage peers and public caches do not receive
the index or those plaintext files. The catalog does not enroll public links,
shared users or online OIDC permissions. It describes the owner's retained
read copy, not a grant to another account.

## Fixed versions, no origin fallback

Creation restores each selected file through the existing `restoreStoredFile`
core bridge, verifies its GPG-authenticated metadata and content digest, and
checks that the requested path equals the authenticated `/dav/spaces/…` source
path. Temporary plaintext is removed before the encrypted catalog is published
with no-overwrite semantics. There is no account crawl or implicit selection.

The index schema is version 1, with kind
`volparossa-cloud-private-catalog-index`. Each entry binds:

- `segments`: space ID followed by the original path segments;
- `bundle` and `config`: owner-local recovery/configuration references;
- `size` and `sha256`: the verified plaintext identity;
- `cipherBytes` and `cipherSha256`: the corresponding encrypted object;
- `lastModified`: a canonical HTTP date when available, otherwise null.

An opened catalog remains immutable. File ETags bind verified plaintext content;
directory ETags bind their selected children's names and metadata. A changed
bundle or restored version is rejected. Every content open performs a fresh
core restore and authenticated decrypt, including range requests served by the
DAV layer. It never substitutes the original DAV source or a retained local
ciphertext. Unavailable peers fail visibly. Updating the selection requires
creating a new catalog, not silently mutating an active one.

## Backend contract and resource lifetime

`createPrivateCatalog({selection, output, workDirectory, maxTotalBytes?}, {signal?})`
creates the catalog. `openPrivateCatalog({catalog, workDirectory, maxOpenBytes?,
maxOpenFiles?}, {signal?})` returns the read backend:

- `stat(segments, {signal?})` returns null or `{kind, size, etag, lastModified}`.
- `list(segments, {signal?})` returns immediate entries `{name, ...stat}`.
- `open(segments, {signal?})` returns `{path, size, etag, dispose()}` only after
  the private file is completely restored and verified.
- `close()` cancels and joins pending restores and disposes retained plaintext.

Segments are relative to `/dav/spaces/`: `[]` lists selected spaces and
`[spaceId, ...path]` addresses an original file. Directories are derived only
from selected files. There are at most 256 selected files, 32 path segments and
a 2 MiB plaintext index. No entry can introduce a traversal segment or
file/directory collision.

The default creation budget is 256 MiB of selected ciphertext, validated
before transfers begin. The default open budget is 256 MiB of ciphertext across
at most two concurrent or retained materializations. `maxOpenFiles` accepts
1–16 and is passed from the service concurrency configuration. Completed files
continue to occupy their slot and byte reservation until disposal. The byte
budget limits selected transfer material; it is **not a physical disk quota**:
temporary ciphertext and plaintext may coexist during verification. Restoring
an entire file for a small range is currently deliberate, not an optimization
claim.

Cancellation of the owner's signal closes the whole backend. Request
cancellation stops its restore. Cleanup is awaited, and a cleanup failure stays
a failure on later `close()` calls rather than being forgotten after an open
has rejected. A failed cleanup can leave a private staging directory that must
be inspected and removed by its owner; the service never calls that success.

## Evidence and remaining work

The catalog tests use actual synthetic DAV imports, actual GPG encryption and
authenticated decryption, then stop the source server and remove local file
ciphertexts before catalog creation and repeated reads. They cover Unicode and
empty files, immutable version rejection, byte/concurrency limits, cancellation,
private cleanup failure and encrypted-index tampering. Their injected storage
adapter is explicitly an **in-memory core-contract fixture**, not evidence of
real peer placement, protected routes or independent-device availability.

The production backend always uses the existing core bridge; configuration and
CLI cannot select that test adapter. The new catalog, DAV service and actual
OpenCloud SDK now pass their [own protected-peer proof](OFFLINE_READ.md#evidence-boundaries),
separately from earlier one-file storage proofs. Catalog replication, second-device key/journal recovery, writable
sync/conflict handling and shared-access revocation are not implemented here.
The catalog's local references cannot reconstruct a lost owner device by
themselves. No second storage ledger or application-specific redundancy policy
is introduced.
