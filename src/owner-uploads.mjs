// SPDX-License-Identifier: GPL-3.0-only
// Explicit owner-only new files; existing recovery catalogs never become writable.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreStorage } from '../vendor/volparossa-image/core-storage.mjs';
import { readPrivateJSON, sealOwnerUpload } from './private-file.mjs';
import { openPrivateCatalog, sealPrivateCatalogEntries } from './private-catalog.mjs';
import { recoveryResourceId, recoverySpaceId } from './private-resource-id.mjs';

export class OwnerUploadError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
const check = (value, code, status) => { if (!value) throw new OwnerUploadError(code, status); };
const nameValid = value => typeof value === 'string' && Buffer.byteLength(value) > 0
  && Buffer.byteLength(value) <= 1024 && !['.', '..'].includes(value) && !/[\\/\x00-\x1f\x7f]/u.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = async path => { try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
async function privateDirectory(path) {
  const info = await lstat(path);
  check(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o7777) === 0o700
    && await realpath(path) === path, 'PRIVATE_UPLOAD_DIRECTORY_REQUIRED');
}
async function writeNew(path, value) {
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
}
async function syncDirectory(path) { const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
async function publishReady(directory, value) {
  const ready = join(directory, 'READY.json');
  const staged = join(directory, `.READY-${randomBytes(16).toString('hex')}.tmp`);
  // The exclusive owner-workspace lock covers this absent check and rename.
  // A crash while writing/fsyncing may leave only an ignored private stage,
  // never a partial final marker that prevents the whole workspace reopening.
  check(await absent(ready), 'UPLOAD_COMMIT_EXISTS');
  try {
    await writeNew(staged, value);
    await rename(staged, ready);
    await syncDirectory(directory);
  } finally { await rm(staged, { force: true }); }
}
function lockWorkspace(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-B', fileURLToPath(new URL('../scripts/upload_lock.py', import.meta.url)), directory],
      { shell: false, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'] });
    let ready = false, closed = false, resolveClosed;
    const ended = new Promise(resolve => { resolveClosed = resolve; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new OwnerUploadError('UPLOAD_LOCK_TIMEOUT')); }, 5000);
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new OwnerUploadError('UPLOAD_LOCK_FAILED')); });
    child.on('close', code => {
      closed = true; clearTimeout(timer); resolveClosed(code);
      if (!ready) reject(new OwnerUploadError('UPLOAD_WORKSPACE_BUSY', 409));
    });
    let bytes = '';
    child.stdout.on('data', part => {
      bytes += part.toString('ascii');
      if (bytes === 'LOCKED\n' && !ready) {
        ready = true; clearTimeout(timer);
        resolve({ active: () => !closed, close: async () => {
          child.stdin.end();
          const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
          try { check(await ended === 0, 'UPLOAD_LOCK_CLEANUP_FAILED'); } finally { clearTimeout(deadline); }
        } });
      } else if (bytes.length >= 7) { child.kill('SIGKILL'); reject(new OwnerUploadError('UPLOAD_LOCK_FAILED')); }
    });
  });
}

