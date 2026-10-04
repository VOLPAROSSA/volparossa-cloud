// SPDX-License-Identifier: GPL-3.0-only
// Real HTTP, GPG, encrypted catalogs and restart. ONLY the core storage boundary
// is a synthetic contract fixture: this is not native Uppy or overlay peer proof.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { openOwnerUploads } from '../src/owner-uploads.mjs';
import { startPrivateDavServer } from '../src/private-dav-server.mjs';
import { recoverySpaceId, recoveryResourceId } from '../src/private-resource-id.mjs';
import { restorePrivateFile } from '../src/private-file.mjs';
import { checkedSDK } from './fixtures/checked-sdk.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'synthetic-owner-upload-token-1234567890';
const SPACE = 'Owner uploads';
const BODY = Buffer.from('Synthetic private file; not a real owner document.\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const directory = { kind: 'directory', size: 0, lastModified: null, etag: '"original-catalog"' };
function base() {
  return {
    async stat(parts) { return parts.length === 0 || parts.length === 1 && parts[0] === 'Imported' ? directory : null; },
    async list(parts) { return parts.length ? [] : [{ name: 'Imported', ...directory }]; },
    async resolveResourceId() { return null; },
    async open() { throw Error('The synthetic read-only base has no file content'); },
    async close() {},
  };
}
async function fixture(t) {
  await mkdir(join(ROOT, 'build'), { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(ROOT, 'build', 'upload-test-'));
  await chmod(root, 0o700);
  const workDirectory = join(root, 'work'), directory = join(root, 'uploads');
  for (const path of [workDirectory, directory]) await mkdir(path, { mode: 0o700 });
  const storageConfig = join(root, 'core-template.json');
  await writeFile(storageConfig, JSON.stringify({ version: 1, providers: [1, 2, 3].map(n => ({
    key: String(n).repeat(64), grant: join(root, `synthetic-grant-${n}`),
  })) }), { mode: 0o600 });
  const remote = new Map(), calls = [];
  let backend, server, failure = false, hold;
  const storageFactory = async path => {
    const config = JSON.parse(await readFile(path));
    assert.equal(config.providers.length, 3);
    assert.equal(Object.hasOwn(config, 'copies'), false);
    return {
      async create(request) {
        calls.push(['create', path]);
        assert.equal(request.alreadyEncrypted, true);
        const cipher = await readFile(request.input);
        assert.equal(hash(cipher), request.sha256);
        assert.equal(cipher.includes(BODY), false);
        await mkdir(config.stateDirectory, { mode: 0o700 });
        return { status: 'complete', local_process_joined: true };
      },
      async status() { calls.push(['status', path]); return { status: 'complete', local_process_joined: true }; },
      async deposit(request, { signal }) {
        calls.push(['deposit', path]);
        assert.equal(request.alreadyEncrypted, true);
        if (hold) await hold(signal);
        if (failure) return { status: 'incomplete', local_process_joined: true };
        remote.set(path, await readFile(request.input));
        return { status: 'complete', local_process_joined: true,
          storage: { fully_redundant_from_retained_receipts: true } };
      },
      async restore(request) {
        calls.push(['restore', path]);
        assert.equal(hash(remote.get(path)), request.sha256);
        await writeFile(request.output, remote.get(path), { mode: 0o600, flag: 'wx' });
        return { status: 'complete', restore_verified: true, local_process_joined: true };
      },
    };
  };
  const config = { directory, space: SPACE, storageConfig, workDirectory, maxFileBytes: 1024 ** 2 };
  async function start() {
    backend = await openOwnerUploads(config, { base: base(), storageFactory });
    server = await startPrivateDavServer({ backend, bearerToken: TOKEN, recoveryWeb: {
      assetsFactory: async () => new Map([['/', { data: Buffer.from('Synthetic public asset'), contentType: 'text/plain' }]]),
    } });
  }
  async function stop() {
    try { await server?.close(); } finally { await backend?.close(); }
    server = undefined; backend = undefined;
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true }); });
  const request = (path, method = 'GET', body, headers = {}) => fetch(server.origin + path, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, ...headers }, ...(body !== undefined ? { body } : {}),
  });
  const filePath = name => `/dav/spaces/${recoverySpaceId(SPACE)}/${encodeURIComponent(name)}`;
  return { root, directory, workDirectory, config, remote, calls, start, stop, request, filePath, storageFactory,
    get backend() { return backend; }, get origin() { return server.origin; },
    set failure(value) { failure = value; }, set hold(value) { hold = value; } };
}

