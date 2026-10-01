// SPDX-License-Identifier: GPL-3.0-only
// Immutable owner selection; not an OpenCloud account or shared-access authority.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open as openFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateJSON, restoreStoredFile } from './private-file.mjs';
import { isRecoveryResourceId, isRecoverySpaceId, recoveryResourceId, recoverySpaceId } from './private-resource-id.mjs';

const HELPER = fileURLToPath(new URL('../scripts/private_catalog.py', import.meta.url));
const MAX_INDEX = 2 * 1024 ** 2;
const MAX_FILE = 8 * 1024 ** 3;
const MAX_CIPHER = MAX_FILE + 1024 ** 2;
const DEFAULT_BUDGET = 256 * 1024 ** 2;
const HASH = /^[a-f0-9]{64}$/u;
const ENTRY_KEYS = ['segments', 'bundle', 'config', 'size', 'sha256', 'cipherSha256', 'cipherBytes', 'lastModified'];

export class PrivateCatalogError extends Error {
  constructor(code) { super(code); this.name = 'PrivateCatalogError'; this.code = code; }
}
function check(value, code = 'INVALID_CATALOG') { if (!value) throw new PrivateCatalogError(code); }
function object(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function integer(value, low, high) { return Number.isSafeInteger(value) && value >= low && value <= high; }
function active(signal) { check(!signal?.aborted, 'CANCELLED'); }
function absolute(value) {
  check(typeof value === 'string' && isAbsolute(value) && value !== sep && normalize(value) === value
    && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value), 'INVALID_PRIVATE_PATH');
  return value;
}
async function directory(value) {
  absolute(value);
  const info = await lstat(value);
  check(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o7777) === 0o700
    && await realpath(value) === value, 'PRIVATE_DIRECTORY_REQUIRED');
  return info;
}
async function fresh(value) {
  absolute(value);
  await directory(dirname(value));
  try { await lstat(value); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new PrivateCatalogError('OUTPUT_EXISTS');
}
function segments(value, file = false) {
  check(Array.isArray(value) && value.length >= (file ? 2 : 0) && value.length <= 32, 'INVALID_CATALOG_PATH');
  for (const item of value) {
    check(typeof item === 'string' && Buffer.byteLength(item, 'utf8') >= 1 && Buffer.byteLength(item, 'utf8') <= 1024
      && !['.', '..'].includes(item) && !/[\\/\x00-\x1f\x7f]/u.test(item), 'INVALID_CATALOG_PATH');
    try { encodeURIComponent(item); } catch { throw new PrivateCatalogError('INVALID_CATALOG_PATH'); }
  }
  check(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 8192, 'INVALID_CATALOG_PATH');
  return Object.freeze([...value]);
}
const pathKey = parts => JSON.stringify(parts);
const digest = value => createHash('sha256').update(value).digest('hex');
function modified(value) {
  if (value === null) return null;
  check(typeof value === 'string', 'INVALID_SOURCE_METADATA');
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toUTCString() : null;
}
function validateSelection(selection) {
  check(Array.isArray(selection) && selection.length >= 1 && selection.length <= 256, 'INVALID_SELECTION');
  const selected = selection.map(value => {
    check(object(value, ['segments', 'bundle', 'config']), 'INVALID_SELECTION');
    return { segments: segments(value.segments, true), bundle: absolute(value.bundle), config: absolute(value.config) };
  });
  const names = new Set(selected.map(entry => pathKey(entry.segments)));
  check(names.size === selected.length, 'DUPLICATE_SELECTION');
  for (const entry of selected) {
    for (let depth = 1; depth < entry.segments.length; depth++) {
      check(!names.has(pathKey(entry.segments.slice(0, depth))), 'FILE_DIRECTORY_CONFLICT');
    }
  }
  return selected;
}
async function fileReceipt(bundle) {
  await directory(bundle);
  const value = await readPrivateJSON(join(bundle, 'receipt.json'), 4096);
  check(object(value, ['version', 'kind', 'cipher_file', 'cipher_sha256', 'cipher_bytes', 'encryption', 'source_consistency'])
    && value.version === 1 && value.kind === 'volparossa-cloud-private-file' && value.cipher_file === 'file.pgp'
    && HASH.test(value.cipher_sha256) && integer(value.cipher_bytes, 1, MAX_CIPHER)
    && value.encryption === 'OpenPGP-AES256' && value.source_consistency === 'strong-etag-conditional-ranges',
  'INVALID_FILE_RECEIPT');
  return value;
}
async function verifiedPlain(path, expectedSize, expectedSha, signal) {
  await directory(dirname(path));
  const handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    check(before.isFile() && before.uid === BigInt(process.getuid()) && before.nlink === 1n
      && (before.mode & 0o7777n) === 0o600n && before.size === BigInt(expectedSize), 'RESTORED_FILE_INVALID');
    const hash = createHash('sha256');
    for await (const part of handle.createReadStream({ autoClose: false })) {
      active(signal);
      hash.update(part);
    }
    const after = await handle.stat({ bigint: true });
    check(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
      && hash.digest('hex') === expectedSha, 'RESTORED_FILE_INVALID');
  } finally { await handle.close(); }
}
async function ownerStage(workDirectory) {
  await directory(workDirectory);
  const path = await mkdtemp(join(workDirectory, 'catalog-read-'));
  const original = await directory(path);
  let removed = false;
  return {
    path,
    async dispose() {
      if (removed) return;
      const current = await directory(path);
      check(current.dev === original.dev && current.ino === original.ino, 'PRIVATE_STAGE_CHANGED');
      await rm(path, { recursive: true });
      removed = true;
    },
  };
}
function crypto(operation, args, body, signal) {
  active(signal);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-B', HELPER, operation, ...args], {
      shell: false, detached: true, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stopped;
    let escalation;
    let length = 0;
    const chunks = [];
    const stop = code => {
      if (stopped) return;
      stopped = code;
      const kill = kind => { try { if (child.pid > 1) process.kill(-child.pid, kind); } catch {} };
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 15000);
    };
    const timeout = setTimeout(() => stop('CATALOG_CRYPTO_TIMEOUT'), 120000);
    const cancel = () => stop('CANCELLED');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_INDEX + 1) stop('CATALOG_LIMIT');
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {}); // Failure remains a closed process result.
    child.on('error', () => { stopped = 'CATALOG_CRYPTO_UNAVAILABLE'; });
    child.on('close', (code, termination) => {
      clearTimeout(timeout); clearTimeout(escalation);
      signal?.removeEventListener('abort', cancel);
      if (stopped || code !== 0 || termination) { reject(new PrivateCatalogError(stopped ?? 'CATALOG_CRYPTO_FAILED')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new PrivateCatalogError('INVALID_CATALOG_CRYPTO_REPORT')); }
    });
    child.stdin.end(body);
  });
}

