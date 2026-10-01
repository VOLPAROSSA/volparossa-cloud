// SPDX-License-Identifier: GPL-3.0-only
// A private, read-only OpenCloud DAV source. This module is not a storage backend.
import http from 'node:http';
import https from 'node:https';

export class OpenCloudDavError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OpenCloudDavError';
    this.code = code;
  }
}

const fail = (code) => { throw new OpenCloudDavError(code); };
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

function integer(value, min, max, code = 'INVALID_LIMIT') {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function originURL(origin, allowInsecureLoopbackForTests = false) {
  let url;
  try {
    if (typeof origin !== 'string') fail('INVALID_ORIGIN');
    url = new URL(origin);
  } catch { fail('INVALID_ORIGIN'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('INVALID_ORIGIN');
  }
  if (url.protocol !== 'https:' && !(allowInsecureLoopbackForTests === true
      && url.protocol === 'http:' && LOOPBACK.has(url.hostname))) fail('HTTPS_REQUIRED');
  return url;
}

function segment(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024
      || value === '.' || value === '..' || /[\\/\x00-\x1f\x7f]/u.test(value)) {
    fail('INVALID_RESOURCE_PATH');
  }
  try { return encodeURIComponent(value); } catch { fail('INVALID_RESOURCE_PATH'); }
}

export function buildOpenCloudFileURL(origin, { spaceId, pathSegments } = {}, options = {}) {
  const base = originURL(origin, options.allowInsecureLoopbackForTests);
  if (!Array.isArray(pathSegments) || pathSegments.length < 1 || pathSegments.length > 128) {
    fail('INVALID_RESOURCE_PATH');
  }
  const path = `/dav/spaces/${segment(spaceId)}/${pathSegments.map(segment).join('/')}`;
  if (path.length > 8192) fail('INVALID_RESOURCE_PATH');
  return new URL(path, base).href;
}

// Validate a serialized canonical DAV URL without accepting credentials, redirects,
// query tokens, URL traversal normalization, encoded separators or other origins.
export function validateFileURL(fileURL, origin, options = {}) {
  const base = originURL(origin, options.allowInsecureLoopbackForTests);
  let url;
  try {
    if (typeof fileURL !== 'string' || fileURL.length > 16384) fail('INVALID_RESOURCE_URL');
    url = new URL(fileURL);
  } catch { fail('INVALID_RESOURCE_URL'); }
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith('/dav/spaces/')) fail('INVALID_RESOURCE_URL');
  let parts;
  try { parts = url.pathname.slice('/dav/spaces/'.length).split('/').map(decodeURIComponent); }
  catch { fail('INVALID_RESOURCE_URL'); }
  const canonical = buildOpenCloudFileURL(base.origin, {
    spaceId: parts[0], pathSegments: parts.slice(1),
  }, options);
  if (fileURL !== canonical) fail('INVALID_RESOURCE_URL');
  return canonical;
}

function header(response, name, required = true) {
  const values = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === name) values.push(response.rawHeaders[i + 1]);
  }
  if (values.length > 1 || (required && values.length !== 1)) fail('INVALID_RESPONSE_HEADERS');
  return values[0];
}

function sizeHeader(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) fail('INVALID_RESPONSE_SIZE');
  return integer(Number(value), 0, Number.MAX_SAFE_INTEGER, 'INVALID_RESPONSE_SIZE');
}

function strongETag(response) {
  const etag = header(response, 'etag');
  if (!/^"[\x21\x23-\x7e]{0,1024}"$/u.test(etag)) fail('STRONG_ETAG_REQUIRED');
  return etag;
}

function identityEncoding(response) {
  const encoding = header(response, 'content-encoding', false);
  if (encoding !== undefined && encoding.toLowerCase() !== 'identity') fail('ENCODED_RESPONSE_REJECTED');
}

function requireStatus(response, expected) {
  if (response.statusCode >= 300 && response.statusCode < 400) fail('REDIRECT_REJECTED');
  if (response.statusCode === 401 || response.statusCode === 403) fail('SOURCE_AUTHORIZATION_FAILED');
  if (response.statusCode === 412) fail('SOURCE_CHANGED');
  if (response.statusCode !== expected) fail('UNEXPECTED_SOURCE_STATUS');
}

/**
 * Credentials stay in this closure and never appear in snapshots or errors.
 * A caller must keep snapshots/catalogs private: filenames are private metadata.
 * TLS verification cannot be disabled. HTTP is available only for an explicitly
 * opted-in numeric-loopback test fixture, never as an automatic fallback.
 */
