// SPDX-License-Identifier: GPL-3.0-only
// Verify the complete explicitly staged published SDK before importing it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PIN_PATH = join(ROOT, 'third_party/opencloud-web-sdk.json');

async function readSDKFile(path, expected) {
  assert.equal(await realpath(path), path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && expected.bytes <= 32 * 1024 ** 2 && info.size === expected.bytes);
    const bytes = Buffer.alloc(info.size + 1); let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    assert.ok(size === info.size && ['size', 'mtimeMs', 'mode', 'uid', 'gid'].every(key => info[key] === after[key]));
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

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
    const bytes = await readSDKFile(path, expected);
    assert.equal(bytes.length, expected.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
  }
  return import(pathToFileURL(join(directory, 'package/dist/web-client/webdav.js')).href);
}
