# One-file private import and recovery

This Linux development slice imports an explicitly selected, authorized DAV
file and recovers the owner's copy without accessing its source again. It is
not a replacement OpenCloud server, a synchronization client or a permission
grant for other users. A strong ETag pins all requested ranges to one source
version; a changed version aborts import instead of mixing file versions.

## Requirements and private configuration

Use Node.js 24+, Python 3.11+ and the existing `/usr/bin/gpg`,
`/usr/bin/gpg-agent` and `/usr/bin/gpgconf`. The CLI does not install software,
start VOLPAROSSA participation or discover credentials. Linux `renameat2` is
used to publish new output without replacing an existing path.

All supplied paths are absolute and canonical. Owner work directories must be
mode `0700`; configuration, identity, passphrase, grants, receipts, keys and
encrypted files must be owner-owned regular files at mode `0600`. Symlinks and
hard-linked private files are rejected. Each import/output path must be new.
The isolated GnuPG helper requires an existing owner-private GnuPG runtime
directory if `/run/user/<uid>` exists; otherwise its work path must fit the
Unix socket length limit. It does not modify a global keyring or agent.

Keep the source configuration in a private file, for example
`/absolute/private/source.private.json` (placeholder credentials only below):

```json
{
  "version": 1,
  "source": {
    "origin": "https://cloud.example.org",
    "bearerToken": "REPLACE_WITH_EXPLICIT_OWNER_TOKEN",
    "maxFileBytes": 1073741824,
    "maxRequestBytes": 4194304,
    "timeoutMs": 30000,
    "totalTimeoutMs": 300000
  },
  "resource": {
    "spaceId": "REPLACE_WITH_AUTHORIZED_SPACE_ID",
    "pathSegments": ["documents", "example.pdf"]
  }
}
```

TLS verification is mandatory, credentials remain bound to the exact origin,
and redirects are rejected. Explicit numeric-loopback HTTP is a synthetic-test
option only. Account login/refresh and automatic file discovery are not built.

## Import and local recovery

```sh
node scripts/cloud-file.mjs import \
  --source-config /absolute/private/source.private.json \
  --bundle /absolute/private/file-owner-bundle

node scripts/cloud-file.mjs restore-local \
  --bundle /absolute/private/file-owner-bundle \
  --cipher /absolute/private/file-owner-bundle/file.pgp \
  --output /absolute/private/recovered-file
```

The new bundle contains:

- `file.pgp`: a standard OpenPGP AES-256 encrypted TAR containing `content.bin`
  and `metadata.json`. The private metadata retains the source URL, strong ETag,
  size and optional last-modified value, plus a content digest. It never contains
  the bearer token.
- `recovery.key`: a random per-file recovery secret, passed to GnuPG through a
  private file descriptor, never as an argument, environment variable or log.
- `receipt.json`: the encrypted object's size, digest and format; no plaintext
  filename, source URL, browsing history or recovery secret.

Preserve `recovery.key` and the trusted receipt separately from the encrypted
object. Losing the key makes this object unrecoverable; no peer can reconstruct
it for the owner. These files are sensitive owner state, not public-cache or
training material. The CLI never removes the original DAV file or an existing
local source. Its downloaded plaintext is temporary private staging; ordinary
deletion is **not secure erasure** on an SSD or protection against privileged
local software, swap or a compromised owner account.

Recovery validates the expected ciphertext digest, OpenPGP authenticated
decryption and the encrypted content manifest before atomically publishing a
new directory with `content.bin` and `metadata.json`. A failed check leaves the
requested output absent. Repeating recovery does not consume the bundle.

## Use the existing core's private fragment storage

Provide a separate private core configuration with exactly these required
fields. Its `stateDirectory` is a **new per-object core owner journal** for
`create`; preserve that same directory across subsequent operations and restarts.

```json
{
  "version": 1,
  "coreBinary": "/absolute/trusted/volparossa",
  "controlSocket": "/absolute/private/core-control.sock",
  "identity": "/absolute/private/owner-identity.key",
  "passphraseFile": "/absolute/private/owner-unlock",
  "stateDirectory": "/absolute/private/file-storage-state",
  "providers": [
    { "key": "REPLACE_WITH_FIRST_64_HEX_PROVIDER_KEY", "grant": "/absolute/private/provider-a.grant" },
    { "key": "REPLACE_WITH_SECOND_64_HEX_PROVIDER_KEY", "grant": "/absolute/private/provider-b.grant" },
    { "key": "REPLACE_WITH_THIRD_64_HEX_PROVIDER_KEY", "grant": "/absolute/private/provider-c.grant" }
  ],
  "fragmentBytes": 4194304,
  "lifetimeSeconds": 86400,
  "deadlineMs": 1800000
}
```

