#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Explicit owner-only foreground DAV service. Importing this file starts nothing.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readPrivateJSON } from '../src/private-file.mjs';
import { openPrivateCatalog } from '../src/private-catalog.mjs';
import { startPrivateDavServer } from '../src/private-dav-server.mjs';
import { loadRecoveryWebAssets } from './recovery-web-assets.mjs';
import { openOwnerUploads } from '../src/owner-uploads.mjs';

export class CloudServeError extends Error {
  constructor(code) { super(code); this.name = 'CloudServeError'; this.code = code; }
}
const fail = () => { throw new CloudServeError('INVALID_PRIVATE_READ_CONFIGURATION'); };
const FIELDS = new Set(['version', 'catalog', 'workDirectory', 'bearerToken', 'port',
  'allowedOrigins', 'maxOpenBytes', 'maxConcurrent', 'requestTimeoutMs', 'maxRangeBytes', 'webDist', 'ownerUploads']);
const REQUIRED = ['version', 'catalog', 'workDirectory', 'bearerToken'];
function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

export function validateConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !FIELDS.has(key))
    || REQUIRED.some(key => !Object.hasOwn(value, key)) || value.version !== 1
    || !['catalog', 'workDirectory'].every(key => typeof value[key] === 'string'
      && value[key].startsWith('/') && !/[\x00-\x1f\x7f]/u.test(value[key]))
    || typeof value.bearerToken !== 'string'
    || !/^[A-Za-z0-9._~+/-]{32,8192}=*$/u.test(value.bearerToken)) fail();
  const allowedOrigins = value.allowedOrigins ?? [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 16) fail();
  for (const origin of allowedOrigins) {
    try {
      const parsed = new URL(origin);
      if (typeof origin !== 'string' || origin !== parsed.origin || parsed.username || parsed.password
        || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:'
          && ['127.0.0.1', '[::1]'].includes(parsed.hostname)))) fail();
    } catch { fail(); }
  }
  if (new Set(allowedOrigins).size !== allowedOrigins.length) fail();
  if (value.webDist !== undefined && (typeof value.webDist !== 'string'
    || !value.webDist.startsWith('/') || /[\x00-\x1f\x7f]/u.test(value.webDist)
    || allowedOrigins.length > 0)) fail();
  if (value.ownerUploads !== undefined && (!value.ownerUploads || typeof value.ownerUploads !== 'object'
    || Object.keys(value.ownerUploads).sort().join(',') !== 'directory,space,storageConfig'
    || !['directory', 'storageConfig'].every(key => typeof value.ownerUploads[key] === 'string'
      && value.ownerUploads[key].startsWith('/') && !/[\x00-\x1f\x7f]/u.test(value.ownerUploads[key]))
    || typeof value.ownerUploads.space !== 'string' || !value.ownerUploads.space
    || ['.', '..'].includes(value.ownerUploads.space) || /[\\/\x00-\x1f\x7f]/u.test(value.ownerUploads.space)
    || Buffer.byteLength(value.ownerUploads.space) > 1024 || allowedOrigins.length)) fail();
  return Object.freeze({
    version: 1, catalog: value.catalog, workDirectory: value.workDirectory,
    bearerToken: value.bearerToken, allowedOrigins: Object.freeze([...allowedOrigins]),
    ...(value.webDist !== undefined ? { webDist: value.webDist } : {}),
    ...(value.ownerUploads !== undefined ? { ownerUploads: Object.freeze({ ...value.ownerUploads }) } : {}),
    port: integer(value.port ?? 0, 0, 65535),
    maxOpenBytes: integer(value.maxOpenBytes ?? 256 * 1024 ** 2, 1, 8 * 1024 ** 3),
    maxConcurrent: integer(value.maxConcurrent ?? 2, 1, 16),
    requestTimeoutMs: integer(value.requestTimeoutMs ?? (value.ownerUploads ? 1800000 : 120000), 100, 3600000),
    maxRangeBytes: integer(value.maxRangeBytes ?? 16 * 1024 ** 2, 1, 16 * 1024 ** 2),
  });
}

