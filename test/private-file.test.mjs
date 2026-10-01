// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { importPrivateFile, restorePrivateFile, restoreStoredFile, storePrivateFile } from '../src/private-file.mjs';
import { parseArguments, run } from '../scripts/cloud-file.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESOURCE = { spaceId: 'synthetic-owner-space', pathSegments: ['private-name.txt'] };
const TOKEN = 'synthetic-private-owner-token';
const DATA = Buffer.from('OWNER PRIVATE CONTENT MUST NOT BECOME PUBLIC\n'.repeat(4096));

async function workspace(t) {
  await mkdir(join(ROOT, 'build'), { mode: 0o700, recursive: true });
  const directory = await mkdtemp(join(ROOT, 'build', 'private-file-test-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function source(t, data = DATA, change = false) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization, match: req.headers['if-match'] });
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.setHeader('ETag', '"fixture-version-1"');
    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', data.length);
      res.end();
      return;
    }
    assert.equal(req.headers['if-match'], '"fixture-version-1"');
    if (change && requests.length > 2) { res.writeHead(412); res.end(); return; }
    const [, first, last] = /^bytes=(\d+)-(\d+)$/u.exec(req.headers.range);
    const body = data.subarray(Number(first), Number(last) + 1);
    res.writeHead(206, { 'Content-Range': `bytes ${first}-${last}/${data.length}`, 'Content-Length': body.length });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  };
  t.after(stop);
  return {
    config: { origin: `http://127.0.0.1:${server.address().port}`, bearerToken: TOKEN,
      allowInsecureLoopbackForTests: true, maxRequestBytes: 16384 },
    requests, stop,
  };
}

async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
async function noStaging(directory) {
  assert.deepEqual((await readdir(directory)).filter(name => /^(import-|receive-|f-|r-|g-)/u.test(name)), []);
}

