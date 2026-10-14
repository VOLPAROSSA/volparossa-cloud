// SPDX-License-Identifier: GPL-3.0-only
// Actual Cloud/default-adapter/child boundaries with synthetic CLI reports and
// opaque bytes. Not OpenPGP, real core signatures, custody or protected routes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { storePrivateFile } from '../src/private-file.mjs';

const KEYS = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
const CIPHER = Buffer.alloc(96, 0xa5);
const DIAGNOSTICS = { version: 1, failures: [{ fragment_index: 1, copy_index: 0,
  operation: 'append', stage: 'agent_terminal', category: 'agent_rejected',
  agent_code: 'CONTENT_UNAVAILABLE' }], omitted_failures: 0 };

function rawReport(diagnostics) {
  return {
    operation: 'private_storage_fragments_deposit', operation_complete: false,
    logical_ciphertext_bytes: 96, fragment_count: 3, copies_per_fragment: 2,
    distinct_provider_identities: 3, reserved_payload_bytes: 0,
    committed_payload_bytes: 0, uncertain_payload_bytes: 192,
    physical_payload_charge_upper_bound: 192, metadata_overhead_measured: false,
    expired_copies_remain_charged: true, fragments_with_confirmed_unexpired_copy: 0,
    fully_redundant_from_retained_receipts: false, current_remote_availability_proven: false,
    independent_failure_domains_proven: false, network_contribution_credit: false,
    automatic_repair: false, automatic_handoff: false, read_consumes_archive: false,
    erasure_coding: false, owner_signature_verified: true,
    providers: KEYS.map(provider_key => ({ provider_key, physical_payload_charge_upper_bound: 64 })),
    fragments: KEYS.map((_, index) => ({ index, offset: index * 32, ciphertext_bytes: 32,
      confirmed_unexpired_copies: 0, copies: [0, 1].map(copy => ({
        provider_key: KEYS[(index + copy) % 3], charge: 'uncertain',
      })) })),
    ...(diagnostics === undefined ? {} : { deposit_diagnostics: diagnostics }),
    private_error: 'PRIVATE RAW REPORT MUST NEVER ESCAPE',
  };
}

async function fixture(t, diagnostics) {
  const root = await mkdtemp(join(tmpdir(), 'cloud-deposit-contract-'));
  await chmod(root, 0o700);
  const server = createServer(connection => connection.destroy());
  const socket = join(root, 'control.sock');
  server.listen(socket); await once(server, 'listening'); await chmod(socket, 0o600);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true });
  });
  const state = join(root, 'journal'); await mkdir(state, { mode: 0o700 });
  const bundle = join(root, 'bundle'); await mkdir(bundle, { mode: 0o700 });
  await writeFile(join(bundle, 'file.pgp'), CIPHER, { mode: 0o600 });
  await writeFile(join(bundle, 'receipt.json'), JSON.stringify({ version: 2,
    kind: 'volparossa-cloud-private-file', cipher_file: 'file.pgp', cipher_bytes: CIPHER.length,
    cipher_sha256: createHash('sha256').update(CIPHER).digest('hex'), encryption: 'OpenPGP-AES256',
    source_consistency: 'owner-upload-snapshot',
  }), { mode: 0o600 });
  for (const name of ['identity', 'passphrase']) await writeFile(join(root, name), 'synthetic', { mode: 0o600 });
  const binary = join(root, 'synthetic-core');
  await writeFile(binary, `#!${process.execPath}
if (process.argv[6] !== 'deposit') process.exit(17);
process.stdout.write(${JSON.stringify(JSON.stringify(rawReport(diagnostics)))});
process.exitCode = 1;
`, { mode: 0o700 });
  const config = join(root, 'core.json');
  await writeFile(config, JSON.stringify({ version: 1, coreBinary: binary, controlSocket: socket,
    identity: join(root, 'identity'), passphraseFile: join(root, 'passphrase'), stateDirectory: state,
    providers: KEYS.map((key, index) => ({ key, grant: join(root, `grant${index}`) })),
    fragmentBytes: 32, lifetimeSeconds: 600, deadlineMs: 3000,
  }), { mode: 0o600 });
  return { root, state, bundle, config };
}

