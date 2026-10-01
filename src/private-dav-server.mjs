// SPDX-License-Identifier: GPL-3.0-only
// Explicit owner-local, read-only transport. The backend owns catalog authority
// and verified restoration; this module never discovers peers or falls back to an origin.
// Protocol references: RFC 4918 sections 9.1/13; RFC 9110 sections 13.2/14.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';

const PREFIX = '/dav/spaces/';
const ALLOW = 'OPTIONS, PROPFIND, HEAD, GET';
const BODY_MAX = 16384;
const CHILDREN_MAX = 256;
const ETAG = /^"[\x21\x23-\x7e]{0,512}"$/u;
const PROPERTIES = ['displayname', 'resourcetype', 'getcontentlength', 'getetag', 'getlastmodified', 'getcontenttype'];
const SENSITIVE_HEADERS = new Set(['host', 'authorization', 'origin', 'depth', 'range', 'if-match',
  'if-none-match', 'if-range', 'content-length', 'transfer-encoding', 'content-type',
  'access-control-request-method', 'access-control-request-headers']);
class Rejected extends Error {
  constructor(status) { super('Private DAV request rejected'); this.status = status; }
}
const check = (condition, status = 400) => { if (!condition) throw new Rejected(status); };
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const xml = value => String(value).replace(/[&<>"']/gu, value => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[value]);
function segment(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f]/u.test(value));
  encodeURIComponent(value); // Reject invalid Unicode, not normalize or decode twice.
  return value;
}
function pathSegments(target) {
  check(typeof target === 'string' && target.length <= 8192 && target.startsWith(PREFIX)
    && !/[?#\\\x00-\x20\x7f]/u.test(target));
  const tail = target.slice(PREFIX.length).replace(/\/$/u, '');
  if (!tail) return [];
  try { return tail.split('/').map(value => segment(decodeURIComponent(value))); }
  catch { throw new Rejected(400); }
}
function metadata(value, maximum) {
  check(value && ['file', 'directory'].includes(value.kind) && ETAG.test(value.etag)
    && integer(value.size, 0, maximum) && (value.kind === 'file' || value.size === 0)
    && (value.lastModified === null || typeof value.lastModified === 'string'
      && Number.isFinite(Date.parse(value.lastModified))
      && new Date(value.lastModified).toUTCString() === value.lastModified), 503);
  return { kind: value.kind, etag: value.etag, size: value.size, lastModified: value.lastModified };
}

// A bounded grammar for PROPFIND requests, not a general-purpose XML parser.
// No DTDs, entities, text content, external resolution or arbitrary attributes.
// Supports namespace-qualified allprop, propname and explicit property lists;
// unknown requested properties receive their own 404 propstat.
function properties(body) {
  if (!body.length) return { mode: 'allprop', names: PROPERTIES.map(name => ['DAV:', name]) };
  let source = new TextDecoder('utf-8', { fatal: true }).decode(body).trim();
  source = source.replace(/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"utf-8"|'utf-8'|"UTF-8"|'UTF-8'))?\s*\?>/u, '').trim();
  check(!/[&!]/u.test(source));
  const stack = [];
  let root, cursor = 0, count = 0;
  const tags = /<([^<>]+)>/gu;
  for (const match of source.matchAll(tags)) {
    check(source.slice(cursor, match.index).trim() === '' && ++count <= 256);
    cursor = match.index + match[0].length;
    if (match[1].startsWith('/')) {
      check(stack.length > 0 && match[1].slice(1).trim() === stack.at(-1).qualified);
      stack.pop(); continue;
    }
    const token = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)([\s\S]*?)(\/?)$/u.exec(match[1]);
    check(token && stack.length < 3);
    const namespaces = { ...(stack.at(-1)?.namespaces ?? {}) };
    const attributes = token[2];
    let consumed = 0;
    const seen = new Set();
    for (const attr of attributes.matchAll(/\s+(xmlns(?::[A-Za-z_][\w.-]*)?)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gu)) {
      check(attr.index === consumed && !seen.has(attr[1]));
      consumed += attr[0].length;
      seen.add(attr[1]);
      namespaces[attr[1] === 'xmlns' ? '' : attr[1].slice(6)] = attr[2] ?? attr[3];
    }
    check(attributes.slice(consumed).trim() === '' && Object.keys(namespaces).length <= 16);
    const pieces = token[1].split(':');
    const prefix = pieces.length === 2 ? pieces[0] : '';
    check(prefix === '' || Object.hasOwn(namespaces, prefix));
    const node = { qualified: token[1], name: pieces.at(-1), ns: namespaces[prefix] ?? '', namespaces, children: [] };
    if (stack.length) stack.at(-1).children.push(node);
    else { check(!root); root = node; }
    if (!token[3]) stack.push(node);
  }
  check(cursor === source.length && stack.length === 0 && root?.name === 'propfind'
    && root.ns === 'DAV:' && root.children.length === 1);
  const select = root.children[0];
  check(select.ns === 'DAV:' && ['prop', 'allprop', 'propname'].includes(select.name));
  if (select.name === 'prop') {
    check(select.children.length > 0 && select.children.length <= 64
      && select.children.every(node => node.children.length === 0));
    return { mode: 'prop', names: select.children.map(node => [node.ns, node.name]) };
  }
  check(select.children.length === 0);
  return { mode: select.name, names: PROPERTIES.map(name => ['DAV:', name]) };
}
function responseXML(segments, entry, requested) {
  const href = PREFIX + segments.map(encodeURIComponent).join('/') + (entry.kind === 'directory' && segments.length ? '/' : '');
  const values = { displayname: xml(segments.at(-1) ?? ''),
    resourcetype: entry.kind === 'directory' ? '<d:collection/>' : '',
    getcontentlength: String(entry.size), getetag: xml(entry.etag),
    getlastmodified: entry.lastModified === null ? null : xml(entry.lastModified),
    getcontenttype: entry.kind === 'directory' ? 'httpd/unix-directory' : 'application/octet-stream' };
  const good = [], missing = [];
  for (const [ns, name] of requested.names) {
    const supported = ns === 'DAV:' && Object.hasOwn(values, name) && values[name] !== null;
    const qualified = ns ? `p:${name}` : name;
    const tag = ns ? `<${qualified} xmlns:p="${xml(ns)}"` : `<${qualified} xmlns=""`;
    (supported ? good : missing).push(supported && requested.mode !== 'propname'
      ? `${tag}>${values[name]}</${qualified}>` : `${tag}/>`);
  }
  const block = (items, status) => items.length
    ? `<d:propstat><d:prop>${items.join('')}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>` : '';
  return `<d:response><d:href>${xml(href)}</d:href>${block(good, '200 OK')}${block(missing, '404 Not Found')}</d:response>`;
}
function tags(value) {
  if (value === '*') return ['*'];
  check(typeof value === 'string' && value.length <= 4096);
  const list = [];
  let rest = value;
  while (rest.length) {
    const match = /^(W\/)?("[\x21\x23-\x7e]{0,512}")(?:\s*,\s*|$)/u.exec(rest);
    check(match && list.length < 16);
    list.push((match[1] ?? '') + match[2]);
    rest = rest.slice(match[0].length);
  }
  check(list.length > 0);
  return list;
}
function conditions(headers, entry, method) {
  if (headers['if-match'] !== undefined) {
    const match = tags(headers['if-match']);
    check(entry && (match.includes('*') || match.includes(entry.etag)), 412);
  }
  if (headers['if-none-match'] !== undefined) {
    const match = tags(headers['if-none-match']);
    if (entry && (match.includes('*') || match.some(tag => tag.replace(/^W\//u, '') === entry.etag))) {
      throw new Rejected(['GET', 'HEAD'].includes(method) ? 304 : 412);
    }
  }
}
function range(value, size, maximum) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  check(match && (match[1] || match[2]), 416);
  const left = match[1] ? Number(match[1]) : null;
  const right = match[2] ? Number(match[2]) : null;
  check((left === null || integer(left, 0, Number.MAX_SAFE_INTEGER))
    && (right === null || integer(right, 0, Number.MAX_SAFE_INTEGER)) && size > 0, 416);
  const start = left === null ? Math.max(0, size - right) : left;
  const end = left === null || right === null ? size - 1 : Math.min(right, size - 1);
  check(start <= end && start < size && end - start + 1 <= maximum, 416);
  return { start, end };
}
async function requestBody(req, method, signal) {
  const length = req.headers['content-length'];
  check(length === undefined || /^(0|[1-9][0-9]*)$/u.test(length));
  check(length === undefined || Number(length) <= (method === 'PROPFIND' ? BODY_MAX : 0), 413);
  check(req.headers['transfer-encoding'] === undefined
    || method === 'PROPFIND' && req.headers['transfer-encoding'] === 'chunked');
  const chunks = [];
  let size = 0;
  for await (const data of req) {
    signal.throwIfAborted();
    size += data.length;
    check(size <= (method === 'PROPFIND' ? BODY_MAX : 0), 413);
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

/** backend.open must honor AbortSignal and return a verified private file plus
 * idempotent dispose(). close() joins all pending requests and disposal work.
 * No socket, catalog access or restoration occurs merely by importing this module.
 */
export async function startPrivateDavServer({ backend, bearerToken, port = 0, allowedOrigins = [],
  maxConcurrent = 2, requestTimeoutMs = 120000, maxRangeBytes = 16 * 1024 ** 2,
  maxFileBytes = 8 * 1024 ** 3 } = {}) {
  check(backend && ['stat', 'list', 'open'].every(name => typeof backend[name] === 'function')
    && typeof bearerToken === 'string' && bearerToken.length <= 8192 && /^[A-Za-z0-9._~+/-]{32,8192}=*$/u.test(bearerToken)
    && integer(port, 0, 65535) && integer(maxConcurrent, 1, 32)
    && integer(requestTimeoutMs, 10, 3600000) && integer(maxRangeBytes, 1, 64 * 1024 ** 2)
    && integer(maxFileBytes, 1, 8 * 1024 ** 3) && Array.isArray(allowedOrigins) && allowedOrigins.length <= 16);
  const origins = new Set(allowedOrigins.map(value => {
    const url = new URL(value);
    check(['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password);
    return value;
  }));
  const secret = Buffer.from(`Bearer ${bearerToken}`);
  const tasks = new Set(), controllers = new Set();
  let origin, closing = false, cleanupFailure;
  const fail = (res, status) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Cache-Control': 'private, no-store',
      ...(status === 304 ? {} : { 'Content-Length': '0' }), Connection: 'close' });
    res.end();
  };
  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: Math.min(10000, requestTimeoutMs),
    requestTimeout: requestTimeoutMs, keepAliveTimeout: 1000 }, (req, res) => {
    const controller = new AbortController();
    let opened, file, timer;
    const task = (async () => {
      try {
        check(!closing && controllers.size < maxConcurrent, 503);
        check(req.rawHeaders.length <= 128);
        const seen = new Set();
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i].toLowerCase();
          if (SENSITIVE_HEADERS.has(name)) { check(!seen.has(name)); seen.add(name); }
        }
        check(req.headers.host === origin.slice('http://'.length), 403);
        const requestOrigin = req.headers.origin;
        check(requestOrigin === undefined || requestOrigin === origin || origins.has(requestOrigin), 403);
        if (requestOrigin !== undefined) {
          res.setHeader('Access-Control-Allow-Origin', requestOrigin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Range, Content-Length, Last-Modified');
        }
        const segments = pathSegments(req.url);
        if (req.method === 'OPTIONS' && requestOrigin && req.headers['access-control-request-method']) {
          check(['PROPFIND', 'HEAD', 'GET'].includes(req.headers['access-control-request-method']), 405);
          const names = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
          check(names.every(v => ['authorization', 'content-type', 'depth', 'range', 'if-match', 'if-none-match'].includes(v)), 403);
          check(!req.headers['transfer-encoding'] && !Number(req.headers['content-length'] ?? 0));
          res.writeHead(204, { 'Access-Control-Allow-Methods': ALLOW,
            'Access-Control-Allow-Headers': names.join(', '), 'Cache-Control': 'no-store' });
          res.end(); return;
        }
        const token = Buffer.from(req.headers.authorization ?? '');
        check(token.length === secret.length && timingSafeEqual(token, secret), 401);
        check(['OPTIONS', 'PROPFIND', 'HEAD', 'GET'].includes(req.method), 405);
        // Conditional forms outside this narrow read-only contract cannot
        // silently authorize a different version or force full materialization.
        check(req.headers['if-range'] === undefined && req.headers.if === undefined);
        controllers.add(controller);
        timer = setTimeout(() => { controller.abort(); fail(res, 504); }, requestTimeoutMs);
        req.once('aborted', () => controller.abort());
        res.once('close', () => { if (!res.writableFinished) controller.abort(); });
        const body = await requestBody(req, req.method, controller.signal);
        controller.signal.throwIfAborted();
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method === 'OPTIONS') { res.writeHead(204, { Allow: ALLOW, DAV: '1' }); res.end(); return; }
        const requested = req.method === 'PROPFIND' ? properties(body) : null;
        if (requested) check(['0', '1'].includes(req.headers.depth), 403);
        const raw = await backend.stat(segments, { signal: controller.signal });
        controller.signal.throwIfAborted();
        const entry = raw === null ? null : metadata(raw, maxFileBytes);
        if (entry) res.setHeader('ETag', entry.etag);
        conditions(req.headers, entry, req.method);
        check(entry, 404);
        if (requested) {
          check(req.headers.range === undefined);
          const entries = [[segments, entry]];
          if (req.headers.depth === '1' && entry.kind === 'directory') {
            const children = await backend.list(segments, { signal: controller.signal });
            controller.signal.throwIfAborted();
            check(Array.isArray(children) && children.length <= CHILDREN_MAX, 503);
            const names = new Set();
            for (const child of children) {
              const name = segment(child.name);
              check(!names.has(name), 503); names.add(name);
              entries.push([[...segments, name], metadata(child, maxFileBytes)]);
            }
          }
          const data = Buffer.from('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">'
            + entries.map(([path, value]) => responseXML(path, value, requested)).join('') + '</d:multistatus>');
          check(data.length <= 1024 ** 2, 503);
          res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': data.length });
          res.end(data); return;
        }
        check(entry.kind === 'file', 405);
        if (entry.lastModified !== null) res.setHeader('Last-Modified', entry.lastModified);
        res.setHeader('Accept-Ranges', 'bytes');
        let selected = null;
        if (req.method === 'GET' && req.headers.range !== undefined) {
          res.setHeader('Content-Range', `bytes */${entry.size}`);
          selected = range(req.headers.range, entry.size, maxRangeBytes);
          res.setHeader('Content-Range', `bytes ${selected.start}-${selected.end}/${entry.size}`);
        }
        const length = selected ? selected.end - selected.start + 1 : entry.size;
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': length, 'Content-Type': 'application/octet-stream' });
          res.end(); return;
        }
        opened = await backend.open(segments, { signal: controller.signal });
        check(opened && typeof opened.dispose === 'function', 503);
        controller.signal.throwIfAborted();
        check(opened.size === entry.size && opened.etag === entry.etag && typeof opened.path === 'string'
          && isAbsolute(opened.path) && normalize(opened.path) === opened.path
          && await realpath(opened.path) === opened.path, 503);
        file = await open(opened.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await file.stat();
        const named = await lstat(opened.path);
        check(info.isFile() && info.uid === process.getuid() && (info.mode & 0o7777) === 0o600
          && info.nlink === 1 && info.size === entry.size && !named.isSymbolicLink()
          && info.ino === named.ino && info.dev === named.dev, 503);
        controller.signal.throwIfAborted();
        res.writeHead(selected ? 206 : 200, { 'Content-Length': length, 'Content-Type': 'application/octet-stream' });
        if (length === 0) res.end();
        else await pipeline(file.createReadStream({ autoClose: false, ...selected }), res, { signal: controller.signal });
      } catch (error) {
        fail(res, error instanceof Rejected ? error.status : controller.signal.aborted ? 504 : 503);
      } finally {
        clearTimeout(timer);
        try { await file?.close(); } finally {
          try { if (typeof opened?.dispose === 'function') await opened.dispose(); }
          finally { controllers.delete(controller); }
        }
      }
    })();
    tasks.add(task);
    // A disposal failure shuts the listener rather than claiming all private
    // plaintext was removed; close() retains and propagates the failure.
    task.catch(() => { cleanupFailure = true; closing = true; server.close(); }).finally(() => tasks.delete(task));
  });
  // Inspect all headers inside the 16KiB parser bound; do not silently truncate
  // late duplicate authority headers before our explicit 64-header rejection.
  server.maxHeadersCount = 0;
  server.maxConnections = maxConcurrent + 4;
  server.maxRequestsPerSocket = 32;
  server.on('checkContinue', (_req, res) => fail(res, 417));
  server.on('checkExpectation', (_req, res) => fail(res, 417));
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => { server.off('error', reject); resolve(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  let closed;
  return Object.freeze({ origin, baseURL: origin + PREFIX, close() {
    if (!closed) closed = (async () => {
      closing = true;
      const done = new Promise(resolve => server.close(resolve));
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await done;
      const completed = await Promise.allSettled([...tasks]);
      if (cleanupFailure || completed.some(item => item.status === 'rejected')) throw new Error('Private DAV cleanup failed');
    })();
    return closed;
  } });
}
