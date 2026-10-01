// SPDX-License-Identifier: GPL-3.0-only
// Verify the complete explicitly staged published SDK before importing it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PIN_PATH = join(ROOT, 'third_party/opencloud-web-sdk.json');

export async function checkedSDK(directory) {
  assert.equal(await realpath(directory), directory);
  const pins = await readFile(PIN_PATH);
  const pin = JSON.parse(pins);
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.kind, 'opencloud-web-sdk-trial');
  assert.equal(receipt.archive_sha256, '8954d9ad90e44a6f62d0e32d3280ca92fd7b0ce30042fe07cdde5c653e0739b3');
  assert.equal(receipt.pins_sha256, createHash('sha256').update(pins).digest('hex'));
  assert.equal(Object.keys(receipt.files).length, pin.files);
  for (const [name, expected] of Object.entries(receipt.files)) {
    assert.match(name, /^package\//u);
    assert.ok(!name.split('/').some(part => part === '.' || part === '..'));
    const path = join(directory, name);
    assert.equal(await realpath(path), path);
    assert.equal((await lstat(path)).isFile(), true);
    const bytes = await readFile(path);
    assert.equal(bytes.length, expected.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
  }
  return import(pathToFileURL(join(directory, 'package/dist/web-client/webdav.js')).href);
}
