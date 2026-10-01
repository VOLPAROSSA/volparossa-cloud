// SPDX-License-Identifier: GPL-3.0-only
// Real loopback HTTP, synthetic backend contract only: NOT peer recovery proof.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startPrivateDavServer } from '../src/private-dav-server.mjs';

const TOKEN = 'synthetic-owner-credential-not-real-123456';
const DATA = Buffer.from('synthetic owner private file');
const DATE = 'Thu, 01 Oct 2026 10:00:00 GMT';
const FILE = { kind: 'file', size: DATA.length, etag: '"synthetic-v1"', lastModified: DATE };
const DIR = { kind: 'directory', size: 0, etag: '"synthetic-directory-v1"', lastModified: null };
const PATH = '/dav/spaces/space/private.txt';

async function request(server, { method = 'GET', path = PATH, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(server.origin + path, { method, agent: false,
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'volparossa-dav-contract-'));
  const calls = { stat: 0, list: 0, open: 0, dispose: 0, aborted: 0 };
  const backend = {
    async stat(parts) {
      calls.stat++;
      if (parts.length === 0 || parts.join('/') === 'space') return DIR;
      return parts.join('/') === 'space/private.txt' ? FILE : null;
    },
    async list(parts) {
      calls.list++;
      return parts.length ? [{ name: 'private.txt', ...FILE }] : [{ name: 'space', ...DIR }];
    },
    async open(parts, { signal }) {
      calls.open++;
      assert.deepEqual(parts, ['space', 'private.txt']);
      signal.throwIfAborted();
      const path = join(directory, `read-${calls.open}`);
      await writeFile(path, DATA, { flag: 'wx', mode: 0o600 });
      return { path, size: FILE.size, etag: FILE.etag, async dispose() {
        calls.dispose++; await rm(path);
      } };
    },
    ...options.backend,
  };
  const server = await startPrivateDavServer({ backend, bearerToken: TOKEN, ...options.server });
  try { await run({ server, calls, backend, directory }); }
  finally { await server.close(); await rm(directory, { recursive: true }); }
}

test('explicit loopback GET/HEAD and single ranges; metadata does not materialize files', async () => {
  await fixture(async ({ server, calls }) => {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(server.baseURL, server.origin + '/dav/spaces/');
    const head = await request(server, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.etag, FILE.etag);
    assert.equal(head.headers['content-length'], String(DATA.length));
    assert.equal(head.headers['last-modified'], DATE);
    assert.equal(calls.open, 0);
    for (const [range, status, expected] of [[undefined, 200, DATA], ['bytes=2-5', 206, DATA.subarray(2, 6)],
      ['bytes=-4', 206, DATA.subarray(-4)], ['bytes=20-', 206, DATA.subarray(20)]]) {
      const response = await request(server, { headers: range ? { Range: range } : {} });
      assert.equal(response.status, status);
      assert.deepEqual(response.body, expected);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    await server.close();
    assert.equal(calls.open, 4); assert.equal(calls.dispose, 4);
  });
});

test('authentication, Host, Origin, malformed paths and write requests reveal no metadata', async () => {
  await fixture(async ({ server, calls }) => {
    for (const options of [
      { headers: { Authorization: 'Bearer wrong' }, status: 401 },
      { headers: { Host: 'attacker.example' }, status: 403 },
      { headers: { Origin: 'https://attacker.example' }, status: 403 },
      { headers: { Origin: 'null' }, status: 403 },
      { method: 'PUT', body: TOKEN, status: 405 },
      { method: 'DELETE', status: 405 },
      { method: 'COPY', status: 405 },
      { path: '/dav/spaces/space/a%2fb', status: 400 },
      { path: '/dav/spaces/space/%00', status: 400 },
      { path: '/dav/spaces/space/%ZZ', status: 400 },
      { path: '/dav/spaces/space//x', status: 400 },
      { path: '/dav/spaces/space/private.txt?token=ignored', status: 400 },
      { headers: { 'Content-Length': '1' }, body: 'x', status: 413 },
    ]) {
      const result = await request(server, options);
      assert.equal(result.status, options.status);
      assert.equal(result.body.length, 0);
      assert.equal(result.headers.etag, undefined);
    }
    assert.equal(calls.stat, 0); assert.equal(calls.open, 0); assert.equal(calls.list, 0);
  });
});

test('conditional reads and rejected ranges are checked before restoration', async () => {
  await fixture(async ({ server, calls }) => {
    for (const [headers, status] of [
      [{ 'If-Match': '"wrong"' }, 412], [{ 'If-Match': `W/${FILE.etag}` }, 412],
      [{ 'If-None-Match': FILE.etag }, 304], [{ 'If-None-Match': `W/${FILE.etag}` }, 304],
      [{ 'If-Match': '"wrong"', 'If-None-Match': FILE.etag }, 412],
      [{ 'If-Match': 'unquoted' }, 400], [{ Range: 'bytes=100-110' }, 416],
      [{ Range: 'bytes=0-99' }, 416], [{ Range: 'bytes=0-1,3-4' }, 416],
      [{ Range: 'bytes=-0' }, 416], [{ Range: 'bytes=5-2' }, 416],
      [{ 'If-Range': FILE.etag, Range: 'bytes=0-1' }, 400],
    ]) assert.equal((await request(server, { headers })).status, status);
    assert.equal(calls.open, 0);
    const valid = await request(server, { headers: { 'If-Match': '"other", ' + FILE.etag, Range: 'bytes=0-2' } });
    assert.equal(valid.status, 206); assert.deepEqual(valid.body, DATA.subarray(0, 3));
    assert.equal((await request(server, { path: '/dav/spaces/missing', headers: { 'If-Match': '*' } })).status, 412);
    assert.equal((await request(server, { path: '/dav/spaces/missing' })).status, 404);
  }, { server: { maxRangeBytes: 8 } });
});

test('bounded PROPFIND allprop/propname/explicit properties use metadata only', async () => {
  await fixture(async ({ server, calls }) => {
    const all = await request(server, { method: 'PROPFIND', path: '/dav/spaces/space/', headers: { Depth: '1' } });
    assert.equal(all.status, 207);
    assert.equal((all.body.toString().match(/<d:response>/gu) ?? []).length, 2);
    assert.match(all.body.toString(), /<d:href>\/dav\/spaces\/space\/private.txt<\/d:href>/u);
    assert.match(all.body.toString(), /&quot;synthetic-v1&quot;/u);
    const body = '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>'
      + '<d:getetag/><d:getcontentlength/><oc:fileid/></d:prop></d:propfind>';
    const named = await request(server, { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml' }, body });
    assert.equal(named.status, 207);
    assert.match(named.body.toString(), /HTTP\/1.1 404 Not Found/u);
    assert.match(named.body.toString(), /<p:fileid xmlns:p="http:\/\/owncloud.org\/ns"\/>/u);
    const names = await request(server, { method: 'PROPFIND', headers: { Depth: '0' },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><propname/></propfind>' });
    assert.equal(names.status, 207); assert.doesNotMatch(names.body.toString(), /synthetic-v1/u);
    assert.equal(calls.open, 0);
  });
});

test('infinite depth, XML entities, malformed/body limits fail without catalog access', async () => {
  await fixture(async ({ server, calls }) => {
    for (const options of [
      { headers: { Depth: 'infinity' }, status: 403 },
      { headers: {}, status: 403 },
      { body: '<!DOCTYPE x SYSTEM "file:///private"><d:propfind/>', status: 400 },
      { body: '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag>&secret;</d:getetag></d:prop></d:propfind>', status: 400 },
      { body: '<d:propfind xmlns:d="DAV:"><d:propname></d:allprop></d:propfind>', status: 400 },
      { body: '<d:propfind xmlns:d="DAV:"><d:propname/><d:allprop/></d:propfind>', status: 400 },
      { body: 'x'.repeat(16385), status: 413 },
    ]) {
      const result = await request(server, { method: 'PROPFIND', headers: { Depth: '0' }, ...options });
      assert.equal(result.status, options.status);
    }
    assert.equal(calls.stat, 0); assert.equal(calls.open, 0);
  });
});

test('explicit allowed-origin preflight contains no catalog data and reads still need bearer', async () => {
  await fixture(async ({ server, calls }) => {
    const origin = 'https://owner.example';
    const response = await request(server, { method: 'OPTIONS', headers: { Authorization: '', Origin: origin,
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,range' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], origin);
    assert.equal(calls.stat, 0);
    assert.equal((await request(server, { headers: { Origin: origin, Authorization: '' } })).status, 401);
    assert.equal((await request(server, { method: 'HEAD', headers: { Origin: origin } })).status, 200);
    assert.equal((await request(server, { method: 'OPTIONS', headers: { Origin: origin,
      'Access-Control-Request-Method': 'PUT' } })).status, 405);
  }, { server: { allowedOrigins: ['https://owner.example'] } });
});

test('duplicate authority headers are rejected by real raw HTTP before catalog lookup', async () => {
  await fixture(async ({ server, calls }) => {
    const url = new URL(server.origin);
    const result = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(url.port), '127.0.0.1');
      let text = '';
      socket.on('error', reject);
      socket.on('data', data => { text += data; });
      socket.on('end', () => resolve(text));
      socket.on('connect', () => socket.end(`GET ${PATH} HTTP/1.1\r\nHost: ${url.host}\r\n`
        + `Authorization: Bearer ${TOKEN}\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`));
    });
    assert.match(result, /^HTTP\/1.1 400/u);
    assert.equal(calls.stat, 0);
  });
});

test('concurrency/deadline abort backend work and close joins outstanding requests', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let aborted = 0;
  await fixture(async ({ server }) => {
    const first = request(server);
    await started;
    assert.equal((await request(server)).status, 503);
    assert.equal((await first).status, 504);
    await server.close();
    assert.equal(aborted, 1);
  }, { server: { maxConcurrent: 1, requestTimeoutMs: 100 }, backend: {
    async open(_parts, { signal }) {
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        aborted++; reject(new Error('private backend details never serialized'));
      }, { once: true }));
    },
  } });
});

test('post-materialization version mismatch disposes plaintext without returning any bytes', async () => {
  let disposed = 0;
  await fixture(async ({ server }) => {
    const result = await request(server);
    assert.equal(result.status, 503); assert.equal(result.body.length, 0);
    await server.close(); assert.equal(disposed, 1);
  }, { backend: { async open() {
    return { path: '/never-opened-private-path', size: FILE.size, etag: '"wrong"', async dispose() { disposed++; } };
  } } });
});

test('explicit server close aborts and joins a pending backend restore', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let joined = false;
  await fixture(async ({ server }) => {
    // The client sees cancellation, never a successful partial private response.
    const response = request(server).then(value => value.status, () => 'disconnected');
    await started;
    await server.close();
    assert.equal(joined, true);
    assert.ok(['disconnected', 504].includes(await response));
  }, { backend: { async open(_parts, { signal }) {
    entered();
    try {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    } finally { await delay(10); joined = true; }
  } } });
});

test('client stream abort removes the materialized file before close completes', async () => {
  const data = Buffer.alloc(8 * 1024 ** 2, 0x63);
  const directory = await mkdtemp(join(tmpdir(), 'volparossa-dav-abort-'));
  const path = join(directory, 'private-restored');
  let disposed = 0;
  const entry = { ...FILE, size: data.length };
  const server = await startPrivateDavServer({ bearerToken: TOKEN, backend: {
    async stat() { return entry; }, async list() { return []; },
    async open() {
      await writeFile(path, data, { mode: 0o600 });
      return { path, size: entry.size, etag: entry.etag, async dispose() { disposed++; await rm(path); } };
    },
  } });
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(server.origin + PATH, { headers: { Authorization: `Bearer ${TOKEN}` } }, res => {
        res.once('data', () => { res.destroy(); resolve(); });
        res.on('error', () => {});
      });
      req.on('error', reject);
    });
    await server.close();
    assert.equal(disposed, 1);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { await server.close(); await rm(directory, { recursive: true }); }
});

test('an already-failed disposal remains visible to close without exposing backend error details', async () => {
  let disposalStarted;
  const started = new Promise(resolve => { disposalStarted = resolve; });
  const server = await startPrivateDavServer({ bearerToken: TOKEN, backend: {
    async stat() { return FILE; }, async list() { return []; },
    async open() { return { path: '/unavailable', size: 1, etag: '"changed"', async dispose() {
      disposalStarted(); throw new Error('secret-path');
    } }; },
  } });
  assert.equal((await request(server)).status, 503);
  await started; await delay(10);
  await assert.rejects(server.close(), /Private DAV cleanup failed/u);
});