test('default Cloud deposit carries only the validated optional diagnostic through the real child boundary', async t => {
  const value = await fixture(t, DIAGNOSTICS);
  const result = await storePrivateFile('deposit', value);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.code, 'retained_operation_incomplete');
  assert.equal(result.local_process_joined, true);
  assert.equal(result.remote_cleanup_confirmed, false);
  assert.equal(result.storage.uncertain_payload_bytes, 192);
  assert.deepEqual(result.storage.deposit_diagnostics, DIAGNOSTICS);
  for (const canary of [value.root, ...KEYS, 'PRIVATE RAW REPORT MUST NEVER ESCAPE']) {
    assert.ok(!JSON.stringify(result).includes(canary));
  }
  assert.equal((await lstat(value.state)).isDirectory(), true);
  assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
});

test('old Cloud deposit reports remain optional and malformed diagnostics never become public error strings', async t => {
  const old = await fixture(t, undefined);
  const result = await storePrivateFile('deposit', old);
  assert.equal(result.status, 'incomplete');
  assert.equal(Object.hasOwn(result.storage, 'deposit_diagnostics'), false);
  const invalid = structuredClone(DIAGNOSTICS);
  invalid.failures[0].agent_code = 'PRIVATE-PEER-ERROR';
  const changed = await fixture(t, invalid);
  const failed = await storePrivateFile('deposit', changed);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'invalid_core_report');
  assert.equal(failed.storage, null);
  assert.ok(!JSON.stringify(failed).includes('PRIVATE-PEER-ERROR'));
  assert.equal(failed.local_process_joined, true);
  assert.equal((await lstat(changed.state)).isDirectory(), true);
});