This bridge requires an already configured core, authorized protected routes
and three to eight explicit provider grants. It does not create providers,
grant authority or install the core. The core fragments each encrypted object
and owns the two-copy baseline, placement, signatures, leases and accounting.
There is no Cloud replica-count setting or separate contribution ledger.
The retained journal records uncertain work and replacement copies; this bridge
accepts the existing additive v2 repair report without pretending those charges
have disappeared.

```sh
node scripts/cloud-file.mjs create \
  --config /absolute/private/core.private.json \
  --bundle /absolute/private/file-owner-bundle

node scripts/cloud-file.mjs deposit \
  --config /absolute/private/core.private.json \
  --bundle /absolute/private/file-owner-bundle

node scripts/cloud-file.mjs restore \
  --config /absolute/private/core.private.json \
  --bundle /absolute/private/file-owner-bundle \
  --output /absolute/private/restored-from-storage
```

Only `file.pgp` is supplied to the core for placement; keys and readable metadata
never go to storage peers. For `restore`, the owner bundle needs its key and
receipt, not a local ciphertext copy. The core must actually return verified
ciphertext before decryption begins. A failed/incomplete peer read never falls
back to the original server or silently substitutes a local copy. Core owner
journals, identities and grants must also remain available: the encrypted file
alone does not solve account or owner-state recovery. Lease renewal, repair and
retirement remain existing core operations, not a new Cloud background service.

## Optional deposit diagnostics

The same private core JSON may explicitly select one diagnostic version:

| Optional boolean | Deposit flag and exact required version |
| --- | --- |
| `appendDiagnosticsV7` | `--append-diagnostics-v7`, v7 |
| `flowAcquireDiagnosticsV8` | `--flow-acquire-diagnostics-v8`, v8 |
| `tlsCloseDiagnosticsV9` | `--tls-close-diagnostics-v9`, v9 |
| `challengeReadDiagnosticsV10` | `--challenge-read-diagnostics-v10`, v10 |

All four default to false. Supplied values must be booleans and at most one may
be true. Only deposit sends a flag and requires the selected closed report.
Missing, downgraded, future or malformed selected diagnostics fail closed as
`invalid_core_report`. Payload version markers do not authorize projection.
There is no generic v1–v6 opt-in; those observations are inherited fields of
selected v7–v10 reports.

Absent or all-false selectors preserve the original Cloud adapter's argv and
complete results, ignoring unsolicited diagnostics even when malformed or future.
The selectors remain inactive for every other core operation, including create
and restore. No Cloud command-line diagnostic switch is added: selection comes
only from the caller's private core configuration.

Selected results add a frozen `storage.deposit_diagnostics` summary. It retains
closed failure observations bound to the validated fragment/copy geometry, with
bounded omissions and no raw paths, provider keys, stderr or input bytes. It does
not replace the original error, ciphertext validation, conservative accounting,
completion status or cleanup evidence. A null returned wire outcome means only
that none was observed; read stage alone identifies no remote cause. In v10,
`before_challenge` and `in_challenge` remain whole-boundary timing buckets.
Deadlines, retries, owner publication, recovery and pending-upload behavior remain
unchanged. Retained maintenance branches remain separate pending integration.

The vendored SDK is byte-identical to accepted Image
`78cc1d6cc7012ac64bbd07408990b63ed025d127`, with all three source files bound by
`third_party/volparossa-image-source.json`. Its helper and license bytes are unchanged.
The focused `test/storage-deposit-diagnostics.test.mjs` is designed to exercise
the actual Cloud consumer, default SDK and joined synthetic Node child. It compares
full default results and argv against a readable test-only copy of the original
Cloud-main SDK at `bdc9c914f4687f25396e23f322d5fa27e183ce8a`, 20,915 bytes,
SHA-256 `d274c294a4f7c500aac552629997487c79e67faaa89dddd1383309d7e58273b0`,
verified before use. The child emits fabricated core reports over opaque bytes;
these contracts do not run GPG, real storage peers or OpenCloud and do not prove
remote cleanup or resolution of a historical trial failure. The existing Quality
workflow runs them with `node --test test/*.test.mjs`; this new Cloud composition
still requires its hosted result.

## Evidence and remaining work

`test/private-file.test.mjs` executes real GnuPG encryption and decryption, a
real HTTP listener with synthetic authenticated DAV ranges, source shutdown,
repeated owner recovery, exact-byte comparison, empty files and authentication/
tamper rejection without output overwrite. Temporary owner data is removed.

Its injected storage fixture tests the Cloud-to-core call contract and recovery
after local ciphertext removal. It is **not** an actual storage provider, actual
OpenCloud server or proof of distributed availability. A disposable protected
peer trial is still required for this Cloud slice. Directory catalogs, real
OpenCloud client browsing, cross-device enrollment/key recovery, sharing,
permission revocation, concurrent edits and long-term availability remain open.
