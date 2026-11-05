// SPDX-License-Identifier: GPL-3.0-only
// Real private admission files; synthetic core boundary, not signed peer proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openUploadMaintenance, validateUploadMaintenance } from '../src/storage-upload-maintenance.mjs';

const KEY = [1, 2, 3].map(number => String(number).repeat(64));
const hash = value => createHash('sha256').update(value).digest('hex');
const POLICY = { version: 2, expiresAt: 2000, maxSessions: 2, maxChargedBytes: 1024,
  perArchiveMaxChargedBytes: 512, fromProviderKey: KEY[0], lifetimeSeconds: 500,
  renewBeforeSeconds: 600, maximumTurnBytes: 1048576, existing: [] };
const put = (path, value) => writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vp-cloud-maintenance-'));
  t.after(() => rm(root, { recursive: true }));
  const providers = KEY.map((key, index) => ({ key, grant: join(root, `grant-${index}`) }));
  for (const [index, provider] of providers.entries()) await writeFile(provider.grant, `synthetic grant ${index}`, { mode: 0o600 });
  const calls = [], cores = [], registries = [];
  let clock = 1000;
  const storageFactory = async config => {
    const state = JSON.parse(await readFile(config)).stateDirectory;
    let stop;
    const core = {
      async enrollMaintenance(request) {
        calls.push(['enroll', config, request]);
        await mkdir(request.enrollment, { mode: 0o700 });
        await put(join(request.enrollment, 'enrollment.json'), { enrollment: {
          version: 1, archive: state, created: clock, expires: request.authorizationExpiresAt,
          maximum_charged: request.maximumChargedBytes, lifetime: request.lifetimeSeconds,
          renew_before: request.renewBeforeSeconds, maximum_turn: request.maximumTurnBytes,
          source: [...Buffer.from(request.fromProviderKey, 'hex')],
          providers: request.providers.map(provider => [...Buffer.from(provider.key, 'hex')]),
          grants: await Promise.all(request.providers.map(async provider => (await readFile(provider.grant)).toString('hex'))),
        }, signature: 'synthetic contract fixture, not a real signature' });
        return { status: 'complete', local_process_joined: true };
      },
      async maintenanceStatus() { return { status: 'complete', local_process_joined: true }; },
      async startMaintenance(request) {
        calls.push(['start', config, request]);
        return { done: new Promise(resolve => { stop = resolve; }) };
      },
      async close() { calls.push(['close', config]); stop?.(); },
    };
    cores.push(core); return core;
  };
  async function object(name) {
    const selected = join(root, name); await mkdir(selected, { mode: 0o700 });
    await put(join(selected, 'core.json'), { version: 1, stateDirectory: join(selected, 'journal'), providers });
    return { root: selected, catalogSha256: hash('catalog ' + name), cipherSha256: hash('cipher ' + name), cipherBytes: 128 };
  }
  async function registry(policy = POLICY, extra = {}) {
    const selected = await openUploadMaintenance(policy, { storageFactory, now: () => clock, ...extra });
    registries.push(selected); return selected;
  }
  t.after(async () => { for (const selected of registries) await selected.close(); });
  return { root, providers, calls, cores, object, registry, storageFactory,
    set clock(value) { clock = value; } };
}

test('v2 has a closed finite schema; elapsed policy remains readable configuration', () => {
  assert.equal(validateUploadMaintenance(POLICY).expiresAt, 2000);
  assert.equal(validateUploadMaintenance({ ...POLICY, expiresAt: 1 }).expiresAt, 1);
  for (const changed of [{ ...POLICY, resetExpiry: true }, { ...POLICY, expiresAt: 0 },
    { ...POLICY, maxSessions: 9 }, { ...POLICY, maxChargedBytes: 0 },
    { ...POLICY, perArchiveMaxChargedBytes: 1025 }, { ...POLICY, lifetimeSeconds: 2678401 }]) {
    assert.throws(() => validateUploadMaintenance(changed));
  }
});

