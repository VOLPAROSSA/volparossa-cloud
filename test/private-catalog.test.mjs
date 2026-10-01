// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { importPrivateFile } from '../src/private-file.mjs';
import { createPrivateCatalog, openPrivateCatalog } from '../src/private-catalog.mjs';
import { parseArguments, run } from '../scripts/cloud-catalog.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ITEMS = [
  { segments: ['space-a', 'private.txt'], bytes: Buffer.from('Private synthetic owner content.\n'.repeat(1024)) },
  { segments: ['space-a', 'nested', 'é-δ.txt'], bytes: Buffer.from('Unicode private synthetic file.\n') },
  { segments: ['space-b', 'empty.txt'], bytes: Buffer.alloc(0) },
];

async function privateWorkspace(t) {
  await mkdir(join(ROOT, 'build'), { mode: 0o700, recursive: true });
  const path = await mkdtemp(join(ROOT, 'build', 'catalog-test-'));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, 'work'), { mode: 0o700 });
  return path;
}

async function imports(t, root) {
  const token = 'synthetic-owner-token';
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount++;
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const item = ITEMS.find(value => request.url === `/dav/spaces/${value.segments.map(encodeURIComponent).join('/')}`);
    assert.ok(item);
    response.setHeader('ETag', '"synthetic-source-v1"');
    if (request.method === 'HEAD') {
      response.setHeader('Content-Length', item.bytes.length);
      response.end(); return;
    }
    assert.equal(request.headers['if-match'], '"synthetic-source-v1"');
    const [, first, last] = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range);
    const bytes = item.bytes.subarray(Number(first), Number(last) + 1);
    response.writeHead(206, { 'Content-Length': bytes.length, 'Content-Range': `bytes ${first}-${last}/${item.bytes.length}` });
    response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const pending = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await pending;
  };
  t.after(stop);
  const source = { origin: `http://127.0.0.1:${server.address().port}`, bearerToken: token,
    allowInsecureLoopbackForTests: true, maxRequestBytes: 16384 };
  const selection = [];
  const encrypted = new Map();
  for (const [index, item] of ITEMS.entries()) {
    const bundle = join(root, `file-${index}`);
    await importPrivateFile({ source, resource: { spaceId: item.segments[0], pathSegments: item.segments.slice(1) }, output: bundle });
    const config = join(root, `core-${index}.private.json`);
    await writeFile(config, '{"synthetic_contract_only":true}', { mode: 0o600 });
    selection.push({ segments: item.segments, bundle, config });
    encrypted.set(config, await readFile(join(bundle, 'file.pgp')));
    await rm(join(bundle, 'file.pgp'));
  }
  await stop();
  return { selection, encrypted, requestCount: () => requestCount };
}

test('catalog CLI only accepts private explicit selections and reports no paths or names', () => {
  assert.deepEqual(parseArguments(['create', '--selection', '/private/selection.json', '--catalog', '/private/catalog',
    '--work-directory', '/private/work', '--max-total-bytes', '1000']), {
    operation: 'create', selection: '/private/selection.json', catalog: '/private/catalog',
    'work-directory': '/private/work', 'max-total-bytes': '1000',
  });
  assert.throws(() => parseArguments(['create', '--catalog', '/private/catalog', '--work-directory', '/private/work']));
  assert.throws(() => parseArguments(['inspect', '--catalog', '/private/catalog', '--work-directory', '/private/work', '--copies', '3']));
  assert.throws(() => parseArguments(['inspect', '--catalog', '/private/catalog', '--work-directory', '/private/work', '--storageFactory', 'fake']));
});