test('owner upload -> encrypted core CONTRACT storage -> committed catalog -> restart -> verified download',
  { timeout: 90000 }, async t => {
    const f = await fixture(t);
    await f.start();
    const filename = 'Private α notes.txt';
    assert.equal((await f.request(f.filePath(filename), 'PUT', BODY, { Authorization: 'Bearer invalid' })).status, 401);
    assert.equal((await f.request('/dav/spaces/Imported/no.txt', 'PUT', BODY)).status, 403);
    assert.equal(f.calls.length, 0);
    const response = await f.request(f.filePath(filename), 'PUT', BODY, { 'If-None-Match': '*' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('etag'), `"vp-${hash(BODY)}"`);
    assert.equal(response.headers.get('oc-fileid'), recoveryResourceId([SPACE, filename]));
    assert.equal((await f.request(f.filePath(filename), 'PUT', BODY)).status, 412);
    assert.deepEqual(f.calls.map(([operation]) => operation), ['create', 'deposit']);
    const session = await (await f.request('/volparossa/recovery/session')).json();
    assert.equal(session.readOnly, false);
    assert.equal(session.ownerUploads, true);
    assert.equal(session.upstreamAccount, false);
    const drives = await (await f.request('/graph/v1beta1/me/drives')).json();
    const uploaded = drives.value.find(drive => drive.name === SPACE);
    assert.deepEqual(uploaded.quota, {});
    assert.deepEqual(uploaded.root.permissions, []);
    const permissions = await (await f.request(`/graph/v1beta1/drives/${uploaded.id}/root/permissions`)).json();
    assert.deepEqual(permissions.value, []);
    assert.deepEqual(permissions['@libre.graph.permissions.actions.allowedValues'], ['libre.graph/driveItem/upload/create']);
    assert.deepEqual(drives.value.find(drive => drive.name === 'Imported').root.permissions, []);
    const listing = await (await f.request(`/dav/spaces/${recoverySpaceId(SPACE)}/`, 'PROPFIND', '', { Depth: '1' })).text();
    assert.ok(listing.includes('Private α notes.txt'));
    assert.ok(listing.includes('<p:permissions xmlns:p="http://owncloud.org/ns">C</p:permissions>'));
    const ids = (await readdir(f.directory)).filter(name => name !== 'LOCK');
    assert.equal(ids.length, 1);
    const object = join(f.directory, ids[0]);
    const receipt = JSON.parse(await readFile(join(object, 'bundle/receipt.json')));
    assert.equal(receipt.version, 2);
    assert.equal(receipt.source_consistency, 'owner-upload-snapshot');
    for (const path of ['catalog/catalog.pgp', 'catalog/receipt.json', 'bundle/file.pgp', 'bundle/receipt.json', 'READY.json']) {
      const data = await readFile(join(object, path));
      assert.equal(data.includes(Buffer.from(filename)), false);
      assert.equal(data.includes(BODY), false);
      assert.equal(data.includes(Buffer.from(TOKEN)), false);
      assert.equal((await lstat(join(object, path))).mode & 0o777, 0o600);
    }
    await assert.rejects(openOwnerUploads(f.config, { base: base(), storageFactory: f.storageFactory }), { code: 'UPLOAD_WORKSPACE_BUSY' });
    await f.stop();
    await rm(join(object, 'bundle/file.pgp')); // Every read must use the core, not a local ciphertext fallback.
    await f.start();
    for (let i = 0; i < 2; i++) {
      const download = await f.request(f.filePath(filename));
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), BODY);
    }
    assert.deepEqual(f.calls.map(([operation]) => operation), ['create', 'deposit', 'restore', 'restore']);
    assert.equal(f.remote.size, 1); // Reads are non-consuming.
    await f.stop();
    assert.deepEqual(await readdir(f.workDirectory), []);
  });

test('incomplete deposit stays invisible; explicit identical retry resumes same retained operation after restart',
  { timeout: 90000 }, async t => {
    const f = await fixture(t);
    await f.start(); f.failure = true;
    assert.equal((await f.request(f.filePath('pending.txt'), 'PUT', BODY)).status, 503);
    assert.equal((await f.request(f.filePath('pending.txt'))).status, 404);
    assert.deepEqual(await f.backend.list([SPACE]), []);
    assert.equal(f.remote.size, 0);
    const ids = await readdir(f.directory);
    await f.stop(); await f.start();
    assert.equal((await f.request(f.filePath('pending.txt'), 'PUT', 'Different data')).status, 409);
    f.failure = false;
    assert.equal((await f.request(f.filePath('pending.txt'), 'PUT', BODY)).status, 201);
    assert.deepEqual(await readdir(f.directory), ids);
    assert.deepEqual(f.calls.map(([op]) => op), ['create', 'deposit', 'status', 'deposit']);
    assert.equal(new Set(f.calls.map(([, config]) => config)).size, 1);
    assert.deepEqual(Buffer.from(await (await f.request(f.filePath('pending.txt'))).arrayBuffer()), BODY);
  });

