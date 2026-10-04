# OpenCloud Files: private read-only recovery

This explicit mode connects the **original OpenCloud Web 8 Files application**
to the owner-local encrypted catalog and core-backed read service. It is not a
new OpenCloud account, an OIDC impersonation or a replacement for writable
OpenCloud synchronization. The normal upstream authentication path stays intact
when this mode is not selected.

The optional [owner-upload extension](OWNER_UPLOADS.md) adds a separate writable
space for new private files. Imported selections remain read only. Its updated
source-built interface now passes a separate joined upload/restarted-download
trial with real storage peers. The successful read-only trials below remain
bound to their original sources and patch; the [upload evidence](OWNER_UPLOADS.md#evidence-and-remaining-scope)
records the newer exact revisions and remaining scope.

The browser receives only the owner's selected catalog. Storage peers still
receive encrypted fragments, not filenames, private tokens or decryption keys.
The recovery token remains in browser memory, not a URL or local/session storage.
Closing recovery clears that session and reloads the token gate. Closing the
browser does not revoke a separately copied token; stop the local read service
and replace its private configuration token when revocation is needed.

## Explicit source build

Use an already installed Node.js **24.19.0**, Python 3, Git and bubblewrap. Nothing
is installed globally. From this repository, prepare a new ignored source checkout:

```sh
git clone --no-checkout https://github.com/opencloud-eu/web.git build/opencloud-web-11e699
git -C build/opencloud-web-11e699 checkout --detach 11e699ac82fda4dd113ac3ceb2ecb2dd74574045
git -C build/opencloud-web-11e699 apply ../../patches/opencloud-web-owner-recovery.patch
python3 -B scripts/build_web_ui.py \
  --source /absolute/volparossa-cloud/build/opencloud-web-11e699 \
  --node /absolute/node-v24.19.0-linux-x64/bin/node \
  --download --build --yes
```

The explicit download step verifies the pinned pnpm archive and fetches the
frozen-lock dependencies with lifecycle scripts disabled. The actual Vite build
runs without networking, with empty private home directories. The resulting
`dist/BUILD_REPORT.json` binds the exact upstream source, patch, lockfile and
output asset hashes. The read service checks that report and every asset before
serving the interface. A build is not evidence that the UI-to-peer path works.

Keep the upstream AGPL license and corresponding source/patch available when
distributing or serving a modified build; the integration's GPL label does not
replace the upstream license. See [provenance](../THIRD_PARTY_LICENSES.md).

## Open the selected private files

First create the [encrypted selection and private read configuration](OFFLINE_READ.md).
Add this field to that mode-0600 configuration:

```json
"webDist": "/absolute/volparossa-cloud/build/opencloud-web-11e699/dist"
```

This mode requires an empty `allowedOrigins` list. Start the existing service:

```sh
node scripts/cloud-serve.mjs --config /absolute/private/read-service.json
```

Open the reported `http://127.0.0.1:PORT/` in your browser. Enter the private
recovery token into the local form, not a command line or URL. The interface
shows **Private read-only recovery**. Open a selected space, navigate folders
and use the original Download action. Writes, sharing, new accounts, previews
and updates are not advertised by this local authority.

Only verified public application assets are readable without the token. Catalog,
space metadata and file operations still require bearer authentication and the
exact loopback Host/Origin boundary. Resource IDs resolve solely inside the
unlocked selection; there is no origin-server fallback or external-account lookup.

Downloads restore and verify the whole encrypted file through the core, decrypt
locally, and remove temporary plaintext after the response. The browser then
holds a download blob temporarily; a file you explicitly save remains yours.
This is not streaming decryption or a persistent shared plaintext cache.

## Evidence and limits

The optional `scripts/smoke_web_ui.py` runs an installed Firefox in a fresh
isolated profile against the source-built original Files application. Its
storage backend is deliberately synthetic: UI navigation and download results
must not be described as encrypted peer-storage evidence.

The first actual Firefox 140.16.0 trial passes original project/file listing,
navigation into a subfolder, two byte-verified Downloads, wrong-token denial,
in-memory-only token checks and logout/relocking. Both materialized test files
and the private browser profile are removed. The original receipt SHA-256 is
`320480e45a88a3cabafd357d6f0dce1e449ba7e9691f7c7a59d2118cf5f03644`;
the checked build report is
`3a482aef27fe84d057eab2958b3d6c9076c968103efcbc3ee19d3fcf3092b62c`.
Thirty catalog/HTTP checks, nine service/asset checks and the original pinned SDK
read check also pass. Local catalog checks use real GPG and explicitly injected
storage, not live storage peers.

The separate protected-peer SDK trial proves the core-backed read service
with the source and one provider unavailable. The combined original-UI/peer trial
also passes on the exact later sources recorded below. Account enrollment, cross-device recovery of catalog and keys,
writable synchronization, conflict resolution and sharing/revocation are still
open work; this mode does not make all of OpenCloud server-independent.

The subsequent joined trial `VOLPAROSSA/volparossa` run `36935715873` reached
the original UI after protected-peer restore/catalog/SDK reads, but failed during
unlock; cleanup passed. A local original-Web8 diagnostic reproduced the same unlock failure:
with private request concurrency set to two, six open browser connections filled
the six-socket transport cap and prevented login from reaching authentication.
Web mode now retains at least eight transport sockets, without increasing its
private request/restoration concurrency. The focused real-HTTP regression fails
with the old limit and passes with the correction. The local synthetic-backend UI
diagnostic confirms wrong-token rejection, successful unlock and read-only file
navigation; that local diagnostic alone did not establish joined peer-storage UI operation.

The corrected [joined run `36940326270`](https://github.com/VOLPAROSSA/volparossa/actions/runs/36940326270)
**passes** on core `d7403106837962c66cd0af0e049236785d8053cb` with Cloud
`63bba5d1163a69e1ee6b4218c9e7462d941f22f7`, source-built OpenCloud Web8
`11e699ac82fda4dd113ac3ceb2ecb2dd74574045` and Firefox ESR140.16.0. The source is
stopped, local ciphertext removed and provider A offline throughout six actual
protected B/C reconstructions. The original Files interface authenticates, lists
and navigates the selection, and completes two 786,433-byte downloads checked
against the original file hash. Wrong-token denial, logout/relocking, retained
charges, non-consuming restores, final zero provider leases and private/host-state
cleanup pass. Exact-source replay of the 44 original artifacts passes; original
ZIP SHA-256: `9815e1ee6435f39a03c9b566008068e471aa4ac2ad405006df530044b65ffbab`.
This is a selected owner-local read-only recovery proof, not account/ACL recovery,
writable synchronization, sharing or a fully server-independent OpenCloud service.
