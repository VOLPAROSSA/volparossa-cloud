// SPDX-License-Identifier: GPL-3.0-only
// Actual GPG + catalog + service + pinned OpenCloud SDK, with ONLY the core
// storage boundary replaced by an explicit fixture. This is not peer proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { importPrivateFile } from '../src/private-file.mjs';
import { createPrivateCatalog, openPrivateCatalog } from '../src/private-catalog.mjs';
import { startCloudService } from '../scripts/cloud-serve.mjs';
import { checkedSDK } from './fixtures/checked-sdk.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SDK = process.env.VOLPAROSSA_CLOUD_WEB_SDK;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual GPG catalog -> Cloud service -> OpenCloud Web8 SDK with source OFF and explicit fake core adapter', {
  skip: !SDK && 'explicit pinned SDK staging required; no automatic downloads', timeout: 60000,
}, async () => {
  const { webdav } = await checkedSDK(SDK);
  const root = await mkdtemp(join(ROOT, 'build/catalog-sdk-'));
  await chmod(root, 0o700);
  const workDirectory = join(root, 'work');
  await mkdir(workDirectory, { mode: 0o700 });
  const sourceToken = 'synthetic-source-only-token';
  const serviceToken = 'synthetic-catalog-sdk-only-token-1234567890';
  const spaceId = 'owner-space';
  const filename = 'Owner α & notes.txt';
  const data = Buffer.from('Synthetic source-off owner content; no private user document.\n'.repeat(32));
  const sourcePath = `/dav/spaces/${spaceId}/${encodeURIComponent(filename)}`;
  const sourceETag = '"synthetic-dav-import-v1"';
  const fileETag = `"vp-${digest(data)}"`;
  let requests = 0;
  let stopped = false;
  const source = http.createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, `Bearer ${sourceToken}`);
    assert.equal(request.url, sourcePath);
    response.setHeader('ETag', sourceETag);
    response.setHeader('Last-Modified', 'Thu, 01 Oct 2026 10:00:00 GMT');
    if (request.method === 'HEAD') {
      response.setHeader('Content-Length', data.length);
      response.end();
      return;
    }
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['if-match'], sourceETag);
    const [, first, last] = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range);
    const bytes = data.subarray(Number(first), Number(last) + 1);
    response.writeHead(206, { 'Content-Length': bytes.length,
      'Content-Range': `bytes ${first}-${last}/${data.length}` });
    response.end(bytes);
  });
  const stopSource = async () => {
    if (stopped) return;
    stopped = true;
    const closed = new Promise(resolve => source.close(resolve));
    source.closeAllConnections();
    await closed;
  };
  let service;
  try {
    source.listen(0, '127.0.0.1');
    await once(source, 'listening');
    const bundle = join(root, 'owner-bundle');
    await importPrivateFile({
      source: { origin: `http://127.0.0.1:${source.address().port}`, bearerToken: sourceToken,
        allowInsecureLoopbackForTests: true, maxRequestBytes: 1024 },
      resource: { spaceId, pathSegments: [filename] }, output: bundle,
    });
    const ciphertext = await readFile(join(bundle, 'file.pgp'));
    await rm(join(bundle, 'file.pgp'));
    await stopSource();
    assert.equal(source.listening, false);
    await assert.rejects(lstat(join(bundle, 'file.pgp')), { code: 'ENOENT' });
    const sourceRequests = requests;
    const config = join(root, 'storage.private.json');
    await writeFile(config, '{"synthetic_contract_only":true}', { mode: 0o600 });
    const restores = [];
    // ONLY this boundary is fake. No provider grants, fragments, protected
    // routes, independent devices or storage charges are proven by this test.
    const storageFactory = async received => {
      assert.equal(received, config);
      return { restore: async (request, { signal }) => {
        assert.equal(signal?.aborted ?? false, false);
        assert.equal(request.sha256, digest(ciphertext));
        restores.push(request.output);
        await writeFile(request.output, ciphertext, { mode: 0o600, flag: 'wx' });
        return { status: 'complete', restore_verified: true, local_process_joined: true };
      } };
    };
    const catalog = join(root, 'catalog');
    const created = await createPrivateCatalog({
      selection: [{ segments: [spaceId, filename], bundle, config }], output: catalog, workDirectory,
    }, { storageFactory });
    assert.equal(created.files, 1);
    assert.equal(created.encrypted, true);
    assert.equal(created.sourceFallback, false);
    assert.equal(restores.length, 1);
    assert.deepEqual(await readdir(workDirectory), []);
    service = await startCloudService({
      version: 1, catalog, workDirectory, bearerToken: serviceToken, maxOpenBytes: 1024 ** 2,
    }, {
      // Keep real catalog and HTTP implementations: inject the test seam only
      // into restoreStoredFile via openPrivateCatalog's existing factory.
      openCatalog: (options, context) => openPrivateCatalog(options, { ...context, storageFactory }),
    });
    const client = webdav(service.origin, () => ({ Authorization: `Bearer ${serviceToken}` }));
    const space = { id: spaceId, webDavPath: `spaces/${spaceId}`, driveType: 'personal' };
    const listing = await client.listFiles(space);
    assert.equal(listing.children.length, 1);
    assert.equal(listing.children[0].name, filename);
    assert.equal(restores.length, 1); // Metadata comes from the decrypted immutable catalog.
    const complete = await client.getFileContents(space, { path: filename }, { responseType: 'arraybuffer' });
    assert.equal(complete.response.status, 200);
    assert.equal(complete.headers.ETag, fileETag);
    assert.deepEqual(Buffer.from(complete.body), data);
    const ranged = await client.getFileContents(space, { path: filename }, {
      responseType: 'arraybuffer', headers: { Range: 'bytes=7-42', 'If-Match': fileETag },
    });
    assert.equal(ranged.response.status, 206);
    assert.deepEqual(Buffer.from(ranged.body), data.subarray(7, 43));
    const repeated = await client.getFileContents(space, { path: filename }, { responseType: 'arraybuffer' });
    assert.deepEqual(Buffer.from(repeated.body), data);
    assert.equal(repeated.headers.ETag, fileETag);
    assert.equal(restores.length, 4); // One creation + three distinct real GPG restorations.
    const unauthorized = webdav(service.origin, () => ({ Authorization: 'Bearer wrong-token' }));
    await assert.rejects(unauthorized.getFileContents(space, { path: filename }), error => error.statusCode === 401);
    assert.equal(restores.length, 4);
    assert.equal(requests, sourceRequests);
    await service.close();
    await service.close();
    assert.deepEqual(await readdir(workDirectory), []);
    for (const path of restores) await assert.rejects(lstat(path), { code: 'ENOENT' });
    await assert.rejects(lstat(join(bundle, 'file.pgp')), { code: 'ENOENT' });
    assert.equal(source.listening, false);
  } finally {
    try { await service?.close(); }
    finally {
      try { await stopSource(); }
      finally { await rm(root, { recursive: true }); }
    }
  }
});
