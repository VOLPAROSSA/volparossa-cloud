// SPDX-License-Identifier: GPL-3.0-only
// Real CLI, GPG, Cloud service and HTTP. Only the core/provider/signing boundary
// is a synthetic contract fixture; this is not protected peer-storage evidence.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPrivateCatalog, openPrivateCatalog } from '../src/private-catalog.mjs';
import { recoverySpaceId } from '../src/private-resource-id.mjs';
import { openUploadMaintenance } from '../src/storage-upload-maintenance.mjs';
import { startCloudService } from '../scripts/cloud-serve.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'scripts/cloud-catalog.mjs');
const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const TOKEN = 'synthetic-empty-catalog-owner-token-1234567890';
const BODY = Buffer.from('Synthetic first upload: no earlier imported files.\n');

async function workspace(t) {
  await mkdir(join(ROOT, 'build'), { mode: 0o700, recursive: true });
  const root = await mkdtemp(join(ROOT, 'build', 'empty-cat-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work'), { mode: 0o700 });
  await writeFile(join(root, 'selection.json'), JSON.stringify({ version: 1, files: [] }), { mode: 0o600 });
  return { root, workDirectory: join(root, 'work'), catalog: join(root, 'catalog') };
}

async function cli(operation, f) {
  const args = [CLI, operation, '--catalog', f.catalog, '--work-directory', f.workDirectory];
  if (operation === 'create') args.push('--selection', join(f.root, 'selection.json'));
  const { stdout, stderr } = await execute(process.execPath, args, { timeout: 30000, maxBuffer: 8192 });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('explicit CLI creates and inspects an authenticated empty catalog without any imported files',
  { timeout: 90000 }, async t => {
    const f = await workspace(t);
    assert.deepEqual(await cli('create', f), { version: 1, kind: 'volparossa-cloud-private-catalog-created',
      files: 0, plaintextBytes: 0, selectedCiphertextBytes: 0, encrypted: true, ownerOnly: true,
      sourceFallback: false, secondDeviceRecoveryProven: false });
    assert.deepEqual(await cli('inspect', f), { version: 1, kind: 'volparossa-cloud-private-catalog-summary',
      files: 0, directories: 1, plaintextBytes: 0, ownerOnly: true, contentMaterialized: false,
      secondDeviceRecoveryProven: false });
    assert.deepEqual((await readdir(f.catalog)).sort(), ['catalog.pgp', 'receipt.json', 'recovery.key']);
    for (const name of await readdir(f.catalog)) assert.equal((await lstat(join(f.catalog, name))).mode & 0o777, 0o600);
    assert.equal((await lstat(f.catalog)).mode & 0o777, 0o700);
    const ciphertext = await readFile(join(f.catalog, 'catalog.pgp'));
    const originalReceipt = await readFile(join(f.catalog, 'receipt.json'));
    const receipt = JSON.parse(originalReceipt);
    assert.equal(receipt.cipher_sha256, digest(ciphertext));
    assert.equal(receipt.cipher_bytes, ciphertext.length);
    assert.equal(receipt.encryption, 'OpenPGP-AES256');
    assert.equal(ciphertext.includes(Buffer.from('volparossa-cloud-private-catalog-index')), false);
    const backend = await openPrivateCatalog(f, { storageFactory: () => assert.fail('empty catalog accessed storage') });
    try {
      assert.deepEqual(await backend.list([]), []);
      assert.equal((await backend.stat([])).kind, 'directory');
      assert.equal(await backend.stat(['missing']), null);
      await assert.rejects(backend.open(['missing', 'file']), { code: 'NOT_FOUND' });
    } finally { await backend.close(); }
    await assert.rejects(cli('create', f));
    assert.deepEqual(await readFile(join(f.catalog, 'catalog.pgp')), ciphertext);

    // Recomputing the outer hash cannot authorize modified encrypted bytes.
    const corrupted = Buffer.from(ciphertext);
    corrupted[Math.floor(corrupted.length / 2)] ^= 1;
    await writeFile(join(f.catalog, 'catalog.pgp'), corrupted);
    await writeFile(join(f.catalog, 'receipt.json'), JSON.stringify({ ...receipt, cipher_sha256: digest(corrupted) }));
    await assert.rejects(openPrivateCatalog(f), { code: 'CATALOG_CRYPTO_FAILED' });
    await assert.rejects(startCloudService({ version: 1, catalog: f.catalog,
      workDirectory: f.workDirectory, bearerToken: TOKEN }, {
      startServer: () => assert.fail('corrupted catalog reached listener'),
    }), { code: 'CATALOG_CRYPTO_FAILED' });
    await writeFile(join(f.catalog, 'catalog.pgp'), ciphertext);
    await writeFile(join(f.catalog, 'receipt.json'), originalReceipt);
    const missing = join(f.root, 'missing-catalog');
    await assert.rejects(startCloudService({ version: 1, catalog: missing,
      workDirectory: f.workDirectory, bearerToken: TOKEN }, {
      startServer: () => assert.fail('missing catalog reached listener'),
    }));
    await assert.rejects(lstat(missing), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.workDirectory), []);
  });