test('reservation is private and durable before deposit; complete starts the same adapter with absolute authority', async t => {
  const f = await fixture(t), input = await f.object('a'), registry = await f.registry();
  await registry.activate(); await registry.reserve(input);
  const intent = JSON.parse(await readFile(join(input.root, 'MAINTENANCE.json')));
  assert.equal(intent.expiresAt, POLICY.expiresAt);
  assert.equal(intent.maximumChargedBytes, 512);
  assert.equal((await lstat(join(input.root, 'MAINTENANCE.json'))).mode & 0o777, 0o600);
  assert.equal(f.calls.length, 0);
  const core = await registry.storageFactory(join(input.root, 'core.json'));
  assert.equal(core, f.cores[0]);
  await registry.checkCharge(input.root, { logical_ciphertext_bytes: 128, physical_payload_charge_upper_bound: 256 });
  await registry.complete(input.root);
  const enrolled = f.calls.find(([operation]) => operation === 'enroll')[2];
  assert.equal(enrolled.authorizationExpiresAt, POLICY.expiresAt);
  assert.equal(enrolled.authorizationSeconds, 2678400);
  assert.deepEqual(enrolled.providers.map(provider => provider.key), KEY.slice(1));
  assert.equal(await registry.storageFactory(join(input.root, 'core.json')), core);
  assert.equal((await registry.status()).sessions[0].state, 'active');
  assert.equal(JSON.stringify(await registry.status()).includes(f.root), false);
});