test('interrupted READY staging preserves healthy files and the pending operation can resume after restart',
  { timeout: 90000 }, async t => {
    const f = await fixture(t);
    await f.start();
    assert.equal((await f.request(f.filePath('healthy.txt'), 'PUT', BODY)).status, 201);
    const healthy = (await readdir(f.directory)).find(name => name.startsWith('object-'));
    const originalReady = await readFile(join(f.directory, healthy, 'READY.json'));
    // Inject a real partial write failure at the actual publication operation,
    // not at the core contract. Before the fix this leaves corrupt READY.json;
    // the same failure now touches only an unpublished temporary marker.
    const originalOpen = fs.open;
    let interrupted = 0;
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (typeof path === 'string' && /\/(?:READY\.json|\.READY-[0-9a-f]{32}\.tmp)$/u.test(path)
        && args[0] === 'wx') {
        interrupted++;
        const originalWrite = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          await originalWrite('{"version":');
          throw Object.assign(new Error('synthetic marker write interrupted'), { code: 'ENOSPC' });
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try { assert.equal((await f.request(f.filePath('pending.txt'), 'PUT', BODY)).status, 503); }
    finally { fs.open = originalOpen; syncBuiltinESMExports(); }
    assert.equal(interrupted, 1);
    const ids = (await readdir(f.directory)).filter(name => name.startsWith('object-')).sort();
    const pending = ids.find(name => name !== healthy);
    const pendingRoot = join(f.directory, pending);
    // Retained state from interruption before the atomic final-marker rename:
    // even an empty/partial private stage must not be interpreted as READY.
    const partial = join(pendingRoot, `.READY-${'a'.repeat(32)}.tmp`);
    await writeFile(partial, '{"version":', { flag: 'wx', mode: 0o600 });
    await assert.rejects(lstat(join(pendingRoot, 'READY.json')), { code: 'ENOENT' });
    await f.stop(); await f.start();
    assert.deepEqual(Buffer.from(await (await f.request(f.filePath('healthy.txt'))).arrayBuffer()), BODY);
    assert.equal((await f.request(f.filePath('pending.txt'))).status, 404);
    assert.deepEqual((await f.backend.list([SPACE])).map(entry => entry.name), ['healthy.txt']);
    assert.deepEqual(await readFile(join(f.directory, healthy, 'READY.json')), originalReady);
    const before = f.calls.length;
    assert.equal((await f.request(f.filePath('pending.txt'), 'PUT', BODY)).status, 201);
    assert.deepEqual(f.calls.slice(before).map(([operation]) => operation), ['status', 'deposit']);
    assert.deepEqual((await readdir(f.directory)).filter(name => name.startsWith('object-')).sort(), ids);
    const ready = JSON.parse(await readFile(join(pendingRoot, 'READY.json')));
    assert.equal(ready.version, 1);
    assert.equal(ready.catalogSha256, JSON.parse(await readFile(join(pendingRoot, 'catalog/receipt.json'))).cipher_sha256);
    assert.equal((await lstat(join(pendingRoot, 'READY.json'))).nlink, 1);
    await f.stop(); await f.start();
    assert.deepEqual(Buffer.from(await (await f.request(f.filePath('pending.txt'))).arrayBuffer()), BODY);
    assert.deepEqual(Buffer.from(await (await f.request(f.filePath('healthy.txt'))).arrayBuffer()), BODY);
  });

test('owner-upload receipt cannot be relabeled as an upstream-authorized DAV import',
  { timeout: 90000 }, async t => {
    const f = await fixture(t);
    await f.start();
    assert.equal((await f.request(f.filePath('private.txt'), 'PUT', BODY)).status, 201);
    const id = (await readdir(f.directory)).find(name => name.startsWith('object-'));
    const bundle = join(f.directory, id, 'bundle');
    const receipt = JSON.parse(await readFile(join(bundle, 'receipt.json')));
    await writeFile(join(bundle, 'receipt.json'), JSON.stringify({ ...receipt,
      version: 1, source_consistency: 'strong-etag-conditional-ranges' }), { mode: 0o600 });
    await assert.rejects(restorePrivateFile({ bundle, cipher: join(bundle, 'file.pgp'), output: join(f.root, 'forged-restore') }), { code: 'CRYPTO_FAILED' });
    await assert.rejects(lstat(join(f.root, 'forged-restore')), { code: 'ENOENT' });
  });

test('cancellation joins pending core request, retains its journal, removes staging and never commits catalog',
  { timeout: 90000 }, async t => {
    const f = await fixture(t);
    await f.start();
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let joined = false;
    f.hold = signal => new Promise((_resolve, reject) => {
      entered();
      signal.addEventListener('abort', () => { joined = true; reject(new Error('synthetic cancelled core')); }, { once: true });
    });
    const controller = new AbortController();
    const operation = f.backend.put([SPACE, 'cancelled.txt'], [BODY], { signal: controller.signal });
    const failed = assert.rejects(operation, /synthetic cancelled core/u);
    await started;
    controller.abort();
    await failed;
    assert.equal(joined, true);
    assert.deepEqual(await f.backend.list([SPACE]), []);
    assert.deepEqual(await readdir(f.workDirectory), []);
    const id = (await readdir(f.directory)).find(name => name.startsWith('object-'));
    assert.equal((await lstat(join(f.directory, id, 'journal'))).isDirectory(), true);
    await assert.rejects(lstat(join(f.directory, id, 'READY.json')), { code: 'ENOENT' });
    await f.stop();
  });

test('foreground owner and supervised lock join cleanly after real process-group shutdown',
  { timeout: 15000 }, async t => {
    const f = await fixture(t);
    // Real owner backend and Python flock supervisor. The empty base catalog
    // is synthetic; no storage exchange or browser outcome is claimed here.
    const source = `
      import { openOwnerUploads } from ${JSON.stringify(new URL('../src/owner-uploads.mjs', import.meta.url).href)};
      const backend = await openOwnerUploads(JSON.parse(process.argv[1]), {
        base: { async stat() { return null; }, async close() {} }
      });
      process.once('SIGTERM', async () => {
        try { await backend.close(); process.stdout.write('CLOSED\\n'); }
        catch { process.stderr.write('CLEANUP_FAILED\\n'); process.exitCode = 1; }
      });
      process.stdout.write('READY\\n');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source, JSON.stringify(f.config)],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const ended = once(child, 'close');
    let output = '', errors = '';
    child.stdout.on('data', part => { output += part; });
    child.stderr.on('data', part => { errors += part; });
    try {
      const [ready] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
      assert.equal(ready.toString(), 'READY\n');
      const shutdown = once(child, 'close', { signal: AbortSignal.timeout(5000) });
      process.kill(-child.pid, 'SIGTERM');
      assert.deepEqual(await shutdown, [0, null]);
      assert.equal(output, 'READY\nCLOSED\n');
      assert.equal(errors, '');
      // The acknowledged shutdown must have released its actual workspace lock.
      await f.start();
      await f.stop();
    } finally {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
      await ended;
    }
  });

test('actual pinned OpenCloud SDK uploads and resolves returned file ID, then reads through encrypted storage CONTRACT', {
  skip: !process.env.VOLPAROSSA_CLOUD_WEB_SDK && 'explicit pinned SDK staging required; no downloads', timeout: 90000,
}, async t => {
  const { webdav } = await checkedSDK(process.env.VOLPAROSSA_CLOUD_WEB_SDK);
  const f = await fixture(t);
  await f.start();
  const client = webdav(f.origin, () => ({ Authorization: `Bearer ${TOKEN}` }));
  const space = { id: recoverySpaceId(SPACE), webDavPath: `spaces/${recoverySpaceId(SPACE)}`, driveType: 'project' };
  const name = 'SDK α upload.txt';
  const created = await client.putFileContents(space, {
    fileName: name, parentFolderId: recoveryResourceId([SPACE]), content: BODY.toString(),
  });
  assert.equal(created.name, name);
  assert.equal(created.id, recoveryResourceId([SPACE, name]));
  assert.equal(created.etag, `"vp-${hash(BODY)}"`);
  // Original Files awaits Graph getDrive before refreshing its DAV listing.
  // checkedSDK above verified every packaged module, including this import.
  const { graph } = await import(pathToFileURL(join(process.env.VOLPAROSSA_CLOUD_WEB_SDK,
    'package/dist/web-client/graph.js')).href);
  const refreshed = await graph(f.origin).drives.getDrive(space.id, undefined, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(refreshed.id, space.id);
  assert.equal(refreshed.driveType, 'project');
  assert.deepEqual(refreshed.spaceQuota, {}); // Never invent available peer capacity.
  const files = await client.listFiles(space);
  assert.equal(files.children.length, 1);
  assert.equal(files.children[0].name, name);
  const read = await client.getFileContents(space, { fileId: created.id }, { responseType: 'arraybuffer' });
  assert.deepEqual(Buffer.from(read.body), BODY);
  await assert.rejects(client.putFileContents(space, { path: name, content: 'replacement', overwrite: true }),
    error => error.statusCode === 412);
  assert.deepEqual(f.calls.map(([op]) => op), ['create', 'deposit', 'restore']);
});
