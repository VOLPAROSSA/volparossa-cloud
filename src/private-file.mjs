// SPDX-License-Identifier: GPL-3.0-only
// Owner-side file recovery, not an OpenCloud server or a second storage authority.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenCloudDav, OpenCloudDavError } from './opencloud-dav.mjs';
import { CoreStorage } from '../vendor/volparossa-image/core-storage.mjs';

const HELPER = fileURLToPath(new URL('../scripts/private_file.py', import.meta.url));
const MAX_BYTES = 8 * 1024 ** 3;
const RECEIPT_KEYS = ['version', 'kind', 'cipher_file', 'cipher_sha256', 'cipher_bytes', 'encryption', 'source_consistency'];
const HASH = /^[0-9a-f]{64}$/u;
export class PrivateFileError extends Error {
  constructor(code) { super(code); this.name = 'PrivateFileError'; this.code = code; }
}
function check(value, code) { if (!value) throw new PrivateFileError(code); }
function canonical(value) {
  check(typeof value === 'string' && isAbsolute(value) && normalize(value) === value
    && value !== sep && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value), 'INVALID_PATH');
  return value;
}
async function directory(value) {
  canonical(value);
  const info = await lstat(value);
  check(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o7777) === 0o700
    && await realpath(value) === value, 'PRIVATE_DIRECTORY_REQUIRED');
}
async function fresh(value) {
  canonical(value);
  await directory(dirname(value));
  try { await lstat(value); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new PrivateFileError('OUTPUT_EXISTS');
}
async function privateFile(value, maximum) {
  canonical(value);
  await directory(dirname(value));
  const handle = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    const entry = await lstat(value);
    check(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o7777) === 0o600
      && info.size <= maximum && !entry.isSymbolicLink() && entry.ino === info.ino && entry.dev === info.dev,
    'PRIVATE_FILE_REQUIRED');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function readPrivateJSON(value, maximum = 65536) {
  const handle = await privateFile(value, maximum);
  try {
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    check(bytesRead <= maximum, 'JSON_LIMIT');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } catch { throw new PrivateFileError('INVALID_PRIVATE_JSON'); }
  finally { await handle.close(); }
}
async function writePrivate(value, data) {
  const handle = await open(value, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
}
function receipt(value) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === RECEIPT_KEYS.length && RECEIPT_KEYS.every(key => Object.hasOwn(value, key))
    && ((value.version === 1 && value.source_consistency === 'strong-etag-conditional-ranges')
      || (value.version === 2 && value.source_consistency === 'owner-upload-snapshot'))
    && value.kind === 'volparossa-cloud-private-file' && value.cipher_file === 'file.pgp'
    && HASH.test(value.cipher_sha256) && Number.isSafeInteger(value.cipher_bytes)
    && value.cipher_bytes > 0 && value.cipher_bytes <= MAX_BYTES + 1024 ** 2
    && value.encryption === 'OpenPGP-AES256',
  'INVALID_RECEIPT');
  return Object.freeze(value);
}
async function loadReceipt(bundle) {
  await directory(bundle);
  return receipt(await readPrivateJSON(join(bundle, 'receipt.json'), 4096));
}
async function verifiedCipher(value, expected) {
  const handle = await privateFile(value, MAX_BYTES + 1024 ** 2);
  try {
    const before = await handle.stat({ bigint: true });
    check(before.size === BigInt(expected.cipher_bytes), 'CIPHER_IDENTITY_MISMATCH');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    check(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
      && hash.digest('hex') === expected.cipher_sha256, 'CIPHER_IDENTITY_MISMATCH');
  } finally { await handle.close(); }
}
function helper(args, signal) {
  check(!signal?.aborted, 'CANCELLED');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-B', HELPER, ...args], {
      shell: false, detached: true, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    let bytes = 0;
    let stopped = null;
    let escalation;
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      const kill = kind => { try { if (child.pid > 1) process.kill(-child.pid, kind); } catch {} };
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 15000);
    };
    const timeout = setTimeout(() => stop('CRYPTO_DEADLINE'), 3650000);
    const cancel = () => stop('CANCELLED');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) stop('CRYPTO_REPORT_LIMIT');
      else chunks.push(chunk);
    });
    child.on('error', () => { stopped = 'CRYPTO_UNAVAILABLE'; });
    child.on('close', (code, termination) => {
      clearTimeout(timeout); clearTimeout(escalation);
      signal?.removeEventListener('abort', cancel);
      if (stopped || code !== 0 || termination) { reject(new PrivateFileError(stopped ?? 'CRYPTO_FAILED')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new PrivateFileError('CRYPTO_REPORT_INVALID')); }
    });
  });
}