test('concurrent admissions never exceed ceilings or slots, and retries do not double count', async t => {
  const f = await fixture(t), a = await f.object('a'), b = await f.object('b');
  const registry = await f.registry({ ...POLICY, maxSessions: 1, maxChargedBytes: 512 });
  const results = await Promise.allSettled([registry.reserve(a), registry.reserve(b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await registry.status()).reserved_archive_ceiling_bytes, 512);
  assert.equal((await registry.status()).new_authorization_allowed, false);
  await registry.reserve(a);
  assert.equal((await registry.status()).configured_sessions, 1);
  await assert.rejects(registry.reserve(b), { code: 'MAINTENANCE_CAPACITY' });
});

test('restart recovers original enrollment and cap, never rebases expiry or signs again', async t => {
  const f = await fixture(t), input = await f.object('a'), first = await f.registry();
  await first.reserve(input); await first.complete(input.root); await first.close();
  const original = await readFile(join(input.root, 'maintenance/enrollment.json'));
  f.clock = 1200;
  const later = await f.registry({ ...POLICY, expiresAt: 3000 });
  await later.recover(input); await later.activate();
  assert.equal(f.calls.filter(([operation]) => operation === 'enroll').length, 1);
  assert.deepEqual(await readFile(join(input.root, 'maintenance/enrollment.json')), original);
  assert.equal((await later.status()).sessions[0].expires_at, 2000);
  assert.equal((await later.status()).reserved_archive_ceiling_bytes, 512);
});

test('pending deposit survives restart; only explicit completion creates the original finite enrollment', async t => {
  const f = await fixture(t), input = await f.object('a'), first = await f.registry();
  await first.reserve(input); await mkdir(join(input.root, 'journal'), { mode: 0o700 }); await first.close();
  const original = await readFile(join(input.root, 'MAINTENANCE.json'));
  f.clock = 1500;
  const later = await f.registry();
  await later.recover(input); await later.activate();
  assert.equal(f.calls.filter(([operation]) => operation === 'enroll').length, 0);
  assert.equal((await later.status()).reserved_archive_ceiling_bytes, 512);
  await later.reserve(input); await later.complete(input.root);
  assert.deepEqual(await readFile(join(input.root, 'MAINTENANCE.json')), original);
  assert.equal(f.calls.find(([operation]) => operation === 'enroll')[2].authorizationExpiresAt, 2000);
});

test('expired policy forbids new authorization without preventing existing foreground adapter access', async t => {
  const f = await fixture(t), input = await f.object('a'), first = await f.registry();
  await first.reserve(input); await first.complete(input.root); await first.close();
  const starts = f.calls.filter(([operation]) => operation === 'start').length;
  f.clock = 2100;
  const later = await f.registry();
  await later.recover(input); await later.activate();
  assert.equal((await later.status()).sessions[0].state, 'expired');
  assert.equal((await later.status()).reserved_archive_ceiling_bytes, 512);
  assert.ok(await later.storageFactory(join(input.root, 'core.json')));
  assert.equal(f.calls.filter(([operation]) => operation === 'start').length, starts);
  await assert.rejects(later.reserve(await f.object('b')), { code: 'MAINTENANCE_POLICY_EXPIRED' });
});

test('changed config, grants or malformed durable intent degrade and retain conservative budget', async t => {
  for (const change of ['grant', 'config', 'intent']) {
    const f = await fixture(t), input = await f.object('a'), first = await f.registry();
    await first.reserve(input); await first.close();
    if (change === 'grant') await writeFile(f.providers[0].grant, 'changed');
    if (change === 'config') await writeFile(join(input.root, 'core.json'), (await readFile(join(input.root, 'core.json'))) + ' ');
    if (change === 'intent') await writeFile(join(input.root, 'MAINTENANCE.json'), '{');
    const later = await f.registry(); await later.recover(input); await later.activate();
    const status = await later.status();
    assert.equal(status.sessions[0].state, 'degraded');
    assert.equal(status.new_authorization_allowed, false);
    assert.ok(status.reserved_archive_ceiling_bytes >= 512);
    assert.ok(await later.storageFactory(join(input.root, 'core.json')));
    await assert.rejects(later.reserve(await f.object('b')), { code: 'MAINTENANCE_ADMISSION_UNCERTAIN' });
  }
});

test('same static and recovered object counts once; unrelated existing obligation counts its signed cap', async t => {
  const f = await fixture(t), input = await f.object('a'), first = await f.registry();
  await first.reserve(input); await first.complete(input.root); await first.close();
  const later = await f.registry({ ...POLICY, existing: [{ config: join(input.root, 'core.json'), enrollment: join(input.root, 'maintenance') }] });
  await later.recover(input); await later.activate();
  assert.equal((await later.status()).reserved_archive_ceiling_bytes, 512);
  assert.equal((await later.status()).configured_sessions, 1);
  await later.reserve(await f.object('b'));
  assert.equal((await later.status()).reserved_archive_ceiling_bytes, 1024);
  await assert.rejects(later.reserve(await f.object('c')), { code: 'MAINTENANCE_CAPACITY' });
});

test('existing corrupt or changed enrollment blocks new admission unlike an absent pending enrollment', async t => {
  for (const change of ['corrupt', 'larger-ceiling']) {
    const f = await fixture(t), input = await f.object('a'), first = await f.registry();
    await first.reserve(input); await first.complete(input.root); await first.close();
    const path = join(input.root, 'maintenance/enrollment.json');
    if (change === 'corrupt') await writeFile(path, '{');
    else {
      const value = JSON.parse(await readFile(path)); value.enrollment.maximum_charged = 1000;
      await put(path, value);
    }
    const later = await f.registry(); await later.recover(input); await later.activate();
    const status = await later.status();
    assert.equal(status.new_authorization_allowed, false);
    assert.equal(status.sessions[0].authority_uncertain, true);
    assert.equal(status.sessions[0].state, 'degraded');
    await assert.rejects(later.reserve(await f.object('b')), { code: 'MAINTENANCE_ADMISSION_UNCERTAIN' });
  }
});

test('post-rename fsync failure keeps the original durable intent and its reserved budget', async t => {
  const f = await fixture(t), input = await f.object('a'), registry = await f.registry();
  const original = fs.open;
  fs.open = async (path, ...args) => {
    const handle = await original(path, ...args);
    if (path === input.root && args[0] === 'r') handle.sync = async () => { throw Error('synthetic fsync failure'); };
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(registry.reserve(input), /synthetic fsync/u); }
  finally { fs.open = original; syncBuiltinESMExports(); }
  assert.equal(JSON.parse(await readFile(join(input.root, 'MAINTENANCE.json'))).expiresAt, 2000);
  assert.equal((await registry.status()).reserved_archive_ceiling_bytes, 512);
  assert.equal((await registry.status()).new_authorization_allowed, false);
  assert.equal(f.calls.length, 0);
});

test('closing during delayed core open joins the late core and cannot start maintenance', async t => {
  const f = await fixture(t), input = await f.object('a');
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const registry = await f.registry(POLICY, { storageFactory: async config => {
    entered(); await gate; return f.storageFactory(config);
  } });
  const pending = registry.reserve(input);
  const rejected = assert.rejects(pending, { code: 'STORAGE_MAINTENANCE_CLOSED' });
  await started;
  const closed = registry.close(); release(); await rejected; await closed;
  assert.deepEqual(f.calls.map(([operation]) => operation), ['close']);
});

test('cancellation reaches enrollment, retains reservation, and does not start a background owner', async t => {
  const f = await fixture(t), input = await f.object('a'), registry = await f.registry();
  await registry.reserve(input);
  let entered, joined = false;
  const started = new Promise(resolve => { entered = resolve; });
  f.cores[0].enrollMaintenance = async (_, { signal }) => {
    entered();
    return new Promise(resolve => signal.addEventListener('abort', () => {
      joined = true; resolve({ status: 'failed', local_process_joined: true });
    }, { once: true }));
  };
  const cancel = new AbortController();
  const complete = registry.complete(input.root, { signal: cancel.signal });
  const rejected = assert.rejects(complete, { code: 'MAINTENANCE_ENROLLMENT_UNCONFIRMED' });
  await started; cancel.abort(); await rejected;
  assert.equal(joined, true);
  assert.equal((await registry.status()).reserved_archive_ceiling_bytes, 512);
  assert.equal(f.calls.some(([operation]) => operation === 'start'), false);
});
