// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import {
  buildOpenCloudFileURL, createOpenCloudDav, OpenCloudDavError, validateFileURL,
} from '../src/opencloud-dav.mjs';

const TOKEN = 'synthetic-owner-token';
const RESOURCE = { spaceId: 'storage-users-1$space', pathSegments: ['private', 'a #?%2F.txt'] };
const DATA = Buffer.from('synthetic private bytes');
const code = (expected) => (error) => {
  assert.ok(error instanceof OpenCloudDavError);
  assert.equal(error.code, expected);
  assert.ok(!String(error).includes(TOKEN));
  return true;
};

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function normalResponse(req, res, data = DATA) {
  res.setHeader('ETag', '"version-1"');
  res.setHeader('Last-Modified', 'Thu, 01 Oct 2026 10:00:00 GMT');
  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', data.length);
    res.end();
    return;
  }
  const [, start, end] = /^bytes=(\d+)-(\d+)$/u.exec(req.headers.range);
  const body = data.subarray(Number(start), Number(end) + 1);
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${data.length}`,
    'Content-Length': body.length,
  });
  res.end(body);
}

async function fixture(handler, body) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = (overrides = {}) => createOpenCloudDav({
    origin, bearerToken: TOKEN, maxRequestBytes: 5,
    allowInsecureLoopbackForTests: true, ...overrides,
  });
  try { await body({ client, origin, requests }); }
  finally {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}

test('HTTPS is mandatory; only explicit numeric-loopback fixtures permit HTTP', () => {
  assert.throws(() => createOpenCloudDav({ origin: 'http://127.0.0.1', bearerToken: TOKEN }), code('HTTPS_REQUIRED'));
  for (const origin of ['http://example.org', 'http://localhost', 'http://127.0.0.2']) {
    assert.throws(() => createOpenCloudDav({ origin, bearerToken: TOKEN,
      allowInsecureLoopbackForTests: true }), code('HTTPS_REQUIRED'));
  }
  for (const origin of ['https://owner:secret@example.org', 'https://example.org/token?x=1', 'https://example.org/#secret']) {
    assert.throws(() => createOpenCloudDav({ origin, bearerToken: TOKEN }), code('INVALID_ORIGIN'));
  }
  for (const bearerToken of ['', 'abc\r\nCookie: private', 'secret value', 'x'.repeat(8193)]) {
    assert.throws(() => createOpenCloudDav({ origin: 'https://example.org', bearerToken }), code('INVALID_BEARER_TOKEN'));
  }
});

test('canonical resource URLs encode private path segments and reject token/path ambiguity', () => {
  const url = buildOpenCloudFileURL('https://example.org', RESOURCE);
  assert.equal(url, 'https://example.org/dav/spaces/storage-users-1%24space/private/a%20%23%3F%252F.txt');
  assert.equal(validateFileURL(url, 'https://example.org'), url);
  for (const pathSegments of [[], ['..'], ['a/b'], ['a\\b'], ['\nsecret'], ['\ud800']]) {
    assert.throws(() => buildOpenCloudFileURL('https://example.org', { spaceId: 's', pathSegments }), code('INVALID_RESOURCE_PATH'));
  }
  for (const candidate of [url.replace('example.org', 'other.org'), `${url}?token=secret`, `${url}#secret`,
    url.replace('https://', 'https://name:secret@'),
    'https://example.org/dav/spaces/s/a/../b', 'https://example.org/dav/spaces/s/a%2Fb']) {
    assert.throws(() => validateFileURL(candidate, 'https://example.org'), OpenCloudDavError);
  }
});

test('real HTTP HEAD and conditional bounded ranges preserve version and exact bytes', async () => {
  await fixture((req, res) => normalResponse(req, res), async ({ client, requests }) => {
    const dav = client();
    const snapshot = await dav.stat(RESOURCE);
    assert.equal(snapshot.size, DATA.length);
    assert.equal(snapshot.etag, '"version-1"');
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(!JSON.stringify(snapshot).includes(TOKEN));
    assert.deepEqual(await collect(dav.streamFile(snapshot)), DATA);
    assert.deepEqual(await collect(dav.readRange(snapshot, { offset: 2, length: 3 })), DATA.subarray(2, 5));
    assert.deepEqual(Object.keys(dav), ['stat', 'readRange', 'streamFile']);
    for (const request of requests) {
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.headers['accept-encoding'], 'identity');
      assert.ok(!request.url.includes(TOKEN));
      if (request.method === 'GET') {
        assert.equal(request.headers['if-match'], snapshot.etag);
        const [, start, end] = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range);
        assert.ok(Number(end) - Number(start) + 1 <= 5);
      }
    }
  });
});

test('redirects are never followed and response bodies never leak into errors', async () => {
  await fixture((req, res) => {
    res.writeHead(302, { Location: `/credential-target?${TOKEN}` });
    res.end(TOKEN);
  }, async ({ client, requests }) => {
    await assert.rejects(client().stat(RESOURCE), code('REDIRECT_REJECTED'));
    assert.equal(requests.length, 1);
  });
});

