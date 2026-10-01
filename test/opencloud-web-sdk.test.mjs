// SPDX-License-Identifier: GPL-3.0-only
// Actual pinned published OpenCloud SDK over HTTP; backend is an explicit
// synthetic verified-file fixture. This is NOT peer storage or full web UI proof.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startPrivateDavServer } from '../src/private-dav-server.mjs';
import { checkedSDK } from './fixtures/checked-sdk.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.VOLPAROSSA_CLOUD_WEB_SDK;

test('actual OpenCloud Web8 SDK lists and reads only authenticated selected private files', {
  skip: !SDK && 'explicit pinned SDK staging required; no automatic downloads', timeout: 20000,
}, async () => {
  const { webdav } = await checkedSDK(SDK);
  const root = await mkdtemp(join(ROOT, 'build/sdk-read-'));
  await chmod(root, 0o700);
  const data = Buffer.from('Synthetic owner-selected file, not a private user document.\n');
  const filename = 'notes & plans.txt';
  const content = join(root, 'content.bin');
  await writeFile(content, data, { mode: 0o600 });
  const file = { kind: 'file', size: data.length, etag: '"synthetic-content-v1"', lastModified: null };
  const directory = { kind: 'directory', size: 0, etag: '"synthetic-catalog-v1"', lastModified: null };
  const token = 'synthetic-sdk-only-bearer-token-1234567890';
  let opens = 0;
  let disposals = 0;
  let service;
  const backend = {
    async stat(segments) {
      if (segments.join('/') === 'test-space') return directory;
      if (segments.length === 2 && segments[0] === 'test-space' && segments[1] === filename) return file;
      return null;
    },
    async list(segments) {
      assert.deepEqual(segments, ['test-space']);
      return [{ name: filename, ...file }];
    },
    async open(segments) {
      assert.deepEqual(segments, ['test-space', filename]);
      opens++;
      return { path: content, size: data.length, etag: file.etag, dispose: async () => { disposals++; } };
    },
  };
  try {
    service = await startPrivateDavServer({ backend, bearerToken: token });
    const client = webdav(service.origin, () => ({ Authorization: `Bearer ${token}` }));
    const space = { id: 'test-space', webDavPath: 'spaces/test-space', driveType: 'personal' };
    const listing = await client.listFiles(space);
    assert.equal(listing.children.length, 1);
    assert.equal(listing.children[0].name, filename);
    const complete = await client.getFileContents(space, { path: filename }, { responseType: 'arraybuffer' });
    assert.deepEqual(Buffer.from(complete.body), data);
    assert.equal(complete.headers.ETag, file.etag);
    const range = await client.getFileContents(space, { path: filename }, {
      responseType: 'arraybuffer', headers: { Range: 'bytes=3-14', 'If-Match': file.etag },
    });
    assert.equal(range.response.status, 206);
    assert.deepEqual(Buffer.from(range.body), data.subarray(3, 15));
    const unauthorized = webdav(service.origin, () => ({ Authorization: 'Bearer wrong-token' }));
    await assert.rejects(unauthorized.getFileContents(space, { path: filename }), error => error.statusCode === 401);
    await service.close();
    assert.equal(opens, 2);
    assert.equal(disposals, opens);
  } finally {
    await service?.close();
    await rm(root, { recursive: true });
  }
});