test('exact reused Image source and license agree with their immutable provenance', async () => {
  const pin = JSON.parse(await readFile(join(ROOT, 'third_party/volparossa-image-source.json')));
  assert.equal(pin.revision, '9e925bdb1bde4d7686868e7aa826fd8144aca91e');
  assert.equal(pin.local_modifications, false);
  for (const record of Object.values(pin.files)) {
    const bytes = await readFile(join(ROOT, record.local));
    assert.equal(bytes.length, record.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
  }
});

test('CLI keeps explicit owner operations and rejects independent replica settings', () => {
  assert.deepEqual(parseArguments(['restore-local', '--bundle', '/private/b', '--cipher', '/private/b/file.pgp',
    '--output', '/private/output']), {
    operation: 'restore-local', bundle: '/private/b', cipher: '/private/b/file.pgp', output: '/private/output',
  });
  assert.throws(() => parseArguments(['create', '--config', '/private/c', '--bundle', '/private/b', '--copies', '3']));
  assert.throws(() => parseArguments(['restore', '--bundle', '/private/b', '--output', '/private/output']));
  assert.throws(() => parseArguments(['serve']));
});

test('real GPG encrypts authenticated ranged DAV import; source-off repeated owner recovery', { timeout: 90000 }, async t => {
  const directory = await workspace(t);
  const dav = await source(t);
  const bundle = join(directory, 'bundle');
  const configPath = join(directory, 'source.private.json');
  await writeFile(configPath, JSON.stringify({ version: 1, source: dav.config, resource: RESOURCE }), { mode: 0o600 });
  const receipt = await run(parseArguments(['import', '--source-config', configPath, '--bundle', bundle]));
  assert.equal(receipt.encryption, 'OpenPGP-AES256');
  assert.ok(dav.requests.filter(request => request.method === 'GET').length > 2);
  await dav.stop();
  const requestCount = dav.requests.length;
  const cipherPath = join(bundle, 'file.pgp');
  const cipher = await readFile(cipherPath);
  const key = await readFile(join(bundle, 'recovery.key'));
  assert.match(key.toString(), /^[a-f0-9]{64}\n$/u);
  assert.equal((await lstat(bundle)).mode & 0o777, 0o700);
  for (const name of ['file.pgp', 'receipt.json', 'recovery.key']) {
    assert.equal((await lstat(join(bundle, name))).mode & 0o777, 0o600);
  }
  for (const canary of [TOKEN, RESOURCE.pathSegments[0], 'OWNER PRIVATE CONTENT']) {
    assert.ok(!cipher.includes(Buffer.from(canary)));
    assert.ok(!JSON.stringify(receipt).includes(canary));
  }
  await noStaging(directory);

  await t.test('two actual decryptions publish only fully verified output without consuming input', async () => {
    for (const name of ['restore-one', 'restore-two']) {
      const output = join(directory, name);
      const report = await run(parseArguments(['restore-local', '--bundle', bundle, '--cipher', cipherPath, '--output', output]));
      assert.equal(report.restored, true);
      assert.equal(report.bytes, DATA.length);
      assert.equal(report.openpgp_integrity_verified, true);
      assert.equal(report.manifest_verified, true);
      assert.deepEqual(await readFile(join(output, 'content.bin')), DATA);
      const metadata = JSON.parse(await readFile(join(output, 'metadata.json')));
      assert.equal(metadata.source.etag, '"fixture-version-1"');
      assert.ok(metadata.source.url.endsWith('/private-name.txt'));
      assert.ok(!JSON.stringify(metadata).includes(TOKEN));
      assert.equal((await lstat(output)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(output, 'content.bin'))).mode & 0o777, 0o600);
    }
    assert.deepEqual(await readFile(cipherPath), cipher);
    assert.deepEqual(await readFile(join(bundle, 'recovery.key')), key);
    assert.equal(dav.requests.length, requestCount);
    await noStaging(directory);
  });

  await t.test('existing destination and tampered ciphertext never publish or overwrite plaintext', async () => {
    await assert.rejects(restorePrivateFile({ bundle, cipher: cipherPath, output: join(directory, 'restore-one') }),
      { code: 'OUTPUT_EXISTS' });
    const changed = Buffer.from(cipher);
    changed[Math.floor(changed.length / 2)] ^= 1;
    const corrupt = join(directory, 'corrupt.pgp');
    await writeFile(corrupt, changed, { mode: 0o600 });
    const output = join(directory, 'tampered-output');
    await assert.rejects(restorePrivateFile({ bundle, cipher: corrupt, output }), { code: 'CIPHER_IDENTITY_MISMATCH' });
    await absent(output);
    assert.deepEqual(await readFile(join(directory, 'restore-one/content.bin')), DATA);
  });

  await t.test('actual GPG authentication failure keeps requested output absent', async () => {
    const badBundle = join(directory, 'bad-key-bundle');
    await mkdir(badBundle, { mode: 0o700 });
    await copyFile(join(bundle, 'receipt.json'), join(badBundle, 'receipt.json'));
    await writeFile(join(badBundle, 'recovery.key'), `${'0'.repeat(64)}\n`, { mode: 0o600 });
    const output = join(directory, 'wrong-key-output');
    await assert.rejects(restorePrivateFile({ bundle: badBundle, cipher: cipherPath, output }), { code: 'CRYPTO_FAILED' });
    await absent(output);
    await noStaging(directory);
  });

  await t.test('OpenPGP rejects changed encrypted data even when the outer receipt is replaced', async () => {
    const changed = Buffer.from(cipher);
    // Change the authenticated encrypted content, not its outer packet framing.
    changed[Math.floor(changed.length / 2)] ^= 1;
    const badBundle = join(directory, 'bad-mdc-bundle');
    await mkdir(badBundle, { mode: 0o700 });
    await copyFile(join(bundle, 'recovery.key'), join(badBundle, 'recovery.key'));
    await writeFile(join(badBundle, 'receipt.json'), JSON.stringify({ ...receipt,
      cipher_sha256: createHash('sha256').update(changed).digest('hex'),
    }), { mode: 0o600 });
    const corrupt = join(badBundle, 'file.pgp');
    await writeFile(corrupt, changed, { mode: 0o600 });
    const output = join(directory, 'bad-mdc-output');
    await assert.rejects(restorePrivateFile({ bundle: badBundle, cipher: corrupt, output }), { code: 'CRYPTO_FAILED' });
    await absent(output);
    await noStaging(directory);
  });

  await t.test('core contract fixture sees ciphertext only; actual decryption survives local cipher removal', async () => {
    // Deliberately a contract fixture, NOT proof of actual peer storage or protected routes.
    const requests = [];
    let remoteCipher;
    const storageFactory = async config => {
      assert.equal(config, '/synthetic/private-core-config');
      return {
        create: async request => { requests.push(request); return { status: 'complete' }; },
        deposit: async request => {
          requests.push(request);
          remoteCipher = await readFile(request.input);
          return { status: 'complete' };
        },
        restore: async request => {
          requests.push(request);
          await writeFile(request.output, remoteCipher, { mode: 0o600, flag: 'wx' });
          return { status: 'complete', restore_verified: true, local_process_joined: true };
        },
      };
    };
    const options = { config: '/synthetic/private-core-config', bundle };
    await storePrivateFile('create', options, { storageFactory });
    await storePrivateFile('deposit', options, { storageFactory });
    assert.deepEqual(requests[0], { input: cipherPath, sha256: receipt.cipher_sha256, alreadyEncrypted: true });
    assert.deepEqual(requests[1], { input: cipherPath, alreadyEncrypted: true });
    await rm(cipherPath);
    const output = join(directory, 'contract-restored');
    const report = await restoreStoredFile({ ...options, output }, { storageFactory });
    assert.equal(report.restored, true);
    assert.deepEqual(await readFile(join(output, 'content.bin')), DATA);
    assert.equal(requests[2].sha256, receipt.cipher_sha256);
    assert.deepEqual(Object.keys(requests[2]).sort(), ['output', 'sha256']);
    assert.ok(!JSON.stringify(requests).includes(key.toString().trim()));
    assert.equal(dav.requests.length, requestCount);
    await absent(cipherPath);
    await noStaging(directory);
    assert.deepEqual(await readFile(join(bundle, 'recovery.key')), key);
  });

  await t.test('incomplete core restore fails visibly without source or local fallback', async () => {
    const output = join(directory, 'incomplete-output');
    const storageFactory = async () => ({ restore: async () => ({ status: 'incomplete' }) });
    await assert.rejects(restoreStoredFile({ config: 'synthetic', bundle, output }, { storageFactory }),
      { code: 'STORAGE_RESTORE_INCOMPLETE' });
    await absent(output);
    assert.equal(dav.requests.length, requestCount);
    assert.deepEqual(await readFile(join(bundle, 'recovery.key')), key);
    await noStaging(directory);
  });
});

test('changing DAV source leaves no bundle and removes its private partial download', async t => {
  const directory = await workspace(t);
  const dav = await source(t, DATA, true);
  const output = join(directory, 'bundle');
  await assert.rejects(importPrivateFile({ source: dav.config, resource: RESOURCE, output }), { code: 'SOURCE_CHANGED' });
  await absent(output);
  await noStaging(directory);
});

test('empty files remain distinct from a failed or missing download and actually decrypt', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const dav = await source(t, Buffer.alloc(0));
  const bundle = join(directory, 'bundle');
  await importPrivateFile({ source: dav.config, resource: RESOURCE, output: bundle });
  await dav.stop();
  const output = join(directory, 'empty-restored');
  const result = await restorePrivateFile({ bundle, cipher: join(bundle, 'file.pgp'), output });
  assert.equal(result.bytes, 0);
  assert.equal((await readFile(join(output, 'content.bin'))).length, 0);
  assert.equal(dav.requests.length, 1);
});