test('HEAD rejects weak/missing/duplicate validators, compression, oversize and authorization failure', async (t) => {
  const cases = [
    ['weak etag', { ETag: 'W/"v1"', 'Content-Length': '1' }, 200, 'STRONG_ETAG_REQUIRED'],
    ['missing etag', { 'Content-Length': '1' }, 200, 'INVALID_RESPONSE_HEADERS'],
    ['duplicate etag', { ETag: ['"v1"', '"v2"'], 'Content-Length': '1' }, 200, 'INVALID_RESPONSE_HEADERS'],
    ['oversize', { ETag: '"v1"', 'Content-Length': '101' }, 200, 'FILE_TOO_LARGE'],
    ['encoded', { ETag: '"v1"', 'Content-Length': '1', 'Content-Encoding': 'gzip' }, 200, 'ENCODED_RESPONSE_REJECTED'],
    ['unauthorized', {}, 401, 'SOURCE_AUTHORIZATION_FAILED'],
  ];
  for (const [name, headers, status, expected] of cases) {
    await t.test(name, async () => fixture((req, res) => { res.writeHead(status, headers); res.end(); },
      async ({ client }) => assert.rejects(client({ maxFileBytes: 100 }).stat(RESOURCE), code(expected))));
  }
});

test('range failures reject changed versions, wrong ranges and incorrect actual byte counts', async (t) => {
  const cases = [
    ['changed version', 206, { ETag: '"v2"' }, '12345', 'SOURCE_CHANGED'],
    ['precondition failed', 412, {}, '', 'SOURCE_CHANGED'],
    ['range ignored', 200, {}, '12345', 'UNEXPECTED_SOURCE_STATUS'],
    ['wrong offset', 206, { 'Content-Range': `bytes 1-5/${DATA.length}` }, '12345', 'RANGE_MISMATCH'],
    ['wrong declared size', 206, { 'Content-Length': '6' }, '123456', 'RANGE_MISMATCH'],
    ['overlong chunked', 206, {}, '123456', 'RANGE_TOO_LONG'],
    ['short chunked', 206, {}, '1234', 'RANGE_TRUNCATED'],
    ['redirect', 307, { Location: '/do-not-send-token' }, '', 'REDIRECT_REJECTED'],
  ];
  for (const [name, status, extra, body, expected] of cases) {
    await t.test(name, async () => fixture((req, res) => {
      if (req.method === 'HEAD') return normalResponse(req, res);
      res.writeHead(status, { ETag: '"version-1"', 'Content-Range': `bytes 0-4/${DATA.length}`, ...extra });
      res.write(body); // chunked unless the individual case explicitly supplies a length
      res.end();
    }, async ({ client, requests }) => {
      const dav = client();
      await assert.rejects(collect(dav.readRange(await dav.stat(RESOURCE), { offset: 0, length: 5 })), code(expected));
      assert.equal(requests.length, 2);
    }));
  }
});

test('change between ranges fails the whole import after partial output', async () => {
  await fixture((req, res, count) => {
    if (count < 3) return normalResponse(req, res);
    res.writeHead(412);
    res.end();
  }, async ({ client }) => {
    const dav = client();
    const snapshot = await dav.stat(RESOURCE);
    let yielded = 0;
    await assert.rejects((async () => {
      for await (const chunk of dav.streamFile(snapshot)) yielded += chunk.length;
    })(), code('SOURCE_CHANGED'));
    assert.equal(yielded, 5);
  });
});

test('request and entire-import deadlines are bounded independently', async (t) => {
  await t.test('HEAD deadline', async () => fixture(() => {}, async ({ client }) => {
    await assert.rejects(client({ timeoutMs: 40 }).stat(RESOURCE), code('DEADLINE_EXCEEDED'));
  }));
  await t.test('whole import deadline', async () => fixture((req, res) => {
    if (req.method === 'HEAD') return normalResponse(req, res);
    const timer = setTimeout(() => normalResponse(req, res), 45);
    res.on('close', () => clearTimeout(timer));
  }, async ({ client }) => {
    const dav = client({ timeoutMs: 500, totalTimeoutMs: 70 });
    await assert.rejects(collect(dav.streamFile(await dav.stat(RESOURCE))), code('DEADLINE_EXCEEDED'));
  }));
});

test('snapshot authority and range bounds are not replaceable by caller URLs', async () => {
  await fixture((req, res) => normalResponse(req, res), async ({ client, requests }) => {
    const dav = client();
    const snapshot = await dav.stat(RESOURCE);
    await assert.rejects(collect(dav.streamFile({ ...snapshot })), code('UNRECOGNIZED_SNAPSHOT'));
    await assert.rejects(collect(client().streamFile(snapshot)), code('UNRECOGNIZED_SNAPSHOT'));
    for (const bounds of [{ offset: -1, length: 1 }, { offset: 0, length: 6 },
      { offset: DATA.length, length: 1 }, { offset: 0, length: 0 }]) {
      await assert.rejects(collect(dav.readRange(snapshot, bounds)), code('INVALID_RANGE'));
    }
    assert.equal(requests.length, 1);
  });
});

test('empty files produce a complete empty stream without fabricated range requests', async () => {
  await fixture((req, res) => normalResponse(req, res, Buffer.alloc(0)), async ({ client, requests }) => {
    const dav = client();
    assert.deepEqual(await collect(dav.streamFile(await dav.stat(RESOURCE))), Buffer.alloc(0));
    assert.equal(requests.length, 1);
  });
});

test('consumer cancellation closes the active import without requesting later ranges', async () => {
  await fixture((req, res) => normalResponse(req, res), async ({ client, requests }) => {
    const dav = client();
    const snapshot = await dav.stat(RESOURCE);
    for await (const chunk of dav.streamFile(snapshot)) { assert.ok(chunk.length > 0); break; }
    assert.equal(requests.length, 2);
  });
});