test('Cloud retains v2 initial agent observations without changing ciphertext, journals or charges', async t => {
  for (const detail of [null, { stage: 'provider_lookup', deadline_scope: 'operation' },
    { stage: 'unobserved', deadline_scope: 'operation' },
    { stage: 'tls_handshake', deadline_scope: 'exchange' },
    { stage: 'challenge', deadline_scope: 'none' }]) {
    const diagnostics = structuredClone(DIAGNOSTICS);
    diagnostics.version = 2;
    Object.assign(diagnostics.failures[0], { operation: 'reserve', stage: 'agent_ready', agent_detail: detail });
    const value = await fixture(t, diagnostics);
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.code, 'retained_operation_incomplete');
    assert.deepEqual(result.storage.deposit_diagnostics, diagnostics);
    assert.equal(result.storage.uncertain_payload_bytes, 192);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    for (const canary of [value.root, ...KEYS, 'PRIVATE RAW REPORT MUST NEVER ESCAPE']) assert.ok(!JSON.stringify(result).includes(canary));
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud does not relabel terminal errors, accept impossible timeouts, or expose private detail', async t => {
  const good = { ...DIAGNOSTICS.failures[0], stage: 'agent_ready',
    agent_detail: { stage: 'tls_handshake', deadline_scope: 'none' } };
  const failures = [{ ...good, stage: 'agent_terminal' }, { ...good, agent_code: 'unknown' },
    { ...good, agent_code: 'CONTENT_BUSY', agent_detail: { stage: 'tls_handshake', deadline_scope: 'operation' } },
    { ...good, agent_detail: { stage: 'provider_lookup', deadline_scope: 'exchange' } },
    { ...good, agent_detail: { stage: 'unobserved', deadline_scope: 'none' } },
    { ...good, agent_detail: { ...good.agent_detail, raw: 'PRIVATE-PEER-ERROR' } },
    { ...good, agent_detail: 'PRIVATE-PEER-ERROR' }, { ...DIAGNOSTICS.failures[0] }];
  for (const failure of failures) {
    const value = await fixture(t, { version: 2, failures: [failure], omitted_failures: 0 });
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'invalid_core_report');
    assert.equal(result.storage, null);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-PEER-ERROR'));
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v3 carries exact nullable TLS classes without changing ciphertext, accounting or outcome', async t => {
  const details = [null, { stage: 'provider_lookup', deadline_scope: 'operation', tls_failure: null },
    { stage: 'tls_handshake', deadline_scope: 'exchange', tls_failure: null },
    ...[null, 'offer', 'configuration', 'handshake_deadline', 'authentication', 'tls_other', 'io']
      .map(tls_failure => ({ stage: 'tls_handshake', deadline_scope: 'none', tls_failure }))];
  for (const agent_detail of details) {
    const diagnostics = { version: 3, failures: [{ ...DIAGNOSTICS.failures[0], operation: 'finalize',
      stage: 'agent_ready', agent_detail }], omitted_failures: 0 };
    const value = await fixture(t, diagnostics);
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.code, 'retained_operation_incomplete');
    assert.deepEqual(result.storage.deposit_diagnostics, diagnostics);
    assert.equal(JSON.stringify(result.storage.deposit_diagnostics), JSON.stringify(diagnostics));
    if (agent_detail) assert.ok(Object.isFrozen(result.storage.deposit_diagnostics.failures[0].agent_detail));
    assert.equal(result.storage.uncertain_payload_bytes, 192);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    for (const canary of [value.root, ...KEYS, 'PRIVATE RAW REPORT MUST NEVER ESCAPE']) assert.ok(!JSON.stringify(result).includes(canary));
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v3 rejects false TLS scope, raw details, duplicate copies and v2 field injection', async t => {
  const detail = { stage: 'tls_handshake', deadline_scope: 'none', tls_failure: 'io' };
  const good = { ...DIAGNOSTICS.failures[0], stage: 'agent_ready', agent_detail: detail };
  const failures = [{ ...good, stage: 'agent_terminal' },
    ...['CONTENT_INVALID', 'CONTENT_BUSY', 'CONTENT_POLICY', 'unknown']
      .map(agent_code => ({ ...good, agent_code })),
    ...['operation', 'exchange'].map(deadline_scope => ({ ...good, agent_detail: { ...detail, deadline_scope } })),
    ...['provider_lookup', 'stream_open', 'challenge']
      .map(stage => ({ ...good, agent_detail: { ...detail, stage } })),
    ...['unobserved', 'PRIVATE-PEER-ERROR', 0, false, {}, []]
      .map(tls_failure => ({ ...good, agent_detail: { ...detail, tls_failure } })),
    { ...good, agent_detail: { stage: 'tls_handshake', deadline_scope: 'none' } },
    { ...good, agent_detail: { ...detail, raw: 'PRIVATE-PEER-ERROR' } }];
  const invalid = failures.map(failure => ({ version: 3, failures: [failure], omitted_failures: 0 }));
  invalid.push({ version: 2, failures: [{ ...good, agent_detail: { ...detail, tls_failure: null } }], omitted_failures: 0 },
    { version: 3, failures: [good, good], omitted_failures: 0 },
    { version: 3, failures: Array(9).fill(good), omitted_failures: 0 },
    { version: 3, failures: [good], omitted_failures: 1 },
    { version: 4, failures: [good], omitted_failures: 0 });
  for (const diagnostics of invalid) {
    const value = await fixture(t, diagnostics);
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'invalid_core_report');
    assert.equal(result.storage, null);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-PEER-ERROR'));
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

function diagnosticV4(agent_outcome = null, changes = {}) {
  return { version: 4, failures: [{ ...DIAGNOSTICS.failures[0], category: 'io', agent_code: null,
    agent_detail: null, agent_outcome, ...changes }], omitted_failures: 0 };
}

test('Cloud v4 preserves original failure and custody across nullable and observed local outcomes', async t => {
  const cases = [diagnosticV4(),
    ...['missing', 'pending', 'expired', 'query_failed', 'query_timeout']
      .map(status => diagnosticV4({ status, detail: null })),
    ...[{ phase: 'remote_receipt_read', category: 'io', deadline_scope: 'none' },
      { phase: 'admission', category: 'timeout', deadline_scope: 'bridge' },
      { phase: 'remote_payload_verify', category: 'timeout', deadline_scope: 'remote_wire' },
      { phase: 'terminal_write', category: 'timeout', deadline_scope: 'operation' },
      { phase: 'provider_tls_close', category: 'timeout', deadline_scope: 'exchange' },
      { phase: 'ready_write', category: 'cancelled', deadline_scope: 'none' }]
      .map(detail => diagnosticV4({ status: 'observed', detail })),
    diagnosticV4(null, { stage: 'agent_ready', category: 'agent_rejected', agent_code: 'CONTENT_UNAVAILABLE',
      agent_detail: { stage: 'tls_handshake', deadline_scope: 'none', tls_failure: 'authentication' } })];
  const baseline = await storePrivateFile('deposit', await fixture(t, undefined));
  for (const diagnostics of cases) {
    const value = await fixture(t, diagnostics);
    const journal = join(value.state, 'owner-state');
    await writeFile(journal, 'PRIVATE-JOURNAL-CANARY', { mode: 0o600 });
    const result = await storePrivateFile('deposit', value);
    assert.equal(JSON.stringify(result.storage.deposit_diagnostics), JSON.stringify(diagnostics));
    const { deposit_diagnostics, ...accounting } = result.storage;
    assert.deepEqual(accounting, baseline.storage);
    assert.deepEqual({ ...result, storage: baseline.storage }, baseline);
    const outcome = deposit_diagnostics.failures[0].agent_outcome;
    assert.ok(Object.isFrozen(deposit_diagnostics) && Object.isFrozen(deposit_diagnostics.failures[0]));
    if (outcome) {
      assert.ok(Object.isFrozen(outcome));
      if (outcome.detail) assert.ok(Object.isFrozen(outcome.detail));
      assert.equal(deposit_diagnostics.failures[0].category, 'io');
    }
    for (const canary of [value.root, ...KEYS, 'PRIVATE-JOURNAL-CANARY', 'PRIVATE RAW REPORT MUST NEVER ESCAPE']) {
      assert.ok(!JSON.stringify(result).includes(canary));
    }
    assert.equal(await readFile(journal, 'utf8'), 'PRIVATE-JOURNAL-CANARY');
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v4 rejects leaking or contradictory observations and old-version field injection', async t => {
  const detail = { phase: 'remote_receipt_read', category: 'io', deadline_scope: 'none' };
  const good = { status: 'observed', detail };
  const invalid = ['PRIVATE-PEER-ERROR', {}, [], { ...good, original_request_id: 'PRIVATE-PEER-ERROR' },
    { status: 'observed' }, { status: 'observed', detail: null }, { ...good, status: 'missing' },
    { ...good, status: 'PRIVATE-PEER-ERROR' }, { ...good, detail: { ...detail, raw: 'PRIVATE-PEER-ERROR' } },
    { ...good, detail: { ...detail, phase: 'unobserved' } },
    { ...good, detail: { ...detail, category: 'unobserved' } },
    { ...good, detail: { ...detail, category: 'timeout' } },
    { ...good, detail: { ...detail, deadline_scope: 'operation' } },
    { ...good, detail: { phase: 'ready_write', category: 'timeout', deadline_scope: 'bridge' } },
    { ...good, detail: { phase: 'local_receipt_write', category: 'timeout', deadline_scope: 'remote_wire' } }]
    .map(outcome => diagnosticV4(outcome));
  for (const version of [1, 2, 3, 5]) invalid.push({ ...diagnosticV4(good), version });
  for (const key of ['agent_outcome', 'agent_detail']) {
    const missing = diagnosticV4(good); delete missing.failures[0][key]; invalid.push(missing);
  }
  for (const stage of ['agent_ready', 'signed_request', 'accounting']) invalid.push(diagnosticV4(good, { stage }));
  invalid.push(diagnosticV4(good, { agent_detail: { stage: 'tls_handshake', deadline_scope: 'none', tls_failure: 'io' } }));
  for (const diagnostics of invalid) {
    const value = await fixture(t, diagnostics);
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'invalid_core_report');
    assert.equal(result.storage, null);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-PEER-ERROR'));
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud vendored helpers retain exact local provenance sizes and digests', async () => {
  const provenance = JSON.parse(await readFile(new URL('../third_party/volparossa-image-source.json', import.meta.url), 'utf8'));
  assert.equal(provenance.repository, 'https://github.com/VOLPAROSSA/volparossa-image');
  assert.match(provenance.revision, /^[0-9a-f]{40}$/);
  assert.equal(provenance.local_modifications, false);
  assert.deepEqual(Object.keys(provenance.files).sort(), ['LICENSE', 'scripts/immich_snapshot.py', 'src/core-storage.mjs']);
  for (const [source, entry] of Object.entries(provenance.files)) {
    const name = source.split('/').at(-1);
    assert.equal(entry.local, `vendor/volparossa-image/${name}`);
    const bytes = await readFile(new URL(`../${entry.local}`, import.meta.url));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
});
