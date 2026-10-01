// SPDX-License-Identifier: GPL-3.0-only
// Synthetic backend for an actual original-Web8 browser/UI interoperability test.
// It proves UI/HTTP integration, not core peer storage, GPG or origin-off recovery.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { startPrivateDavServer } from '../src/private-dav-server.mjs';
import { loadRecoveryWebAssets } from './recovery-web-assets.mjs';
import { recoveryResourceId, recoverySpaceId } from '../src/private-resource-id.mjs';

const state = process.argv[2];
const dist = process.argv[3];
const token = process.env.VP_SYNTHETIC_TOKEN;
const files = new Map([
  ['Selected/notes.txt', Buffer.from('Synthetic VOLPAROSSA owner recovery through original OpenCloud Files.\n')],
  ['Selected/Folder/detail.txt', Buffer.from('Nested selected recovery file.\n')],
]);
const directory = { kind: 'directory', size: 0, etag: '"directory-v1"', lastModified: null };
const metadata = bytes => ({ kind: 'file', size: bytes.length,
  etag: '"' + createHash('sha256').update(bytes).digest('hex') + '"', lastModified: null });
let opened = 0;
let disposed = 0;
const backend = {
  async resolveResourceId(id) {
    if (id === recoverySpaceId('Selected')) return ['Selected'];
    return ['', 'Selected', 'Selected/Folder', ...files.keys()]
      .map(path => path ? path.split('/') : []).find(parts => recoveryResourceId(parts) === id) ?? null;
  },
  async stat(parts) {
    const path = parts.join('/');
    if (files.has(path)) return metadata(files.get(path));
    if (['', 'Selected', 'Selected/Folder'].includes(path)) return directory;
    return null;
  },
  async list(parts) {
    const path = parts.join('/');
    if (path === '') return [{ name: 'Selected', ...directory }];
    if (path === 'Selected') return [{ name: 'Folder', ...directory }, { name: 'notes.txt', ...metadata(files.get('Selected/notes.txt')) }];
    if (path === 'Selected/Folder') return [{ name: 'detail.txt', ...metadata(files.get('Selected/Folder/detail.txt')) }];
    throw new Error('Fixture selection absent');
  },
  async open(parts) {
    const bytes = files.get(parts.join('/'));
    if (!bytes) throw new Error('Fixture selection absent');
    const path = join(state, `restored-${++opened}`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    let removed = false;
    return { path, ...metadata(bytes), async dispose() {
      if (!removed) { await unlink(path); removed = true; disposed++; }
    } };
  },
};
await mkdir(state, { recursive: true, mode: 0o700 });
const service = await startPrivateDavServer({ backend, bearerToken: token, maxConcurrent: 4,
  recoveryWeb: { assetsFactory: origin => loadRecoveryWebAssets({ distDirectory: dist, origin }) } });
console.log(JSON.stringify({ origin: service.origin }));
await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
await service.close();
console.log(JSON.stringify({ closed: true, opened, disposed, private_cleanup: opened === disposed,
  synthetic_backend: true, peer_storage_proven: false }));