test('real GPG encrypted owner catalog; source off, repeated verified reads using explicit core CONTRACT fixture',
  { timeout: 120000 }, async t => {
    const root = await privateWorkspace(t);
    const workDirectory = join(root, 'work');
    const imported = await imports(t, root);
    const originalRequests = imported.requestCount();
    const calls = [];
    let hold;
    // This in-memory storage factory is NOT a real provider/core-route proof.
    // Every returned ciphertext is still really decrypted/authenticated by GPG.
    const storageFactory = async config => ({
      restore: async (request, { signal } = {}) => {
        calls.push({ config, request });
        if (hold) await hold(signal);
        if (signal?.aborted) throw new Error('synthetic cancelled operation');
        await writeFile(request.output, imported.encrypted.get(config), { mode: 0o600, flag: 'wx' });
        return { status: 'complete', restore_verified: true, local_process_joined: true };
      },
    });
    const catalog = join(root, 'catalog');
    const options = { selection: imported.selection, output: catalog, workDirectory };
    const summary = await createPrivateCatalog(options, { storageFactory });
    assert.equal(summary.files, 3);
    assert.equal(summary.plaintextBytes, ITEMS.reduce((sum, item) => sum + item.bytes.length, 0));
    assert.equal(summary.sourceFallback, false);
    assert.equal(summary.secondDeviceRecoveryProven, false);
    assert.equal(calls.length, 3);
    assert.deepEqual(await readdir(workDirectory), []);
    const ciphertext = await readFile(join(catalog, 'catalog.pgp'));
    for (const name of ['catalog.pgp', 'receipt.json', 'recovery.key']) {
      assert.equal((await lstat(join(catalog, name))).mode & 0o777, 0o600);
    }
    for (const canary of [root, 'private.txt', 'space-a', 'owner-token']) {
      assert.ok(!JSON.stringify(summary).includes(canary));
      assert.ok(!ciphertext.includes(Buffer.from(canary)));
      assert.ok(!(await readFile(join(catalog, 'receipt.json'), 'utf8')).includes(canary));
    }
    const backend = await openPrivateCatalog({ catalog, workDirectory }, { storageFactory });
    t.after(() => backend.close());

    await t.test('canonical spaces, nested Unicode names and empty files expose only immutable public fields', async () => {
      const rootStat = await backend.stat([]);
      assert.equal(rootStat.kind, 'directory');
      assert.equal(rootStat.size, 0);
      assert.match(rootStat.etag, /^"vp-dir-[0-9a-f]{64}"$/u);
      assert.deepEqual((await backend.list([])).map(item => item.name), ['space-a', 'space-b']);
      assert.deepEqual((await backend.list(['space-a'])).map(item => item.name), ['nested', 'private.txt']);
      assert.equal((await backend.list(['space-a', 'nested']))[0].name, 'é-δ.txt');
      for (const item of ITEMS) {
        assert.deepEqual(await backend.stat(item.segments), { kind: 'file', size: item.bytes.length,
          etag: `"vp-${digest(item.bytes)}"`, lastModified: null });
      }
      assert.equal(await backend.stat(['unknown']), null);
      await assert.rejects(backend.stat(['space-a', '..']), { code: 'INVALID_CATALOG_PATH' });
      await assert.rejects(backend.open(['space-a']), { code: 'NOT_A_FILE' });
      await assert.rejects(backend.list(ITEMS[0].segments), { code: 'NOT_A_DIRECTORY' });
      assert.equal(calls.length, 3); // Metadata operations do not fetch content.
    });

    await t.test('every open does a new verified restore and disposal removes only private materialization', async () => {
      for (const item of ITEMS) {
        const metadata = await backend.stat(item.segments);
        const file = await backend.open(item.segments);
        assert.equal(file.size, metadata.size);
        assert.equal(file.etag, metadata.etag);
        assert.deepEqual(await readFile(file.path), item.bytes);
        assert.equal((await lstat(file.path)).mode & 0o777, 0o600);
        await file.dispose();
        await file.dispose();
        await assert.rejects(lstat(file.path), { code: 'ENOENT' });
      }
      assert.equal(calls.length, 6);
      assert.deepEqual(await readdir(workDirectory), []);
      assert.equal(imported.requestCount(), originalRequests);
    });

    await t.test('immutable receipt binding rejects local version substitution before provider access', async () => {
      const receiptPath = join(imported.selection[0].bundle, 'receipt.json');
      const original = await readFile(receiptPath);
      const changed = { ...JSON.parse(original), cipher_sha256: 'f'.repeat(64) };
      await writeFile(receiptPath, JSON.stringify(changed), { mode: 0o600 });
      await assert.rejects(backend.open(ITEMS[0].segments), { code: 'FILE_VERSION_CHANGED' });
      assert.equal(calls.length, 6);
      await writeFile(receiptPath, original, { mode: 0o600 });
    });

    await t.test('selection collisions and byte budgets fail without starting transfers', async () => {
      const output = join(root, 'rejected');
      await assert.rejects(createPrivateCatalog({ ...options, output, selection: [imported.selection[0], imported.selection[0]] },
        { storageFactory }), { code: 'DUPLICATE_SELECTION' });
      await assert.rejects(createPrivateCatalog({ ...options, output, maxTotalBytes: 1 }, { storageFactory }),
        { code: 'CATALOG_BYTE_BUDGET' });
      await assert.rejects(createPrivateCatalog(options, { storageFactory }), { code: 'OUTPUT_EXISTS' });
      assert.equal(calls.length, 6);
      const small = await openPrivateCatalog({ catalog, workDirectory, maxOpenBytes: 1 }, { storageFactory });
      await assert.rejects(small.open(ITEMS[0].segments), { code: 'MATERIALIZATION_CAPACITY' });
      await small.close();
      await assert.rejects(openPrivateCatalog({ catalog, workDirectory, maxOpenFiles: 17 }, { storageFactory }),
        { code: 'INVALID_FILE_BUDGET' });
    });

    await t.test('two retained reads bound capacity; close disposes both and forbids further reads', async () => {
      const separate = await openPrivateCatalog({ catalog, workDirectory }, { storageFactory });
      const files = await Promise.all([separate.open(ITEMS[0].segments), separate.open(ITEMS[1].segments)]);
      await assert.rejects(separate.open(ITEMS[2].segments), { code: 'MATERIALIZATION_CAPACITY' });
      await separate.close();
      for (const file of files) {
        await assert.rejects(lstat(file.path), { code: 'ENOENT' });
        await file.dispose();
      }
      await separate.close();
      await assert.rejects(separate.stat([]), { code: 'CATALOG_CLOSED' });
      assert.deepEqual(await readdir(workDirectory), []);
    });

    await t.test('explicit file concurrency limit composes with the independent byte budget', async () => {
      const separate = await openPrivateCatalog({ catalog, workDirectory, maxOpenFiles: 3 }, { storageFactory });
      try {
        const files = await Promise.all(ITEMS.map(item => separate.open(item.segments)));
        assert.equal(files.length, 3);
        await assert.rejects(separate.open(ITEMS[0].segments), { code: 'MATERIALIZATION_CAPACITY' });
      } finally { await separate.close(); }
      assert.deepEqual(await readdir(workDirectory), []);
    });

    await t.test('owner cancellation closes metadata and joins an incomplete materialization, with no source fallback', async () => {
      const owner = new AbortController();
      const separate = await openPrivateCatalog({ catalog, workDirectory }, { storageFactory, signal: owner.signal });
      let started;
      const ready = new Promise(resolve => { started = resolve; });
      hold = signal => new Promise((resolve, reject) => {
        started();
        if (signal.aborted) reject(new Error('cancelled'));
        else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      const rejected = assert.rejects(separate.open(ITEMS[0].segments), { code: 'CANCELLED' });
      await ready;
      owner.abort();
      await separate.close();
      await rejected;
      await assert.rejects(separate.list([]), { code: 'CATALOG_CLOSED' });
      hold = undefined;
      assert.deepEqual(await readdir(workDirectory), []);
      assert.equal(imported.requestCount(), originalRequests);
    });

    await t.test('failed private-stage cleanup remains a failed close after open has rejected', async () => {
      let alteredStage;
      const failingStorage = async () => ({ restore: async request => {
        alteredStage = dirname(dirname(request.output));
        await chmod(alteredStage, 0o500);
        throw new Error('synthetic transfer failure after directory mode change');
      } });
      const separate = await openPrivateCatalog({ catalog, workDirectory }, { storageFactory: failingStorage });
      try {
        await assert.rejects(separate.open(ITEMS[0].segments), { code: 'PRIVATE_CLEANUP_FAILED' });
        await assert.rejects(separate.close(), { code: 'PRIVATE_CLEANUP_FAILED' });
        await assert.rejects(separate.close(), { code: 'PRIVATE_CLEANUP_FAILED' });
      } finally {
        if (alteredStage) {
          await chmod(alteredStage, 0o700);
          await rm(alteredStage, { recursive: true });
        }
      }
      assert.deepEqual(await readdir(workDirectory), []);
    });

    await t.test('catalog reopening needs only owner encrypted index; CLI inspect reports no names or paths', async () => {
      const before = calls.length;
      const report = await run(parseArguments(['inspect', '--catalog', catalog, '--work-directory', workDirectory]));
      assert.equal(report.files, 3);
      assert.equal(report.directories, 4);
      assert.equal(report.contentMaterialized, false);
      assert.ok(!JSON.stringify(report).includes(root));
      assert.ok(!JSON.stringify(report).includes('space-a'));
      assert.equal(calls.length, before);
    });

    await t.test('damaged encrypted index cannot publish a backend even with a modified outer receipt', async () => {
      const originalReceipt = await readFile(join(catalog, 'receipt.json'));
      const altered = Buffer.from(ciphertext);
      altered[Math.floor(altered.length / 2)] ^= 1;
      await writeFile(join(catalog, 'catalog.pgp'), altered, { mode: 0o600 });
      await writeFile(join(catalog, 'receipt.json'), JSON.stringify({ ...JSON.parse(originalReceipt),
        cipher_sha256: digest(altered) }), { mode: 0o600 });
      await assert.rejects(openPrivateCatalog({ catalog, workDirectory }, { storageFactory }), { code: 'CATALOG_CRYPTO_FAILED' });
      await writeFile(join(catalog, 'catalog.pgp'), ciphertext, { mode: 0o600 });
      await writeFile(join(catalog, 'receipt.json'), originalReceipt, { mode: 0o600 });
      assert.deepEqual(await readdir(workDirectory), []);
    });
  });