async function materialize(selection, workDirectory, expected, { signal, storageFactory, plannedReceipt } = {}) {
  active(signal);
  const receipt = await fileReceipt(selection.bundle);
  if (plannedReceipt) check(receipt.cipher_sha256 === plannedReceipt.cipher_sha256
    && receipt.cipher_bytes === plannedReceipt.cipher_bytes, 'FILE_VERSION_CHANGED');
  if (expected) check(receipt.cipher_sha256 === expected.cipherSha256 && receipt.cipher_bytes === expected.cipherBytes,
    'FILE_VERSION_CHANGED');
  const stage = await ownerStage(workDirectory);
  try {
    const output = join(stage.path, 'file');
    const result = await restoreStoredFile({ config: selection.config, bundle: selection.bundle, output },
      { signal, ...(storageFactory ? { storageFactory } : {}) });
    check(result.restored === true && result.openpgp_integrity_verified === true && result.manifest_verified === true
      && result.cipher_sha256 === receipt.cipher_sha256 && integer(result.bytes, 0, MAX_FILE), 'RESTORE_INCOMPLETE');
    const metadata = await readPrivateJSON(join(output, 'metadata.json'));
    check(object(metadata, ['version', 'kind', 'source', 'content_sha256', 'content_bytes'])
      && metadata.version === 1 && metadata.kind === 'volparossa-cloud-file-content'
      && metadata.content_bytes === result.bytes && HASH.test(metadata.content_sha256), 'INVALID_SOURCE_METADATA');
    const source = metadata.source;
    check(object(source, ['url', 'etag', 'size', 'lastModified']) && source.size === result.bytes,
      'INVALID_SOURCE_METADATA');
    const sourceURL = new URL(source.url);
    check(!sourceURL.username && !sourceURL.password && !sourceURL.search && !sourceURL.hash
      && sourceURL.pathname.startsWith('/dav/spaces/'), 'INVALID_SOURCE_METADATA');
    const sourceSegments = sourceURL.pathname.slice('/dav/spaces/'.length).split('/').map(decodeURIComponent);
    check(pathKey(segments(sourceSegments, true)) === pathKey(selection.segments), 'SOURCE_SELECTION_MISMATCH');
    const entry = { ...selection, size: result.bytes, sha256: metadata.content_sha256,
      cipherSha256: receipt.cipher_sha256, cipherBytes: receipt.cipher_bytes, lastModified: modified(source.lastModified) };
    if (expected) check(ENTRY_KEYS.every(key => key === 'segments'
      ? pathKey(entry.segments) === pathKey(expected.segments) : entry[key] === expected[key]), 'FILE_VERSION_CHANGED');
    const path = join(output, 'content.bin');
    await verifiedPlain(path, entry.size, entry.sha256, signal);
    active(signal);
    return { entry, path, dispose: () => stage.dispose() };
  } catch (error) {
    try { await stage.dispose(); }
    catch { throw new PrivateCatalogError('PRIVATE_CLEANUP_FAILED'); }
    if (error instanceof PrivateCatalogError) throw error;
    throw new PrivateCatalogError(signal?.aborted ? 'CANCELLED' : 'MATERIALIZATION_FAILED');
  }
}