/** Explicit owner-authorized import. Temporary plaintext stays on this owner device only. */
export async function importPrivateFile({ source, resource, output }, { signal } = {}) {
  await fresh(output);
  // Only the established adapter selects transport; credentials never enter persisted metadata.
  const dav = createOpenCloudDav(source);
  const staging = await mkdtemp(join(dirname(output), 'import-'));
  try {
    check(!signal?.aborted, 'CANCELLED');
    const selected = await dav.stat(resource);
    const plain = join(staging, 'source.bin');
    const input = await open(plain, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let length = 0;
    try {
      for await (const chunk of dav.streamFile(selected)) {
        check(!signal?.aborted, 'CANCELLED');
        length += chunk.length;
        check(length <= selected.size, 'SOURCE_SIZE_CHANGED');
        await input.writeFile(chunk);
      }
      check(length === selected.size, 'SOURCE_SIZE_CHANGED');
      await input.sync();
    } finally { await input.close(); }
    const metadata = join(staging, 'source.json');
    await writePrivate(metadata, JSON.stringify(selected));
    const result = await helper(['encrypt', '--source', plain, '--metadata', metadata, '--output', output], signal);
    const stored = await loadReceipt(output);
    receipt(result);
    check(RECEIPT_KEYS.every(key => result[key] === stored[key]), 'CRYPTO_REPORT_INVALID');
    await verifiedCipher(join(output, 'file.pgp'), stored);
    return stored;
  } catch (error) {
    if (error instanceof PrivateFileError || error instanceof OpenCloudDavError) throw error;
    throw new PrivateFileError('IMPORT_FAILED');
  } finally {
    // Only the freshly owned staging directory; the remote original is never removed.
    await rm(staging, { recursive: true });
  }
}

/** Local recovery is explicit, never a silent fallback for failed peer restoration. */
export async function restorePrivateFile({ bundle, cipher, output }, { signal } = {}) {
  await fresh(output);
  const expected = await loadReceipt(bundle);
  await verifiedCipher(cipher, expected);
  const result = await helper(['decrypt', '--bundle', bundle, '--cipher', cipher, '--output', output], signal);
  check(result.version === 1 && result.kind === 'volparossa-cloud-private-restore' && result.restored === true
    && result.cipher_sha256 === expected.cipher_sha256 && result.openpgp_integrity_verified === true
    && result.manifest_verified === true, 'CRYPTO_REPORT_INVALID');
  return Object.freeze(result);
}

/** A newly received owner file, not a fabricated DAV import or upstream permission. */
export async function sealOwnerUpload({ source, space, name, size, sha256, output }, { signal } = {}) {
  await fresh(output);
  const stage = await mkdtemp(join(dirname(output), 'upload-metadata-'));
  try {
    const metadata = join(stage, 'metadata.json');
    await writePrivate(metadata, JSON.stringify({ kind: 'owner-upload', space, name, size, sha256, lastModified: null }));
    const result = receipt(await helper(['encrypt', '--source', source, '--metadata', metadata, '--output', output], signal));
    check(result.version === 2, 'INVALID_UPLOAD_RECEIPT');
    await verifiedCipher(join(output, 'file.pgp'), result);
    return result;
  } finally { await rm(stage, { recursive: true }); }
}

export async function storePrivateFile(operation, { config, bundle }, {
  signal, storageFactory = path => CoreStorage.open(path),
} = {}) {
  check(['create', 'deposit'].includes(operation), 'INVALID_STORAGE_OPERATION');
  const expected = await loadReceipt(bundle);
  const input = join(bundle, 'file.pgp');
  await verifiedCipher(input, expected);
  const storage = await storageFactory(config);
  const request = operation === 'create'
    ? { input, sha256: expected.cipher_sha256, alreadyEncrypted: true }
    : { input, alreadyEncrypted: true };
  // Incomplete remote work is returned unchanged. Never discard its core-owned journal or charges.
  return storage[operation](request, { signal });
}

export async function restoreStoredFile({ config, bundle, output }, {
  signal, storageFactory = path => CoreStorage.open(path),
} = {}) {
  await fresh(output);
  const expected = await loadReceipt(bundle);
  const staging = await mkdtemp(join(dirname(output), 'receive-'));
  try {
    const cipher = join(staging, 'file.pgp');
    const storage = await storageFactory(config);
    const fetched = await storage.restore({ output: cipher, sha256: expected.cipher_sha256 }, { signal });
    check(fetched.status === 'complete' && fetched.restore_verified === true && fetched.local_process_joined === true,
      'STORAGE_RESTORE_INCOMPLETE');
    const restored = await restorePrivateFile({ bundle, cipher, output }, { signal });
    return Object.freeze({ ...restored, storage: fetched });
  } finally { await rm(staging, { recursive: true }); }
}