export function parseArguments(args) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: false,
    options: { config: { type: 'string' } }, tokens: true });
  if (positionals.length || typeof values.config !== 'string' || !values.config
    || args.filter(value => value === '--config' || value.startsWith('--config=')).length !== 1) fail();
  return values.config;
}

export async function startCloudService(value, {
  signal, openCatalog = openPrivateCatalog, startServer = startPrivateDavServer, openUploads = openOwnerUploads,
} = {}) {
  // The optional factories are module test seams, never executable configuration.
  const config = validateConfiguration(value);
  const cancel = new AbortController();
  const abort = () => cancel.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let backend;
  let server;
  let closing;
  const close = () => {
    if (!closing) closing = (async () => {
      cancel.abort();
      signal?.removeEventListener('abort', abort);
      try { await server?.close(); }
      finally { await backend?.close(); }
    })();
    return closing;
  };
  try {
    if (cancel.signal.aborted) throw new CloudServeError('CANCELLED');
    backend = await openCatalog({ catalog: config.catalog, workDirectory: config.workDirectory,
      maxOpenBytes: config.maxOpenBytes, maxOpenFiles: config.maxConcurrent }, { signal: cancel.signal });
    if (config.ownerUploads) backend = await openUploads({ ...config.ownerUploads, workDirectory: config.workDirectory,
      maxFileBytes: config.maxOpenBytes }, { base: backend, signal: cancel.signal });
    if (cancel.signal.aborted) throw new CloudServeError('CANCELLED');
    server = await startServer({ backend, bearerToken: config.bearerToken, port: config.port,
      allowedOrigins: config.allowedOrigins, maxConcurrent: config.maxConcurrent,
      requestTimeoutMs: config.requestTimeoutMs, maxRangeBytes: config.maxRangeBytes,
      maxFileBytes: config.maxOpenBytes,
      ...(config.webDist ? { recoveryWeb: {
        assetsFactory: origin => loadRecoveryWebAssets({ distDirectory: config.webDist, origin, ownerUploads: !!config.ownerUploads }),
      } } : {}),
    });
    if (cancel.signal.aborted) throw new CloudServeError('CANCELLED');
    return Object.freeze({ origin: server.origin, baseURL: server.baseURL, readOnly: !config.ownerUploads, close });
  } catch (error) { await close(); throw error; }
}

export async function run(args, { signal } = {}) {
  const path = parseArguments(args);
  const config = await readPrivateJSON(path);
  return startCloudService(config, { signal });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cancel = new AbortController();
  const onSignal = () => cancel.abort();
  for (const kind of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(kind, onSignal);
  let service;
  try {
    service = await run(process.argv.slice(2), { signal: cancel.signal });
    console.log(JSON.stringify({ version: 1, kind: 'volparossa-cloud-private-read',
      state: 'listening', origin: service.origin, readOnly: service.readOnly, loopbackOnly: true,
      originalServerFallback: false, openCloudAccountService: false }));
    await new Promise(resolve => {
      if (cancel.signal.aborted) resolve();
      else cancel.signal.addEventListener('abort', resolve, { once: true });
    });
  } catch {
    console.error(JSON.stringify({ success: false, code: 'PRIVATE_READ_SERVICE_FAILED' }));
    process.exitCode = 1;
  } finally {
    try {
      await service?.close();
      if (service) console.log(JSON.stringify({ version: 1, kind: 'volparossa-cloud-private-read', state: 'closed' }));
    } catch {
      console.error(JSON.stringify({ success: false, code: 'PRIVATE_READ_CLEANUP_UNCONFIRMED' }));
      process.exitCode = 1;
    }
    for (const kind of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(kind, onSignal);
  }
}