/** A code-only storageFactory seam exists for tests; no configuration selects it. */
export async function createPrivateCatalog({ selection, output, workDirectory, maxTotalBytes = DEFAULT_BUDGET }, options = {}) {
  active(options.signal);
  const selected = validateSelection(selection);
  check(integer(maxTotalBytes, 1, MAX_CIPHER), 'INVALID_BYTE_BUDGET');
  await fresh(output);
  await directory(workDirectory);
  // Plan the complete bounded selection before any network transfer.
  const receipts = await Promise.all(selected.map(entry => fileReceipt(entry.bundle)));
  const downloadBytes = receipts.reduce((total, value) => total + value.cipher_bytes, 0);
  check(downloadBytes <= maxTotalBytes, 'CATALOG_BYTE_BUDGET');
  const entries = [];
  for (let index = 0; index < selected.length; index++) {
    const file = await materialize(selected[index], workDirectory, null,
      { ...options, plannedReceipt: receipts[index] });
    try {
      check(file.entry.cipherSha256 === receipts[index].cipher_sha256
        && file.entry.cipherBytes === receipts[index].cipher_bytes, 'FILE_VERSION_CHANGED');
      entries.push(file.entry);
    } finally { await file.dispose(); }
  }
  entries.sort((a, b) => pathKey(a.segments) < pathKey(b.segments) ? -1 : 1);
  const encoded = Buffer.from(JSON.stringify({ version: 1, kind: 'volparossa-cloud-private-catalog-index', entries }));
  check(encoded.length <= MAX_INDEX, 'CATALOG_LIMIT');
  const report = await crypto('seal', ['--output', output], encoded, options.signal);
  check(report.version === 1 && report.kind === 'volparossa-cloud-private-catalog'
    && report.encryption === 'OpenPGP-AES256' && HASH.test(report.cipher_sha256), 'INVALID_CATALOG_CRYPTO_REPORT');
  return Object.freeze({ version: 1, kind: 'volparossa-cloud-private-catalog-created', files: entries.length,
    plaintextBytes: entries.reduce((sum, entry) => sum + entry.size, 0), selectedCiphertextBytes: downloadBytes,
    encrypted: true, ownerOnly: true, sourceFallback: false, secondDeviceRecoveryProven: false });
}

