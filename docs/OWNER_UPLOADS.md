# Owner-private uploads while the original server is off

This developing slice adds a **separate, explicitly enabled owner upload space**
to the existing recovery service. It does not turn imported read-only files into
writable OpenCloud accounts. It accepts new files only: no overwrites, folder
creation, rename, delete, sharing or synchronization back to the original server.

The original OpenCloud Files **Files Upload** action and Uppy raw DAV `PUT` path
are reused. A local authenticated upload is privately staged, encrypted with the
existing GPG helper, then submitted to the shared core's fragment create/deposit
operations. The core still chooses fragment placement and uniform redundancy;
Cloud adds neither a copy-count option nor a second storage ledger.

```text
Original Files Upload / authenticated DAV PUT
  -> owner-private temporary file -> authenticated encrypted bundle
  -> core fragment journal -> confirmed redundant deposit
  -> durable catalog commit -> visible new file
  -> later GET -> core fragment restore -> verified local decrypt -> download
```

## Explicit setup

Keep the existing [read-service configuration](OFFLINE_READ.md), selected catalog
and owner token. Add an upload space whose name does not collide with an imported
space:

```json
"ownerUploads": {
  "directory": "/absolute/private/owner-uploads",
  "space": "My uploads",
  "storageConfig": "/absolute/private/upload-storage-template.json"
}
```

Create the upload directory mode **0700**, separate from the existing private work
directory. Keep the storage template mode **0600** in an owner-only directory.
It uses the existing [core storage configuration](PRIVATE_FILES.md), but **omit
`stateDirectory`**: each uploaded file receives an opaque owner journal directory.
Keep `copies` absent. Configure the existing core binary, protected control socket,
owner identity/passphrase file, fragment size/lifetime/deadline and **3–8 distinct
provider keys with their explicit grants**. Invalid grants or insufficient core
capacity remain visible failures, not admission to other peers.

Start with the existing `cloud-serve.mjs --config …` command. `ownerUploads` is
absent by default and cannot enable cross-origin browser writes. The listener
remains loopback-only; every private operation needs the configured owner bearer.
Neither the configuration nor DAV input can supply executable hooks or arbitrary
local source/destination paths. Original Files requires a **new source build of
the updated pinned patch**; an older build report is correctly refused.

The new UI label distinguishes owner-private uploads from imported read-only
files. Uploads use the existing Uppy engine, one file at a time; unsupported
folder/shortcut creation is hidden in this mode. The upload-enabled service and
UI use a bounded 30-minute default deadline. The original read-only service keeps
its two-minute default. Explicit service deadlines may still cancel an upload.

## Publication, retry and recovery

`PUT` returns **201 only after confirmed storage and durable catalog publication**.
The owner directory holds opaque object names, private recovery bundles, encrypted
single-file catalogs and core journals. File names and plaintext hashes remain
inside authenticated encryption, not filenames or public receipts. The new
file receipt is version 2 with `owner-upload-snapshot` provenance; old version-1
DAV import receipts keep their original source/version checks. Relabeling an
upload as a DAV import fails authenticated restoration.

After an incomplete deposit, the file is not listed and its journal/ciphertext
remain retained. An **explicit retry of the same name and exact file bytes**
resumes that existing operation; different bytes are refused. There is no automatic
fresh archive or origin fallback. A committed name cannot be overwritten, even
when a client requests overwrite. If a response is lost after commit, re-list the
space: a repeated `PUT` gets 412 rather than creating another stored copy.

After service restart, committed catalogs become visible again. Every download
still restores through the core, verifies the encrypted object and authenticated
content, then removes temporary plaintext. Reads neither consume a backup nor
substitute local ciphertext. Retained grants, charges and recovery state must not
be deleted to make an incomplete operation look finished.

Only one service may mutate an upload workspace at once, enforced by a supervised
owner lock. At most 256 upload objects are retained, including interrupted stages.
The existing `maxOpenBytes` bounds each encrypted file and concurrent restored
ciphertext; small encryption/metadata overhead is included. It is not a disk quota:
upload staging, ciphertext, restore staging and owner journals use additional local
space. Forced process termination may leave private staging; this slice does not
claim secure erasure or automatic abandoned-operation retirement.

## Evidence and remaining scope

Targeted tests exercise real HTTP, GPG encryption, encrypted catalogs, durable
publication, restart, repeated verified downloads after local ciphertext removal,
incomplete-deposit resumption, cancellation and unchanged imported permissions.
The explicitly staged, hash-verified OpenCloud Web8 SDK also passes actual `PUT`,
returned file-ID resolution, listing, verified read and overwrite refusal against
this service. Only the storage-provider boundary is an explicit in-memory
core-contract fixture. The updated patch applies to pinned OpenCloud Web8 source. **A newly built native
Files upload joined to real protected peers has not yet been demonstrated.**

The prepared disposable-guest driver `scripts/smoke_owner_upload_ui.py` uses the
original Files file input and Uppy upload, then reloads and reauthenticates. Its
separate download phase opens a fresh browser and verifies two native downloads.
The core acceptance parent must supply the real service and independently prove
the source is off, encrypted fragment deposits, service restart, provider
withdrawal, charges and final retirement. The driver reports only closed UI and
browser-cleanup observations; its boundary tests are **not an executed native
upload or peer-storage result**. Ordinary read-only mode still hides the upload
button; the explicit owner-upload mode retains the original per-space upload
permission check, without granting writes to imported spaces.

The original [core trial 37202264396](https://github.com/VOLPAROSSA/volparossa/actions/runs/37202264396)
at core `d7ca3d88a350e8a0c83852131d07ffbbec79126e` and Cloud
`3e3d6587012ed46d200218e4447506300f8a4f18` reached `upload_commit` but
**failed**. The retained report does not distinguish a failed PUT from a browser
command or subsequent listing failure. Private cleanup passed; this is not a
successful upload/recovery result. The driver now retains, on failure only, a
closed error category and the last observed PUT/completion/201 counts and HTTP
status. It exports no request URLs, response bodies, filenames or credentials.
Success requirements, the real file input, deadlines and cleanup stay unchanged.

Owner keys/catalogs/journals still live on the owner's device. Cross-device recovery,
shared accounts, concurrent editors, automatic repair/renewal and general writable
synchronization remain separate work. Existing successful read-only UI/peer trials
do not prove this new upload path or full server-independent OpenCloud operation.
