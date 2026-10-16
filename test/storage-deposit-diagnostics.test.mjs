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
import { run as runCloudFile } from '../scripts/cloud-file.mjs';

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

async function fixture(t, diagnostics, configChanges = {}) {
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
if (process.argv.filter(value => value === '--append-diagnostics-v7').length !== ${configChanges.appendDiagnosticsV7 === true ? 1 : 0}) process.exit(18);
if (${configChanges.appendDiagnosticsV7 === true} && process.argv[9] !== '--append-diagnostics-v7') process.exit(19);
if (process.argv.filter(value => value === '--flow-acquire-diagnostics-v8').length !== ${configChanges.flowAcquireDiagnosticsV8 === true ? 1 : 0}) process.exit(20);
if (${configChanges.flowAcquireDiagnosticsV8 === true} && process.argv[9] !== '--flow-acquire-diagnostics-v8') process.exit(21);
if (process.argv.filter(value => value === '--tls-close-diagnostics-v9').length !== ${configChanges.tlsCloseDiagnosticsV9 === true ? 1 : 0}) process.exit(22);
if (${configChanges.tlsCloseDiagnosticsV9 === true} && process.argv[9] !== '--tls-close-diagnostics-v9') process.exit(23);
process.stdout.write(${JSON.stringify(JSON.stringify(rawReport(diagnostics)))});
process.exitCode = 1;
`, { mode: 0o700 });
  const config = join(root, 'core.json');
  await writeFile(config, JSON.stringify({ version: 1, coreBinary: binary, controlSocket: socket,
    identity: join(root, 'identity'), passphraseFile: join(root, 'passphrase'), stateDirectory: state,
    providers: KEYS.map((key, index) => ({ key, grant: join(root, `grant${index}`) })),
    fragmentBytes: 32, lifetimeSeconds: 600, deadlineMs: 3000, ...configChanges,
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
  for (const version of [1, 2, 3, 7]) invalid.push({ ...diagnosticV4(good), version });
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

test('Cloud v5 stream diagnostics cross the child boundary without changing custody or charges', async t => {
  const baseline = await storePrivateFile('deposit', await fixture(t, undefined));
  for (const stream_failure of [null, 'policy', 'route_state', 'route_material', 'flow_acquire',
    'transport_certificate', 'transport_tls', 'initial_paths', 'open_tcp_write', 'subflow_readiness', 'stream_attachment']) {
    const diagnostics = { version: 5, failures: [{ ...DIAGNOSTICS.failures[0], stage: 'agent_ready',
      agent_detail: { stage: 'stream_open', deadline_scope: 'none', tls_failure: null, stream_failure },
      agent_outcome: null }], omitted_failures: 0 };
    const value = await fixture(t, diagnostics);
    const result = await storePrivateFile('deposit', value);
    assert.equal(JSON.stringify(result.storage.deposit_diagnostics), JSON.stringify(diagnostics));
    const { deposit_diagnostics, ...accounting } = result.storage;
    assert.deepEqual(accounting, baseline.storage);
    assert.deepEqual({ ...result, storage: baseline.storage }, baseline);
    assert.ok(Object.isFrozen(deposit_diagnostics.failures[0].agent_detail));
    for (const canary of [value.root, ...KEYS, 'PRIVATE RAW REPORT MUST NEVER ESCAPE']) assert.ok(!JSON.stringify(result).includes(canary));
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v5 rejects counterfeit stream scope and historical field injection', async t => {
  const detail = { stage: 'stream_open', deadline_scope: 'none', tls_failure: null, stream_failure: 'open_tcp_write' };
  const good = { ...DIAGNOSTICS.failures[0], stage: 'agent_ready', agent_detail: detail, agent_outcome: null };
  const failures = [{ ...good, stage: 'agent_terminal' }, { ...good, category: 'io', agent_code: null },
    ...['CONTENT_POLICY', 'CONTENT_BUSY', 'CONTENT_INVALID', 'unknown'].map(agent_code => ({ ...good, agent_code })),
    ...['operation', 'exchange'].map(deadline_scope => ({ ...good, agent_detail: { ...detail, deadline_scope } })),
    ...['route_connect', 'provider_lookup', 'tls_handshake', 'challenge'].map(stage => ({ ...good, agent_detail: { ...detail, stage } })),
    ...['PRIVATE-STREAM-CANARY', 'unknown', 0, false, [], {}].map(stream_failure => ({ ...good, agent_detail: { ...detail, stream_failure } })),
    { ...good, agent_detail: { ...detail, tls_failure: 'io' } },
    { ...good, agent_detail: { ...detail, raw: 'PRIVATE-STREAM-CANARY' } }];
  for (const key of Object.keys(detail)) {
    const missing = { ...detail }; delete missing[key]; failures.push({ ...good, agent_detail: missing });
  }
  const invalid = failures.map(failure => ({ version: 5, failures: [failure], omitted_failures: 0 }));
  for (const version of [2, 3, 4]) {
    const failure = { ...good }; if (version < 4) delete failure.agent_outcome;
    invalid.push({ version, failures: [failure], omitted_failures: 0 });
    invalid.push({ version, failures: [{ ...failure, agent_detail: { ...detail, stream_failure: null } }], omitted_failures: 0 });
  }
  for (const diagnostics of invalid) {
    const value = await fixture(t, diagnostics);
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.code, 'invalid_core_report');
    assert.equal(result.storage, null);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-STREAM-CANARY'));
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v6 challenge substages and coarse timing remain diagnostic across the real child boundary', async t => {
  const baseline = await storePrivateFile('deposit', await fixture(t, undefined));
  const buckets = ['under_1s', '1_to_5s', '5_to_15s', '15_to_30s', '30_to_60s', '60_to_90s', '90_to_120s', 'at_least_120s'];
  const phases = ['selector_write_flush', 'grant_write_flush', 'challenge_read_verify'];
  const cases = [null, { stage: 'challenge', deadline_scope: 'none', tls_failure: null, stream_failure: null, challenge: null }];
  for (const [index, before_challenge] of buckets.entries()) for (const phase of phases) {
    cases.push({ stage: 'challenge', deadline_scope: ['none', 'operation', 'exchange'][index % 3],
      tls_failure: null, stream_failure: null,
      challenge: { phase, before_challenge, in_challenge: buckets[(index + 3) % buckets.length] } });
  }
  for (const agent_detail of cases) {
    const diagnostics = { version: 6, failures: [{ ...DIAGNOSTICS.failures[0], stage: 'agent_ready',
      agent_detail, agent_outcome: null }], omitted_failures: 0 };
    const value = await fixture(t, diagnostics);
    const result = await storePrivateFile('deposit', value);
    assert.equal(JSON.stringify(result.storage.deposit_diagnostics), JSON.stringify(diagnostics));
    const { deposit_diagnostics, ...accounting } = result.storage;
    assert.deepEqual(accounting, baseline.storage);
    assert.deepEqual({ ...result, storage: baseline.storage }, baseline);
    if (agent_detail !== null) assert.ok(Object.isFrozen(deposit_diagnostics.failures[0].agent_detail));
    if (agent_detail?.challenge) assert.ok(Object.isFrozen(deposit_diagnostics.failures[0].agent_detail.challenge));
    for (const canary of [value.root, ...KEYS, 'PRIVATE RAW REPORT MUST NEVER ESCAPE']) assert.ok(!JSON.stringify(result).includes(canary));
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v6 rejects wrong challenge scope, raw timing and historical nullable-key injection', async t => {
  const challenge = { phase: 'grant_write_flush', before_challenge: '5_to_15s', in_challenge: 'under_1s' };
  const detail = { stage: 'challenge', deadline_scope: 'none', tls_failure: null, stream_failure: null, challenge };
  const good = { ...DIAGNOSTICS.failures[0], stage: 'agent_ready', agent_detail: detail, agent_outcome: null };
  const failures = [{ ...good, stage: 'wire_receipt' }, { ...good, category: 'io', agent_code: null },
    ...['CONTENT_POLICY', 'CONTENT_BUSY', 'CONTENT_INVALID', 'unknown'].map(agent_code => ({ ...good, agent_code })),
    ...['stream_open', 'tls_handshake', 'provider_lookup'].map(stage => ({ ...good, agent_detail: { ...detail, stage } })),
    ...['bridge', 'remote_wire'].map(deadline_scope => ({ ...good, agent_detail: { ...detail, deadline_scope } })),
    { ...good, agent_detail: { ...detail, tls_failure: 'io' } },
    { ...good, agent_detail: { ...detail, stream_failure: 'open_tcp_write' } },
    { ...good, agent_detail: { ...detail, challenge: { ...challenge, timestamp: 1700000000 } } },
    { ...good, agent_detail: { ...detail, challenge: 'PRIVATE-CHALLENGE-CANARY' } }];
  for (const field of Object.keys(challenge)) {
    for (const value of ['PRIVATE-CHALLENGE-CANARY', 'unknown', '', null, 0, 5000, false, [], {}]) {
      failures.push({ ...good, agent_detail: { ...detail, challenge: { ...challenge, [field]: value } } });
    }
    const missing = { ...challenge }; delete missing[field];
    failures.push({ ...good, agent_detail: { ...detail, challenge: missing } });
  }
  for (const field of Object.keys(detail)) {
    const missing = { ...detail }; delete missing[field]; failures.push({ ...good, agent_detail: missing });
  }
  const invalid = failures.map(failure => ({ version: 6, failures: [failure], omitted_failures: 0 }));
  for (const version of [1, 2, 3, 4, 5]) for (const injected of [null, challenge]) {
    const failure = { ...good, agent_detail: { stage: 'challenge', deadline_scope: 'none', challenge: injected } };
    if (version < 4) delete failure.agent_outcome;
    if (version >= 3) failure.agent_detail.tls_failure = null;
    if (version >= 5) failure.agent_detail.stream_failure = null;
    invalid.push({ version, failures: [failure], omitted_failures: 0 });
  }
  for (const diagnostics of invalid) {
    const value = await fixture(t, diagnostics);
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.code, 'invalid_core_report');
    assert.equal(result.storage, null);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-CHALLENGE-CANARY'));
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

function diagnosticV7(append_timing = null, phase = 'remote_receipt_read', changes = {}) {
  return { ...diagnosticV4({ status: 'observed', detail: { phase, category: 'io', deadline_scope: 'none' },
    append_timing }, changes), version: 7 };
}

test('Cloud opt-in v7 crosses the actual child boundary with exact finite timings and unchanged accounting', async t => {
  const baseline = await storePrivateFile('deposit', await fixture(t, undefined));
  const cases = [diagnosticV7(), diagnosticV7(null, 'remote_receipt_read', { agent_outcome: null }),
    diagnosticV7(null, 'remote_receipt_read', { agent_outcome: { status: 'missing', detail: null, append_timing: null } }),
    diagnosticV7(null, 'remote_receipt_read', { operation: 'finalize' })];
  for (const bucket of ['under_1s', '1_to_5s', '5_to_15s', '15_to_30s',
    '30_to_60s', '60_to_90s', '90_to_120s', 'at_least_120s']) {
    const timing = { before_payload: bucket, in_payload_write_flush: bucket, in_receipt_read: null };
    cases.push(diagnosticV7(timing, 'remote_payload_write'), diagnosticV7({ ...timing, in_receipt_read: bucket }));
  }
  for (const diagnostics of cases) {
    const value = await fixture(t, diagnostics, { appendDiagnosticsV7: true });
    const journal = join(value.state, 'owner-state');
    await writeFile(journal, 'PRIVATE-APPEND-CANARY', { mode: 0o600 });
    const result = await storePrivateFile('deposit', value);
    assert.equal(JSON.stringify(result.storage.deposit_diagnostics), JSON.stringify(diagnostics));
    const { deposit_diagnostics, ...accounting } = result.storage;
    assert.deepEqual(accounting, baseline.storage);
    assert.deepEqual({ ...result, storage: baseline.storage }, baseline);
    const timing = deposit_diagnostics.failures[0].agent_outcome?.append_timing;
    if (timing) assert.ok(Object.isFrozen(timing));
    for (const canary of [value.root, ...KEYS, 'PRIVATE RAW REPORT MUST NEVER ESCAPE', 'PRIVATE-APPEND-CANARY']) {
      assert.ok(!JSON.stringify(result).includes(canary));
    }
    assert.equal(await readFile(journal, 'utf8'), 'PRIVATE-APPEND-CANARY');
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v7 refuses missing or raw timing, wrong bindings and silent schema downgrade', async t => {
  const timing = { before_payload: 'under_1s', in_payload_write_flush: '1_to_5s', in_receipt_read: '90_to_120s' };
  const invalid = [undefined, DIAGNOSTICS, { ...diagnosticV4(), version: 6 },
    diagnosticV7({ ...timing, phase: 'remote_receipt_read' }),
    diagnosticV7({ ...timing, elapsed_ms: 120000 }), diagnosticV7(timing, 'remote_payload_write'),
    diagnosticV7({ ...timing, in_receipt_read: null }), diagnosticV7(timing, 'remote_receipt_verify'),
    diagnosticV7(timing, 'remote_receipt_read', { operation: 'finalize' }),
    diagnosticV7(timing, 'remote_receipt_read', { operation: 'reserve' }),
    diagnosticV7(null, 'remote_receipt_read', { agent_outcome: { status: 'pending', detail: null, append_timing: timing } }),
    diagnosticV7('PRIVATE-APPEND-CANARY')];
  for (const field of Object.keys(timing)) {
    const missing = { ...timing }; delete missing[field]; invalid.push(diagnosticV7(missing));
    for (const value of ['PRIVATE-APPEND-CANARY', false, 1, [], {}]) invalid.push(diagnosticV7({ ...timing, [field]: value }));
  }
  const missingTiming = diagnosticV7(); delete missingTiming.failures[0].agent_outcome.append_timing; invalid.push(missingTiming);
  for (const diagnostics of invalid) {
    const value = await fixture(t, diagnostics, { appendDiagnosticsV7: true });
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.code, 'invalid_core_report', JSON.stringify(diagnostics));
    assert.equal(result.storage, null);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-APPEND-CANARY'));
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud absent or false opt-in retains historical optional reports and rejects unsolicited v7', async t => {
  for (const configChanges of [{}, { appendDiagnosticsV7: false }]) {
    for (const diagnostics of [undefined, DIAGNOSTICS, { ...diagnosticV4(), version: 6 }]) {
      const result = await storePrivateFile('deposit', await fixture(t, diagnostics, configChanges));
      assert.equal(result.status, 'incomplete');
      assert.equal(JSON.stringify(result.storage.deposit_diagnostics), JSON.stringify(diagnostics));
    }
    for (const diagnostics of [diagnosticV7(), { ...diagnosticV7(), version: 6 }]) {
      const result = await storePrivateFile('deposit', await fixture(t, diagnostics, configChanges));
      assert.equal(result.code, 'invalid_core_report');
      assert.equal(result.storage, null);
      assert.equal(result.local_process_joined, true);
    }
  }
});

function diagnosticV8(flow_acquire = null, changes = {}) {
  return { ...diagnosticV4(null, { operation: 'finalize', stage: 'agent_ready', category: 'agent_rejected',
    agent_code: 'CONTENT_UNAVAILABLE', agent_detail: { stage: 'stream_open', deadline_scope: 'none',
      tls_failure: null, stream_failure: 'flow_acquire', challenge: null, flow_acquire }, ...changes }), version: 8 };
}

const FLOW_PAIRS = {
  source_port: ['entropy'],
  retirement_drain: ['unconfirmed', 'io', 'helper_kernel', 'helper_capacity', 'helper_unavailable',
    'helper_cleanup_incomplete', 'helper_other_rejection', 'helper_timeout', 'helper_io',
    'helper_validation', 'helper_authority', 'helper_correlation', 'helper_runtime_changed'],
  material: ['metadata', 'topology'], slot_reservation: ['unconfirmed', 'local_capacity', 'local_unavailable'],
  helper_acquire: ['helper_kernel', 'helper_capacity', 'helper_unavailable', 'helper_not_found',
    'helper_cleanup_incomplete', 'helper_other_rejection', 'helper_timeout', 'helper_io',
    'helper_validation', 'helper_authority', 'helper_correlation', 'helper_runtime_changed'],
  descriptor_clone: ['io'], descriptor_adoption: ['metadata', 'io'], flow_metadata: ['metadata'],
};
function flowDetail(stage = 'helper_acquire', reason = 'helper_capacity', rounds = 1) {
  return { rounds, first: { stage, reason }, last: { stage, reason } };
}

test('Cloud explicit v8 carries all 35 typed flow pairs across its real child boundary', async t => {
  const baseline = await storePrivateFile('deposit', await fixture(t, undefined));
  const cases = [null, { rounds: 8, first: { stage: 'helper_acquire', reason: 'helper_capacity' },
    last: { stage: 'slot_reservation', reason: 'local_capacity' } }];
  let pairs = 0;
  for (const [stage, reasons] of Object.entries(FLOW_PAIRS)) for (const reason of reasons) {
    pairs++;
    for (const rounds of [1, 8]) cases.push(flowDetail(stage, reason, rounds));
  }
  assert.equal(pairs, 35);
  for (const flow of cases) {
    const diagnostics = diagnosticV8(flow);
    const value = await fixture(t, diagnostics, { flowAcquireDiagnosticsV8: true });
    const journal = join(value.state, 'owner-state');
    await writeFile(journal, 'PRIVATE-FLOW-CANARY', { mode: 0o600 });
    const result = await storePrivateFile('deposit', value);
    assert.equal(JSON.stringify(result.storage.deposit_diagnostics), JSON.stringify(diagnostics));
    const { deposit_diagnostics, ...accounting } = result.storage;
    assert.deepEqual(accounting, baseline.storage);
    assert.deepEqual({ ...result, storage: baseline.storage }, baseline);
    const observed = deposit_diagnostics.failures[0].agent_detail.flow_acquire;
    if (observed) assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.first) && Object.isFrozen(observed.last));
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    for (const canary of [value.root, ...KEYS, 'PRIVATE RAW REPORT MUST NEVER ESCAPE', 'PRIVATE-FLOW-CANARY']) {
      assert.ok(!JSON.stringify(result).includes(canary));
    }
    assert.equal(await readFile(journal, 'utf8'), 'PRIVATE-FLOW-CANARY');
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v8 refuses malformed flow, wrong scopes, private text and silent downgrade', async t => {
  const invalid = [undefined, DIAGNOSTICS, diagnosticV7(),
    diagnosticV8(flowDetail('retirement_drain', 'helper_not_found')),
    diagnosticV8(flowDetail('source_port', 'helper_capacity')),
    diagnosticV8(flowDetail('unobserved', 'entropy')),
    diagnosticV8({ ...flowDetail(), last: { stage: 'source_port', reason: 'entropy' } }),
    diagnosticV8('PRIVATE-FLOW-CANARY'), diagnosticV8({ ...flowDetail(), raw: 'PRIVATE-FLOW-CANARY' }),
    diagnosticV8({ ...flowDetail(), first: { stage: 'helper_acquire', reason: 'PRIVATE-FLOW-CANARY' } }),
    diagnosticV8(flowDetail(), { stage: 'agent_terminal' }), diagnosticV8(flowDetail(), { agent_code: 'CONTENT_BUSY' })];
  for (const rounds of [0, 9, true, '1', null, 1.5]) invalid.push(diagnosticV8({ ...flowDetail(), rounds }));
  for (const field of ['rounds', 'first', 'last']) {
    const flow = flowDetail(); delete flow[field]; invalid.push(diagnosticV8(flow));
  }
  for (const [field, value] of [['stage', 'tls_handshake'], ['deadline_scope', 'operation'],
    ['stream_failure', null], ['tls_failure', 'io'], ['flow_acquire', {}]]) {
    const bad = diagnosticV8(flowDetail()); bad.failures[0].agent_detail[field] = value; invalid.push(bad);
  }
  const missing = diagnosticV8(); delete missing.failures[0].agent_detail.flow_acquire; invalid.push(missing);
  for (const diagnostics of invalid) {
    const value = await fixture(t, diagnostics, { flowAcquireDiagnosticsV8: true });
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.code, 'invalid_core_report', JSON.stringify(diagnostics));
    assert.equal(result.storage, null);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-FLOW-CANARY'));
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v8 config is strict and does not change historical default or explicit v7 reports', async t => {
  for (const configChanges of [{}, { flowAcquireDiagnosticsV8: false }, { appendDiagnosticsV7: true },
    { appendDiagnosticsV7: true, flowAcquireDiagnosticsV8: false }]) {
    const diagnostics = configChanges.appendDiagnosticsV7 ? diagnosticV7() : DIAGNOSTICS;
    const result = await storePrivateFile('deposit', await fixture(t, diagnostics, configChanges));
    assert.deepEqual(result.storage.deposit_diagnostics, diagnostics);
    const unsolicited = await storePrivateFile('deposit', await fixture(t, diagnosticV8(), configChanges));
    assert.equal(unsolicited.code, 'invalid_core_report');
    assert.equal(unsolicited.storage, null);
    const misversioned = { ...diagnosticV8(), version: configChanges.appendDiagnosticsV7 ? 7 : 6 };
    assert.equal((await storePrivateFile('deposit', await fixture(t, misversioned, configChanges))).code, 'invalid_core_report');
  }
  for (const value of [null, 'true', true, 1, 0, [], {}]) {
    const configChanges = { flowAcquireDiagnosticsV8: value, ...(value === true ? { appendDiagnosticsV7: true } : {}) };
    await assert.rejects(storePrivateFile('deposit', await fixture(t, diagnosticV8(), configChanges)),
      { code: 'invalid_configuration' });
  }
});

test('Cloud selected v8 retains exact nullable APPEND timing without inventing flow facts', async t => {
  const timing = { before_payload: 'under_1s', in_payload_write_flush: '1_to_5s', in_receipt_read: '90_to_120s' };
  for (const diagnostics of [{ ...diagnosticV7(timing), version: 8 },
    { ...diagnosticV7(null, 'remote_receipt_read', { agent_outcome: null }), version: 8 },
    { ...diagnosticV7(null, 'remote_receipt_read', { agent_outcome: { status: 'missing', detail: null, append_timing: null } }), version: 8 }]) {
    const result = await storePrivateFile('deposit', await fixture(t, diagnostics, { flowAcquireDiagnosticsV8: true }));
    assert.deepEqual(result.storage.deposit_diagnostics, diagnostics);
    assert.equal(result.storage.deposit_diagnostics.failures[0].agent_detail, null);
  }
  const invalid = { ...diagnosticV7({ ...timing, raw: 'PRIVATE-FLOW-CANARY' }), version: 8 };
  const result = await storePrivateFile('deposit', await fixture(t, invalid, { flowAcquireDiagnosticsV8: true }));
  assert.equal(result.code, 'invalid_core_report');
  assert.equal(result.storage, null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-FLOW-CANARY'));
});

function diagnosticV9(tls_close_failure = null) {
  return { ...diagnosticV4({ status: 'observed', detail: { phase: 'transport_tls_close',
    category: 'unavailable', deadline_scope: 'none' }, append_timing: null, tls_close_failure },
  { operation: 'reserve' }), version: 9 };
}

test('Cloud script carries all four v9 close reasons through the default adapter and real child', async t => {
  const baseline = await storePrivateFile('deposit', await fixture(t, undefined));
  for (const reason of [null, 'shutdown_io', 'read_io', 'trailing_data', 'internal_deadline']) {
    const diagnostics = diagnosticV9(reason);
    const value = await fixture(t, diagnostics, { tlsCloseDiagnosticsV9: true });
    const journal = join(value.state, 'owner-state');
    await writeFile(journal, 'PRIVATE-CLOSE-CANARY', { mode: 0o600 });
    const result = await runCloudFile({ operation: 'deposit', config: value.config, bundle: value.bundle });
    assert.equal(JSON.stringify(result.storage.deposit_diagnostics), JSON.stringify(diagnostics));
    assert.ok(Object.isFrozen(result.storage.deposit_diagnostics.failures[0].agent_outcome));
    const { deposit_diagnostics, ...accounting } = result.storage;
    assert.deepEqual(accounting, baseline.storage);
    assert.deepEqual({ ...result, storage: baseline.storage }, baseline);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    for (const canary of [value.root, ...KEYS, 'PRIVATE RAW REPORT MUST NEVER ESCAPE', 'PRIVATE-CLOSE-CANARY']) {
      assert.ok(!JSON.stringify(result).includes(canary));
    }
    assert.equal(await readFile(journal, 'utf8'), 'PRIVATE-CLOSE-CANARY');
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v9 requires exact nullable fields and refuses unknown or wrongly scoped close failures', async t => {
  const invalid = [undefined, DIAGNOSTICS, diagnosticV7(), diagnosticV8()];
  for (const reason of ['PRIVATE-CLOSE-CANARY', 'unspecified', '', 1, false, {}, []]) invalid.push(diagnosticV9(reason));
  for (const field of ['tls_close_failure', 'append_timing']) {
    const bad = diagnosticV9(); delete bad.failures[0].agent_outcome[field]; invalid.push(bad);
  }
  for (const [field, value] of [['phase', 'provider_tls_close'], ['phase', 'remote_receipt_read'],
    ['category', 'io'], ['category', 'cancelled'], ['category', 'timeout'], ['deadline_scope', 'operation']]) {
    const bad = diagnosticV9('read_io'); bad.failures[0].agent_outcome.detail[field] = value; invalid.push(bad);
  }
  for (const status of ['missing', 'pending', 'expired', 'query_failed', 'query_timeout']) {
    const bad = diagnosticV9('read_io'); Object.assign(bad.failures[0].agent_outcome, { status, detail: null }); invalid.push(bad);
  }
  const raw = diagnosticV9(); raw.failures[0].agent_outcome.raw = 'PRIVATE-CLOSE-CANARY'; invalid.push(raw);
  const timing = diagnosticV9('read_io'); timing.failures[0].agent_outcome.append_timing = {
    before_payload: 'under_1s', in_payload_write_flush: 'under_1s', in_receipt_read: 'under_1s',
  }; invalid.push(timing);
  for (const version of [0, 8, 10, '9', true]) invalid.push({ ...diagnosticV9(), version });
  for (const diagnostics of invalid) {
    const value = await fixture(t, diagnostics, { tlsCloseDiagnosticsV9: true });
    const result = await storePrivateFile('deposit', value);
    assert.equal(result.code, 'invalid_core_report', JSON.stringify(diagnostics));
    assert.equal(result.storage, null);
    assert.equal(result.local_process_joined, true);
    assert.equal(result.remote_cleanup_confirmed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-CLOSE-CANARY'));
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v9 preserves nullable outcomes, existing flow bounds and APPEND timing', async t => {
  const timing = { before_payload: 'under_1s', in_payload_write_flush: '1_to_5s', in_receipt_read: '90_to_120s' };
  const cases = [{ ...diagnosticV8(flowDetail('helper_acquire', 'helper_kernel', 8)), version: 9 },
    { ...diagnosticV8(), version: 9 }];
  for (const outcome of [null, ...['missing', 'pending', 'expired', 'query_failed', 'query_timeout'].map(status => ({
    status, detail: null, append_timing: null, tls_close_failure: null,
  }))]) {
    const diagnostics = diagnosticV9(); diagnostics.failures[0].agent_outcome = outcome; cases.push(diagnostics);
  }
  const append = { ...diagnosticV7(timing), version: 9 };
  append.failures[0].agent_outcome.tls_close_failure = null; cases.push(append);
  for (const diagnostics of cases) {
    const result = await storePrivateFile('deposit', await fixture(t, diagnostics, { tlsCloseDiagnosticsV9: true }));
    assert.deepEqual(result.storage.deposit_diagnostics, diagnostics);
  }
  const invalidTiming = structuredClone(append); invalidTiming.failures[0].agent_outcome.append_timing.in_receipt_read = 'PRIVATE-CLOSE-CANARY';
  const invalid = [invalidTiming, { ...diagnosticV8(flowDetail('retirement_drain', 'helper_not_found')), version: 9 },
    { ...diagnosticV8({ ...flowDetail(), last: { stage: 'source_port', reason: 'entropy' } }), version: 9 }];
  for (const rounds of [0, 9, true, '1']) invalid.push({ ...diagnosticV8({ ...flowDetail(), rounds }), version: 9 });
  const missingFlow = { ...diagnosticV8(), version: 9 }; delete missingFlow.failures[0].agent_detail.flow_acquire; invalid.push(missingFlow);
  for (const diagnostics of invalid) {
    const result = await storePrivateFile('deposit', await fixture(t, diagnostics, { tlsCloseDiagnosticsV9: true }));
    assert.equal(result.code, 'invalid_core_report');
    assert.equal(result.storage, null);
  }
});

test('Cloud v9 config is strict, exclusive and does not add its flag to historical modes', async t => {
  for (const diagnostics of [DIAGNOSTICS, { ...diagnosticV4(), version: 6 }, diagnosticV7(), diagnosticV8()]) {
    const config = { tlsCloseDiagnosticsV9: false,
      ...(diagnostics.version === 7 ? { appendDiagnosticsV7: true } : {}),
      ...(diagnostics.version === 8 ? { flowAcquireDiagnosticsV8: true } : {}) };
    const result = await storePrivateFile('deposit', await fixture(t, diagnostics, config));
    assert.deepEqual(result.storage.deposit_diagnostics, diagnostics);
    const unsolicited = await storePrivateFile('deposit', await fixture(t, diagnosticV9(), config));
    assert.equal(unsolicited.code, 'invalid_core_report');
    if (diagnostics.version >= 4) {
      const wrong = { ...diagnosticV9(), version: diagnostics.version };
      assert.equal((await storePrivateFile('deposit', await fixture(t, wrong, config))).code, 'invalid_core_report');
    }
  }
  for (const value of [null, 'true', 1, 0, [], {}]) {
    await assert.rejects(storePrivateFile('deposit', await fixture(t, diagnosticV9(), { tlsCloseDiagnosticsV9: value })),
      { code: 'invalid_configuration' });
  }
  for (const other of ['appendDiagnosticsV7', 'flowAcquireDiagnosticsV8']) {
    await assert.rejects(storePrivateFile('deposit', await fixture(t, diagnosticV9(), { tlsCloseDiagnosticsV9: true, [other]: true })),
      { code: 'invalid_configuration' });
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