export async function openOwnerUploads({ directory, space, storageConfig, workDirectory,
  maxFileBytes = 256 * 1024 ** 2 }, { base, signal, storageFactory = path => CoreStorage.open(path) } = {}) {
  check(nameValid(space) && directory !== workDirectory && Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 && maxFileBytes <= 8 * 1024 ** 3,
    'INVALID_UPLOAD_CONFIGURATION');
  await privateDirectory(directory);
  await privateDirectory(workDirectory);
  check(await base.stat([space], { signal }) === null, 'UPLOAD_SPACE_COLLIDES');
  const template = await readPrivateJSON(storageConfig);
  check(template?.version === 1 && !Object.hasOwn(template, 'stateDirectory') && !Object.hasOwn(template, 'copies'),
    'INVALID_UPLOAD_STORAGE_TEMPLATE');
  const lock = await lockWorkspace(directory);
  const entries = new Map();
  let busy = false, closed = false, cleanupFailed = false, controller, closing, openBytes = 0;
  const pending = new Set();
  const active = requestSignal => { check(!closed && !cleanupFailed && lock.active(), 'UPLOAD_WORKSPACE_CLOSED'); signal?.throwIfAborted(); requestSignal?.throwIfAborted(); };
  const published = () => [...entries.values()].filter(entry => entry.ready);
  const rootStat = () => ({ kind: 'directory', size: 0, lastModified: null,
    etag: `"vp-upload-${hash(JSON.stringify(published().map(entry => [entry.name, entry.stat.etag]).sort()))}"` });
  async function loadEntry(id) {
    const root = join(directory, id);
    await privateDirectory(root);
    if (await absent(join(root, 'catalog'))) {
      check(await absent(join(root, 'READY.json')), 'INVALID_UPLOAD_COMMIT');
      return; // A pre-publication interrupted owner stage remains retained.
    }
    const backend = await openPrivateCatalog({ catalog: join(root, 'catalog'), workDirectory,
      maxOpenBytes: maxFileBytes }, { signal, storageFactory });
    try {
      const listed = await backend.list([space], { signal });
      check(listed.length === 1 && listed[0].kind === 'file' && nameValid(listed[0].name)
        && !entries.has(listed[0].name), 'INVALID_UPLOAD_CATALOG');
      const entry = { id, root, backend, name: listed[0].name, stat: listed[0], ready: false };
      const receipt = await readPrivateJSON(join(root, 'catalog/receipt.json'));
      entry.catalogHash = receipt.cipher_sha256;
      if (!await absent(join(root, 'READY.json'))) {
        const ready = await readPrivateJSON(join(root, 'READY.json'));
        check(Object.keys(ready).sort().join(',') === 'catalogSha256,version' && ready.version === 1
          && ready.catalogSha256 === entry.catalogHash, 'INVALID_UPLOAD_COMMIT');
        entry.ready = true;
      }
      entries.set(entry.name, entry);
      return entry;
    } catch (error) { await backend.close(); throw error; }
  }
  try {
    const names = await readdir(directory);
    check(names.length <= 257 && names.every(name => name === 'LOCK' || /^object-[0-9a-f]{32}$/u.test(name)), 'UPLOAD_WORKSPACE_BOUND');
    for (const name of names.filter(name => name !== 'LOCK').sort()) await loadEntry(name);
  } catch (error) { await Promise.allSettled([...entries.values()].map(entry => entry.backend.close())); await lock.close(); throw error; }

  async function upload(parts, body, { signal: requestSignal, length } = {}) {
    active(requestSignal);
    check(parts.length === 2 && parts[0] === space && nameValid(parts[1]), 'UPLOAD_TARGET_NOT_AUTHORIZED', 403);
    check(!entries.get(parts[1])?.ready, 'UPLOAD_ALREADY_EXISTS', 412);
    check(!busy, 'UPLOAD_BUSY', 409);
    check(length === undefined || Number.isSafeInteger(length) && length >= 0 && length <= maxFileBytes, 'UPLOAD_TOO_LARGE', 413);
    busy = true;
    controller = new AbortController();
    const cancel = () => controller.abort();
    requestSignal?.addEventListener('abort', cancel, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    let stage;
    try {
      stage = await mkdtemp(join(workDirectory, 'upload-body-'));
      const plain = join(stage, 'body');
      let size = 0;
      const digest = createHash('sha256');
      const plainFile = await open(plain, 'wx', 0o600);
      try {
        for await (const data of body) {
          active(requestSignal); controller.signal.throwIfAborted();
          size += data.length;
          check(size <= maxFileBytes, 'UPLOAD_TOO_LARGE', 413);
          digest.update(data); await plainFile.writeFile(data);
        }
        check(length === undefined || length === size, 'UPLOAD_LENGTH_MISMATCH', 400);
        await plainFile.sync();
      } finally { await plainFile.close(); }
      const sha256 = digest.digest('hex');
      let entry = entries.get(parts[1]);
      if (entry) {
        check(entry.stat.size === size && entry.stat.etag === `"vp-${sha256}"`, 'PENDING_UPLOAD_DIFFERS', 409);
      } else {
        check((await readdir(directory)).filter(name => name !== 'LOCK').length < 256, 'UPLOAD_WORKSPACE_BOUND', 507);
        const id = `object-${randomBytes(16).toString('hex')}`;
        const root = join(directory, id);
        await mkdir(root, { mode: 0o700 }); await syncDirectory(directory);
        const bundle = join(root, 'bundle');
        const config = join(root, 'core.json');
        const receipt = await sealOwnerUpload({ source: plain, space, name: parts[1], size, sha256, output: bundle }, { signal: controller.signal });
        // The read budget covers ciphertext, including its encrypted metadata.
        check(receipt.cipher_bytes <= maxFileBytes, 'UPLOAD_TOO_LARGE', 413);
        await writeNew(config, { ...template, stateDirectory: join(root, 'journal') });
        await sealPrivateCatalogEntries([{ segments: parts, bundle, config, size, sha256,
          cipherSha256: receipt.cipher_sha256, cipherBytes: receipt.cipher_bytes, lastModified: null }],
        join(root, 'catalog'), { signal: controller.signal });
        await syncDirectory(root);
        entry = await loadEntry(id);
      }
      active(requestSignal); controller.signal.throwIfAborted();
      const core = await storageFactory(join(entry.root, 'core.json'));
      const receipt = await readPrivateJSON(join(entry.root, 'bundle/receipt.json'));
      const input = join(entry.root, 'bundle/file.pgp');
      const planned = await absent(join(entry.root, 'journal'))
        ? await core.create({ input, sha256: receipt.cipher_sha256, alreadyEncrypted: true }, { signal: controller.signal })
        : await core.status({ signal: controller.signal });
      if (planned.local_process_joined !== true) cleanupFailed = true;
      check(planned.status === 'complete' && planned.local_process_joined === true, 'UPLOAD_PLAN_INCOMPLETE');
      const deposited = await core.deposit({ input, alreadyEncrypted: true }, { signal: controller.signal });
      if (deposited.local_process_joined !== true) cleanupFailed = true;
      check(deposited.status === 'complete' && deposited.local_process_joined === true
        && deposited.storage?.fully_redundant_from_retained_receipts === true, 'UPLOAD_STORAGE_INCOMPLETE');
      active(requestSignal); controller.signal.throwIfAborted();
      await publishReady(entry.root, { version: 1, catalogSha256: entry.catalogHash });
      entry.ready = true;
      return entry.stat;
    } finally {
      try { if (stage) await rm(stage, { recursive: true }); }
      catch (error) { cleanupFailed = true; throw error; }
      finally {
        requestSignal?.removeEventListener('abort', cancel);
        signal?.removeEventListener('abort', cancel);
        busy = false; controller = null;
      }
    }
  }
  const backend = {
    ownerUploadSpace: space,
    async canUpload(parts) { active(); return parts.length === 1 && parts[0] === space; },
    async stat(parts, options) {
      active(options?.signal);
      if (parts.length === 0) return { ...(await base.stat([], options)), etag: rootStat().etag };
      if (parts[0] !== space) return base.stat(parts, options);
      return parts.length === 1 ? rootStat() : parts.length === 2 && entries.get(parts[1])?.ready ? entries.get(parts[1]).stat : null;
    },
    async list(parts, options) {
      active(options?.signal);
      if (!parts.length) return [...await base.list([], options), { name: space, ...rootStat() }];
      if (parts[0] !== space) return base.list(parts, options);
      check(parts.length === 1, 'UPLOAD_NOT_DIRECTORY', 404);
      return published().map(entry => entry.stat).sort((a, b) => a.name.localeCompare(b.name));
    },
    async resolveResourceId(id, options) {
      active(options?.signal);
      if ([recoverySpaceId(space), recoveryResourceId([space])].includes(id)) return [space];
      for (const entry of published()) if (id === recoveryResourceId([space, entry.name])) return [space, entry.name];
      return base.resolveResourceId(id, options);
    },
    async open(parts, options) {
      active(options?.signal);
      const selected = parts[0] !== space ? base : entries.get(parts[1])?.ready && parts.length === 2
        ? entries.get(parts[1]).backend : null;
      check(selected, 'UPLOAD_NOT_FOUND', 404);
      const entry = await selected.stat(parts, options);
      check(entry?.kind === 'file', 'UPLOAD_NOT_FOUND', 404);
      const charge = await selected.materializationBytes(parts, options);
      check(Number.isSafeInteger(charge) && charge > 0 && openBytes + charge <= maxFileBytes, 'UPLOAD_READ_CAPACITY');
      openBytes += charge;
      let opened;
      try { opened = await selected.open(parts, options); }
      catch (error) { openBytes -= charge; throw error; }
      let disposing;
      return Object.freeze({ ...opened, dispose() {
        if (!disposing) disposing = (async () => {
          try { await opened.dispose(); }
          finally { openBytes -= charge; }
        })();
        return disposing;
      } });
    },
    put(parts, body, options) {
      const operation = upload(parts, body, options);
      pending.add(operation);
      operation.finally(() => pending.delete(operation)).catch(() => {});
      return operation;
    },
    close() {
      if (!closing) {
        closed = true; controller?.abort();
        closing = (async () => {
          await Promise.allSettled([...pending]);
          const results = await Promise.allSettled([base.close(), ...[...entries.values()].map(entry => entry.backend.close())]);
          await lock.close();
          check(!cleanupFailed && results.every(result => result.status === 'fulfilled'), 'UPLOAD_CLEANUP_FAILED');
        })();
      }
      return closing;
    },
  };
  return Object.freeze(backend);
}