function validateIndex(value) {
  check(object(value, ['version', 'kind', 'entries']) && value.version === 1
    && value.kind === 'volparossa-cloud-private-catalog-index' && Array.isArray(value.entries)
    && value.entries.every(entry => object(entry, ENTRY_KEYS)), 'INVALID_CATALOG');
  validateSelection(value.entries.map(({ segments: parts, bundle, config }) => ({ segments: parts, bundle, config })));
  return value.entries.map(entry => {
    check(integer(entry.size, 0, MAX_FILE) && integer(entry.cipherBytes, 1, MAX_CIPHER)
      && entry.size < entry.cipherBytes && HASH.test(entry.sha256) && HASH.test(entry.cipherSha256)
      && (entry.lastModified === null || modified(entry.lastModified) === entry.lastModified), 'INVALID_CATALOG');
    return Object.freeze({ ...entry, segments: segments(entry.segments, true) });
  });
}
function indexTree(entries) {
  const nodes = new Map([[pathKey([]), { kind: 'directory', children: new Map() }]]);
  for (const entry of entries) {
    for (let depth = 0; depth < entry.segments.length; depth++) {
      const parent = nodes.get(pathKey(entry.segments.slice(0, depth)));
      const childKey = pathKey(entry.segments.slice(0, depth + 1));
      if (!nodes.has(childKey)) nodes.set(childKey, depth === entry.segments.length - 1
        ? { kind: 'file', entry } : { kind: 'directory', children: new Map() });
      parent.children.set(entry.segments[depth], childKey);
    }
  }
  function complete(key) {
    const node = nodes.get(key);
    if (node.kind === 'file') node.stat = Object.freeze({ kind: 'file', size: node.entry.size,
      etag: `"vp-${node.entry.sha256}"`, lastModified: node.entry.lastModified });
    else {
      const children = [...node.children.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      for (const [, childKey] of children) complete(childKey);
      node.stat = Object.freeze({ kind: 'directory', size: 0, lastModified: null,
        etag: `"vp-dir-${digest(JSON.stringify(children.map(([name, childKey]) => [name, nodes.get(childKey).stat])))}"` });
      node.list = Object.freeze(children.map(([name, childKey]) => Object.freeze({ name, ...nodes.get(childKey).stat })));
    }
  }
  complete(pathKey([]));
  return nodes;
}

export async function openPrivateCatalog({ catalog, workDirectory, maxOpenBytes = DEFAULT_BUDGET, maxOpenFiles = 2 }, options = {}) {
  active(options.signal);
  check(integer(maxOpenBytes, 1, MAX_CIPHER), 'INVALID_BYTE_BUDGET');
  check(integer(maxOpenFiles, 1, 16), 'INVALID_FILE_BUDGET');
  await directory(catalog);
  await directory(workDirectory);
  const entries = validateIndex(await crypto('decrypt', ['--catalog', catalog], undefined, options.signal));
  active(options.signal);
  const nodes = indexTree(entries);
  const resources = new Map([...nodes.keys()].map(key => [recoveryResourceId(JSON.parse(key)), key]));
  for (const key of nodes.keys()) {
    const parts = JSON.parse(key);
    if (parts.length === 1) resources.set(recoverySpaceId(parts[0]), key);
  }
  const leases = new Set();
  let charged = 0;
  let closed = false;
  let closing;
  let cleanupFailed = false;
  function lookup(parts, signal) {
    check(!closed, 'CATALOG_CLOSED');
    active(options.signal);
    active(signal);
    return nodes.get(pathKey(segments(parts))) ?? null;
  }
  const backend = {
    async resolveResourceId(id, { signal } = {}) {
      check(!closed, 'CATALOG_CLOSED');
      active(options.signal); active(signal);
      check(isRecoveryResourceId(id) || isRecoverySpaceId(id), 'INVALID_CATALOG_RESOURCE_ID');
      const key = resources.get(id);
      return key === undefined ? null : Object.freeze(JSON.parse(key));
    },
    async stat(parts, { signal } = {}) { return lookup(parts, signal)?.stat ?? null; },
    async list(parts, { signal } = {}) {
      const node = lookup(parts, signal);
      check(node?.kind === 'directory', node ? 'NOT_A_DIRECTORY' : 'NOT_FOUND');
      return node.list;
    },
    async open(parts, { signal } = {}) {
      const node = lookup(parts, signal);
      check(node?.kind === 'file', node ? 'NOT_A_FILE' : 'NOT_FOUND');
      const amount = node.entry.cipherBytes;
      check(leases.size < maxOpenFiles && charged + amount <= maxOpenBytes, 'MATERIALIZATION_CAPACITY');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const lease = { controller };
      leases.add(lease);
      charged += amount;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', cancel);
        leases.delete(lease);
        charged -= amount;
      };
      lease.done = materialize(node.entry, workDirectory, node.entry,
        { ...options, signal: controller.signal }).then(file => {
        let disposal;
        lease.dispose = () => {
          if (!disposal) disposal = file.dispose().then(release).catch(() => {
            cleanupFailed = true;
            throw new PrivateCatalogError('PRIVATE_CLEANUP_FAILED');
          });
          return disposal;
        };
        return file;
      }).catch(error => {
        if (error.code === 'PRIVATE_CLEANUP_FAILED') cleanupFailed = true;
        release();
        throw error;
      });
      try {
        const file = await lease.done;
        if (closed || controller.signal.aborted) {
          await lease.dispose();
          throw new PrivateCatalogError('CANCELLED');
        }
        return Object.freeze({ path: file.path, size: node.stat.size, etag: node.stat.etag, dispose: lease.dispose });
      } catch (error) { throw error; }
    },
    close() {
      if (closing) return closing;
      closed = true;
      options.signal?.removeEventListener('abort', ownerCancelled);
      const retained = [...leases];
      for (const lease of retained) lease.controller.abort();
      closing = (async () => {
        await Promise.allSettled(retained.map(lease => lease.done));
        const results = await Promise.allSettled(retained.map(lease => lease.dispose?.()));
        check(!cleanupFailed && results.every(result => result.status === 'fulfilled'), 'PRIVATE_CLEANUP_FAILED');
      })();
      return closing;
    },
  };
  function ownerCancelled() {
    // The owner's lifetime covers metadata, pending restores and held plaintext.
    // close() retains its failure for the caller; do not create an unhandled
    // rejection in this event listener while the service is shutting down.
    backend.close().catch(() => {});
  }
  options.signal?.addEventListener('abort', ownerCancelled, { once: true });
  if (options.signal?.aborted) ownerCancelled();
  return Object.freeze(backend);
}
