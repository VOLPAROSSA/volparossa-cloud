// SPDX-License-Identifier: GPL-3.0-only
// Small asset-contract tests; synthetic build receipts are not source/UI proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRecoveryWebAssets } from '../scripts/recovery-web-assets.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'volparossa-web-assets-'));
  const pinBytes = await readFile(new URL('../third_party/opencloud-web-ui.json', import.meta.url));
  const pins = JSON.parse(pinBytes);
  const patch = await readFile(new URL('../' + pins.patch, import.meta.url));
  const files = {};
  for (const [name, body] of [['index.html', '<p>Synthetic asset-validator fixture</p>'],
    ['UPSTREAM_LICENSE', 'Synthetic fixture only']]) {
    const data = Buffer.from(body);
    await writeFile(join(directory, name), data);
    files[name] = { bytes: data.length, sha256: sha(data) };
  }
  const report = { version: 1, kind: 'opencloud-web-owner-recovery-build', source_revision: pins.revision,
    source_tree: pins.tree, pins_sha256: sha(pinBytes), patch_sha256: sha(patch),
    lock_sha256: pins.lock_sha256, node: '24.19.0', pnpm: '11.27.0', lifecycle_scripts: false,
    build_network: false, global_installation: false, files };
  await writeFile(join(directory, 'BUILD_REPORT.json'), JSON.stringify(report));
  return { directory, report, async close() { await rm(directory, { recursive: true }); } };
}

test('only verified assets and public recovery configuration enter map', async () => {
  const f = await fixture();
  try {
    const assets = await loadRecoveryWebAssets({ distDirectory: f.directory, origin: 'http://127.0.0.1:45678' });
    assert.equal(assets.get('/'), assets.get('/index.html'));
    assert.equal([...assets.keys()].some(path => /\/(dav|graph|volparossa|ocs)\//u.test(path)), false);
    const config = JSON.parse(assets.get('/config.json').data);
    assert.deepEqual(config.apps, ['files']);
    assert.equal(config.options.volparossaOwnerRecovery, true);
    assert.equal(config.options.tokenStorageLocal, false);
    assert.equal(JSON.stringify(config).includes('bearer'), false);
    assert.deepEqual(config.external_apps, []);
    await assert.rejects(loadRecoveryWebAssets({ distDirectory: f.directory, origin: 'https://outside.example' }));
  } finally { await f.close(); }
});

test('changed assets and mismatched build evidence are refused', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'index.html'), '<script>changed</script>');
    await assert.rejects(loadRecoveryWebAssets({ distDirectory: f.directory, origin: 'http://127.0.0.1:45678' }));
    f.report.build_network = true;
    await writeFile(join(f.directory, 'BUILD_REPORT.json'), JSON.stringify(f.report));
    await assert.rejects(loadRecoveryWebAssets({ distDirectory: f.directory, origin: 'http://127.0.0.1:45678' }));
  } finally { await f.close(); }
});