export function createOpenCloudDav({
  origin, bearerToken, maxFileBytes = 1024 ** 3, maxRequestBytes = 4 * 1024 ** 2,
  timeoutMs = 30_000, totalTimeoutMs = 300_000, allowInsecureLoopbackForTests = false,
} = {}) {
  const base = originURL(origin, allowInsecureLoopbackForTests);
  if (typeof bearerToken !== 'string' || bearerToken.length > 8192
      || !/^[A-Za-z0-9._~+/-]+=*$/u.test(bearerToken)) fail('INVALID_BEARER_TOKEN');
  integer(maxFileBytes, 0, 8 * 1024 ** 3);
  integer(maxRequestBytes, 1, 16 * 1024 ** 2);
  integer(timeoutMs, 1, 120_000);
  integer(totalTimeoutMs, 1, 3_600_000);
  const options = { allowInsecureLoopbackForTests };
  const snapshots = new WeakSet();

  function request(method, url, headers, deadline = Date.now() + timeoutMs) {
    validateFileURL(url, base.origin, options);
    const remaining = Math.min(timeoutMs, deadline - Date.now());
    if (remaining <= 0) fail('DEADLINE_EXCEEDED');
    return new Promise((resolve, reject) => {
      let expired = false;
      let response;
      let timer;
      const transport = base.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method, agent: false, maxHeaderSize: 16_384, rejectUnauthorized: true,
        headers: { Authorization: `Bearer ${bearerToken}`, 'Accept-Encoding': 'identity', ...headers },
      }, (incoming) => {
        response = incoming;
        // Install before handing the stream to a consumer: a deadline can fire
        // while its async iterator is paused by downstream backpressure.
        response.on('error', () => {});
        resolve({
          response,
          expired: () => expired,
          close: () => { clearTimeout(timer); response.destroy(); req.destroy(); },
        });
      });
      timer = setTimeout(() => {
        expired = true;
        req.destroy(new OpenCloudDavError('DEADLINE_EXCEEDED'));
        response?.destroy(new OpenCloudDavError('DEADLINE_EXCEEDED'));
      }, remaining);
      req.on('error', () => {
        clearTimeout(timer);
        reject(new OpenCloudDavError(expired ? 'DEADLINE_EXCEEDED' : 'SOURCE_REQUEST_FAILED'));
      });
      req.end();
    });
  }

  async function stat(resource) {
    const url = buildOpenCloudFileURL(base.origin, resource, options);
    const exchange = await request('HEAD', url, {});
    try {
      requireStatus(exchange.response, 200);
      identityEncoding(exchange.response);
      const size = sizeHeader(header(exchange.response, 'content-length'));
      if (size > maxFileBytes) fail('FILE_TOO_LARGE');
      const snapshot = Object.freeze({
        url, size, etag: strongETag(exchange.response),
        lastModified: header(exchange.response, 'last-modified', false) ?? null,
      });
      snapshots.add(snapshot);
      return snapshot;
    } finally { exchange.close(); }
  }

  function requireSnapshot(snapshot) {
    if (!snapshot || !snapshots.has(snapshot)) fail('UNRECOGNIZED_SNAPSHOT');
  }

  async function* range(snapshot, { offset, length }, deadline) {
    requireSnapshot(snapshot);
    integer(offset, 0, snapshot.size, 'INVALID_RANGE');
    integer(length, 1, maxRequestBytes, 'INVALID_RANGE');
    if (offset + length > snapshot.size) fail('INVALID_RANGE');
    const end = offset + length - 1;
    const exchange = await request('GET', snapshot.url, {
      'If-Match': snapshot.etag, Range: `bytes=${offset}-${end}`,
    }, deadline);
    try {
      const response = exchange.response;
      requireStatus(response, 206);
      identityEncoding(response);
      if (strongETag(response) !== snapshot.etag) fail('SOURCE_CHANGED');
      if (header(response, 'content-range') !== `bytes ${offset}-${end}/${snapshot.size}`) {
        fail('RANGE_MISMATCH');
      }
      const declaredLength = header(response, 'content-length', false);
      if (declaredLength !== undefined && sizeHeader(declaredLength) !== length) fail('RANGE_MISMATCH');
      let received = 0;
      for await (const chunk of response) {
        received += chunk.length;
        if (received > length) fail('RANGE_TOO_LONG');
        if (exchange.expired() || Date.now() >= deadline) fail('DEADLINE_EXCEEDED');
        yield chunk;
      }
      if (exchange.expired()) fail('DEADLINE_EXCEEDED');
      if (received !== length) fail('RANGE_TRUNCATED');
    } catch (error) {
      if (error instanceof OpenCloudDavError) throw error;
      fail(exchange.expired() ? 'DEADLINE_EXCEEDED' : 'SOURCE_REQUEST_FAILED');
    } finally { exchange.close(); }
  }

  function readRange(snapshot, bounds) {
    return range(snapshot, bounds, Date.now() + timeoutMs);
  }

  async function* streamFile(snapshot) {
    requireSnapshot(snapshot);
    const deadline = Date.now() + totalTimeoutMs;
    for (let offset = 0; offset < snapshot.size; offset += maxRequestBytes) {
      yield* range(snapshot, { offset, length: Math.min(maxRequestBytes, snapshot.size - offset) }, deadline);
    }
  }

  // No credentials, custom transport injection or caller-supplied headers escape.
  // A sink must commit imported content ONLY after its stream finishes; errors
  // may follow already yielded bytes when a source changes between ranges.
  return Object.freeze({ stat, readRange, streamFile });
}