test('empty support preserves existing malformed, duplicate, path and 256-entry limits', async t => {
  const f = await workspace(t);
  const entry = { segments: ['space', 'file'], bundle: join(f.root, 'bundle'), config: join(f.root, 'core.json') };
  for (const [selection, code] of [[null, 'INVALID_SELECTION'], [{}, 'INVALID_SELECTION'],
    [Array(257).fill(entry), 'INVALID_SELECTION'], [[entry, entry], 'DUPLICATE_SELECTION'],
    [[{ ...entry, segments: ['space', '..'] }], 'INVALID_CATALOG_PATH'],
    [[{ ...entry, extra: true }], 'INVALID_SELECTION']]) {
    await assert.rejects(createPrivateCatalog({ selection, output: f.catalog, workDirectory: f.workDirectory },
      { storageFactory: () => assert.fail('invalid selection accessed storage') }), { code });
  }
  await assert.rejects(lstat(f.catalog), { code: 'ENOENT' });
});

test('fresh real empty catalog starts cloud-serve, admits a first HTTP upload, and survives a cold restart GET',
  { timeout: 90000 }, async t => {
    const f = await workspace(t);
    await cli('create', f);
    const initialCipher = await readFile(join(f.catalog, 'catalog.pgp'));
    const uploads = join(f.root, 'uploads'), storageConfig = join(f.root, 'template.json');
    await mkdir(uploads, { mode: 0o700 });
    const providers = [1, 2, 3].map(number => ({ key: String(number).repeat(64), grant: join(f.root, `grant-${number}`) }));
    for (const provider of providers) await writeFile(provider.grant, 'Synthetic core contract grant', { mode: 0o600 });
    await writeFile(storageConfig, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
    const policy = { version: 2, expiresAt: Math.floor(Date.now() / 1000) + 3600, maxSessions: 1,
      maxChargedBytes: 1048576, perArchiveMaxChargedBytes: 1048576, fromProviderKey: providers[0].key,
      lifetimeSeconds: 600, renewBeforeSeconds: 900, maximumTurnBytes: 1048576, existing: [] };
    const remote = new Map(), calls = [];
    const storageFactory = async configPath => {
      const config = JSON.parse(await readFile(configPath));
      const object = dirname(configPath);
      let finish;
      const storage = async () => {
        const receipt = JSON.parse(await readFile(join(object, 'bundle/receipt.json')));
        return { logical_ciphertext_bytes: receipt.cipher_bytes,
          physical_payload_charge_upper_bound: 2 * receipt.cipher_bytes, fully_redundant_from_retained_receipts: true };
      };
      return {
        async create(request) {
          const intent = JSON.parse(await readFile(join(object, 'MAINTENANCE.json')));
          assert.equal(intent.expiresAt, policy.expiresAt);
          await assert.rejects(lstat(join(object, 'READY.json')), { code: 'ENOENT' });
          assert.equal(request.alreadyEncrypted, true);
          assert.equal(digest(await readFile(request.input)), request.sha256);
          calls.push('create');
          await mkdir(config.stateDirectory, { mode: 0o700 });
          return { status: 'complete', local_process_joined: true, storage: await storage() };
        },
        async deposit(request) {
          calls.push('deposit');
          assert.equal(request.alreadyEncrypted, true);
          remote.set(configPath, await readFile(request.input));
          assert.equal(remote.get(configPath).includes(BODY), false);
          return { status: 'complete', local_process_joined: true, storage: await storage() };
        },
        async enrollMaintenance(request) {
          calls.push('enroll');
          assert.equal(request.authorizationExpiresAt, policy.expiresAt);
          await assert.rejects(lstat(join(object, 'READY.json')), { code: 'ENOENT' });
          await mkdir(request.enrollment, { mode: 0o700 });
          await writeFile(join(request.enrollment, 'enrollment.json'), JSON.stringify({ enrollment: {
            version: 1, archive: config.stateDirectory, expires: request.authorizationExpiresAt,
            maximum_charged: request.maximumChargedBytes, lifetime: request.lifetimeSeconds,
            renew_before: request.renewBeforeSeconds, maximum_turn: request.maximumTurnBytes,
            source: [...Buffer.from(request.fromProviderKey, 'hex')],
            providers: request.providers.map(provider => [...Buffer.from(provider.key, 'hex')]),
            grants: await Promise.all(request.providers.map(async provider => (await readFile(provider.grant)).toString('hex'))),
          }, signature: 'synthetic core contract only' }), { mode: 0o600 });
          return { status: 'complete', local_process_joined: true };
        },
        async maintenanceStatus() { return { status: 'complete', local_process_joined: true }; },
        async startMaintenance() {
          calls.push('start');
          return { done: new Promise(resolve => { finish = resolve; }) };
        },
        async restore(request) {
          calls.push('restore');
          assert.equal(digest(remote.get(configPath)), request.sha256);
          await writeFile(request.output, remote.get(configPath), { mode: 0o600, flag: 'wx' });
          return { status: 'complete', restore_verified: true, local_process_joined: true };
        },
        async close() { finish?.(); },
      };
    };
    const config = { version: 1, catalog: f.catalog, workDirectory: f.workDirectory, bearerToken: TOKEN,
      ownerUploads: { directory: uploads, space: 'Uploads', storageConfig }, storageMaintenance: policy };
    const options = { openMaintenance: (value, context) => openUploadMaintenance(value, { ...context, storageFactory }) };
    let service;
    t.after(async () => { await service?.close(); });
    service = await startCloudService(config, options); // No fake catalog or listener.
    const filePath = `/dav/spaces/${recoverySpaceId('Uploads')}/first.txt`;
    const request = (path, method = 'GET', body, token = TOKEN) => fetch(service.origin + path,
      { method, headers: { Authorization: `Bearer ${token}`, ...(method === 'PROPFIND' ? { Depth: '1' } : {}) },
        ...(body === undefined ? {} : { body }) });
    assert.equal(service.readOnly, false);
    assert.equal((await service.maintenanceStatus()).configured_sessions, 0);
    assert.deepEqual(calls, []);
    assert.equal((await request(filePath, 'GET')).status, 404);
    assert.equal((await request(filePath, 'PUT', BODY, 'wrong-token')).status, 401);
    assert.deepEqual(calls, []);
    const listing = await request('/dav/spaces/', 'PROPFIND', '');
    assert.equal(listing.status, 207);
    const metadata = await listing.text();
    assert.ok(metadata.includes('Uploads'));
    assert.equal(metadata.includes('Imported'), false);
    assert.equal((await request(filePath, 'PUT', BODY)).status, 201);
    assert.deepEqual(calls, ['create', 'deposit', 'enroll', 'start']);
    const names = (await readdir(uploads)).filter(name => name !== 'LOCK');
    assert.equal(names.length, 1);
    const object = join(uploads, names[0]);
    const intent = await readFile(join(object, 'MAINTENANCE.json'));
    const enrollment = await readFile(join(object, 'maintenance/enrollment.json'));
    assert.equal((await lstat(join(object, 'READY.json'))).mode & 0o777, 0o600);
    await service.close();
    await rm(join(object, 'bundle/file.pgp'));
    service = await startCloudService(config, options);
    const response = await request(filePath);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), BODY);
    assert.deepEqual(calls, ['create', 'deposit', 'enroll', 'start', 'start', 'restore']);
    assert.deepEqual(await readFile(join(object, 'MAINTENANCE.json')), intent);
    assert.deepEqual(await readFile(join(object, 'maintenance/enrollment.json')), enrollment);
    assert.deepEqual(await readFile(join(f.catalog, 'catalog.pgp')), initialCipher);
    await assert.rejects(lstat(join(object, 'bundle/file.pgp')), { code: 'ENOENT' });
    await service.close();
    assert.deepEqual(await readdir(f.workDirectory), []);
  });
