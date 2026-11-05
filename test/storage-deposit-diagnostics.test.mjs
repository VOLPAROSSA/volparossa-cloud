// SPDX-License-Identifier: GPL-3.0-only
// Hosted-only contracts: actual Cloud consumer/default SDK/owned Node child,
// fabricated CLI reports and opaque synthetic bytes. No GPG, core or peer proof.
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
const SELECTORS = [
  ['appendDiagnosticsV7', '--append-diagnostics-v7', 7],
  ['flowAcquireDiagnosticsV8', '--flow-acquire-diagnostics-v8', 8],
  ['tlsCloseDiagnosticsV9', '--tls-close-diagnostics-v9', 9],
  ['challengeReadDiagnosticsV10', '--challenge-read-diagnostics-v10', 10],
];
function diagnostic(version) {
  const failure = { fragment_index: 1, copy_index: 0, operation: 'append', stage: 'wire_receipt',
    category: 'io', agent_code: null, agent_detail: null, agent_outcome: null };
  if (version === 7) failure.agent_outcome = { status: 'observed',
    detail: { phase: 'remote_receipt_read', category: 'io', deadline_scope: 'none' },
    append_timing: { before_payload: 'under_1s', in_payload_write_flush: '1_to_5s', in_receipt_read: '90_to_120s' } };
  if (version === 8) Object.assign(failure, { operation: 'reserve', stage: 'agent_ready', category: 'agent_rejected',
    agent_code: 'CONTENT_UNAVAILABLE', agent_detail: { stage: 'stream_open', deadline_scope: 'none', tls_failure: null,
      stream_failure: 'flow_acquire', challenge: null, flow_acquire: { rounds: 2,
        first: { stage: 'helper_acquire', reason: 'helper_capacity' },
        last: { stage: 'retirement_drain', reason: 'helper_cleanup_incomplete' } } } });
  if (version === 9) Object.assign(failure, { stage: 'agent_terminal', agent_outcome: { status: 'observed',
    detail: { phase: 'transport_tls_close', category: 'unavailable', deadline_scope: 'none' },
    append_timing: null, tls_close_failure: 'read_io' } });
  if (version === 10) Object.assign(failure, { stage: 'agent_ready', category: 'agent_rejected',
    agent_code: 'CONTENT_UNAVAILABLE', agent_detail: { stage: 'challenge', deadline_scope: 'operation',
      tls_failure: null, stream_failure: null, flow_acquire: null, challenge: { phase: 'challenge_read_verify',
        before_challenge: '1_to_5s', in_challenge: '90_to_120s', read: { step: 'body_read', returned_outcome: null } } } });
  return { version, failures: [failure], omitted_failures: 0 };
}
function rawReport(operation, diagnostics) {
  return {
    operation: `private_storage_fragments_${operation}`,
    ...(operation === 'deposit' ? { operation_complete: false } : {}),
    logical_ciphertext_bytes: 96, fragment_count: 3, copies_per_fragment: 2,
    distinct_provider_identities: 3, reserved_payload_bytes: 0, committed_payload_bytes: 0,
    uncertain_payload_bytes: 192, physical_payload_charge_upper_bound: 192,
    metadata_overhead_measured: false, expired_copies_remain_charged: true,
    fragments_with_confirmed_unexpired_copy: 0, fully_redundant_from_retained_receipts: false,
    current_remote_availability_proven: false, independent_failure_domains_proven: false,
    network_contribution_credit: false, automatic_repair: false, automatic_handoff: false,
    read_consumes_archive: false, erasure_coding: false, owner_signature_verified: true,
    providers: KEYS.map(provider_key => ({ provider_key, physical_payload_charge_upper_bound: 64 })),
    fragments: KEYS.map((_, index) => ({ index, offset: index * 32, ciphertext_bytes: 32,
      confirmed_unexpired_copies: 0, copies: [0, 1].map(copy => ({ provider_key: KEYS[(index + copy) % 3], charge: 'uncertain' })) })),
    ...(diagnostics === undefined ? {} : { deposit_diagnostics: diagnostics }),
    private_error: 'PRIVATE-REPORT-CANARY /private/owner',
  };
}
async function fixture(t, configChanges = {}, operation = 'deposit') {
  const root = await mkdtemp(join(tmpdir(), 'cloud-diagnostic-contract-'));
  await chmod(root, 0o700);
  const socket = join(root, 'control.sock');
  const server = createServer(connection => connection.destroy());
  server.listen(socket); await once(server, 'listening'); await chmod(socket, 0o600);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true });
  });
  const state = join(root, 'journal');
  if (operation !== 'create') await mkdir(state, { mode: 0o700 });
  const bundle = join(root, 'bundle'); await mkdir(bundle, { mode: 0o700 });
  await writeFile(join(bundle, 'file.pgp'), CIPHER, { mode: 0o600 });
  await writeFile(join(bundle, 'receipt.json'), JSON.stringify({ version: 2,
    kind: 'volparossa-cloud-private-file', cipher_file: 'file.pgp', cipher_bytes: 96,
    cipher_sha256: createHash('sha256').update(CIPHER).digest('hex'), encryption: 'OpenPGP-AES256',
    source_consistency: 'owner-upload-snapshot',
  }), { mode: 0o600 });
  for (const name of ['identity', 'passphrase', 'grant0', 'grant1', 'grant2']) {
    await writeFile(join(root, name), 'synthetic-private-fixture-only', { mode: 0o600 });
  }
  const reply = join(root, 'reply.json');
  const argv = join(root, 'argv.private.jsonl');
  const binary = join(root, 'synthetic-core');
  // The sidecar belongs only to this private disposable test fixture; no raw
  // argv, private path or report is exposed through the Cloud result.
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[4] !== ${JSON.stringify(operation)}) process.exit(17);
fs.appendFileSync(${JSON.stringify(argv)}, JSON.stringify(args) + '\\n', { mode: 0o600 });
const reply = JSON.parse(fs.readFileSync(${JSON.stringify(reply)}, 'utf8'));
process.stdout.write(reply.text === undefined ? JSON.stringify(reply.raw) : reply.text);
process.exitCode = reply.code;
`, { mode: 0o700 });
  const config = join(root, 'core.json');
  const configuration = { version: 1, coreBinary: binary, controlSocket: socket,
    identity: join(root, 'identity'), passphraseFile: join(root, 'passphrase'), stateDirectory: state,
    providers: KEYS.map((key, index) => ({ key, grant: join(root, `grant${index}`) })),
    fragmentBytes: 32, lifetimeSeconds: 600, deadlineMs: 3000, ...configChanges };
  await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
  return { root, state, bundle, config, configuration, argv,
    reply: value => writeFile(reply, JSON.stringify(value), { mode: 0o600 }),
    arguments: async () => (await readFile(argv, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
async function originalMainStore(operation, value) {
  // Readable, exact Cloud-main bdc9c914f4687f25396e23f322d5fa27e183ce8a SDK.
  const source = new URL('./fixtures/core-storage-default-bdc9c914.mjs', import.meta.url);
  const bytes = await readFile(source);
  assert.equal(bytes.length, 20915);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    'd274c294a4f7c500aac552629997487c79e67faaa89dddd1383309d7e58273b0');
  const { CoreStorage } = await import(source.href);
  const original = { ...value.configuration };
  for (const [key] of SELECTORS) delete original[key];
  await writeFile(value.config, JSON.stringify(original));
  try { return await storePrivateFile(operation, value, { storageFactory: config => CoreStorage.open(config) }); }
  finally { await writeFile(value.config, JSON.stringify(value.configuration)); }
}
function privateResult(result, value) {
  assert.equal(result.local_process_joined, true);
  assert.equal(result.remote_cleanup_confirmed, false);
  for (const canary of [value.root, ...KEYS, 'PRIVATE-REPORT-CANARY', 'PRIVATE-DIAGNOSTIC-CANARY']) {
    assert.ok(!JSON.stringify(result).includes(canary));
  }
}
function frozen(value) {
  if (value !== null && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
  }
}

test('Cloud absent and all-false selectors preserve exact main results and child argv for unsolicited diagnostics', async t => {
  const modes = [{}, Object.fromEntries(SELECTORS.map(([key]) => [key, false]))];
  const diagnostics = [undefined, null, {}, { raw: 'PRIVATE-DIAGNOSTIC-CANARY' },
    { version: 1, failures: [], omitted_failures: 0 }, ...SELECTORS.map(([, , version]) => diagnostic(version)),
    { version: 11, failures: [], omitted_failures: 0 }];
  for (const configChanges of modes) {
    const value = await fixture(t, configChanges);
    for (const current of diagnostics) {
      await value.reply({ raw: rawReport('deposit', current), code: 1 });
      const actual = await storePrivateFile('deposit', value);
      const baseline = await originalMainStore('deposit', value);
      assert.deepEqual(actual, baseline); assert.equal(JSON.stringify(actual), JSON.stringify(baseline));
      const args = await value.arguments(); assert.deepEqual(args.at(-2), args.at(-1));
      assert.equal(args.at(-2).some(arg => SELECTORS.some(([, flag]) => arg === flag)), false);
      assert.equal(Object.hasOwn(actual.storage, 'deposit_diagnostics'), false);
      assert.equal(actual.status, 'incomplete'); assert.equal(actual.storage.uncertain_payload_bytes, 192);
      privateResult(actual, value);
    }
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
    assert.equal((await lstat(value.state)).isDirectory(), true);
  }
});

test('Cloud default malformed JSON, accounting and exit errors match unchanged main without leaking diagnostic text', async t => {
  const value = await fixture(t);
  const invalidAccounting = rawReport('deposit', { raw: 'PRIVATE-DIAGNOSTIC-CANARY' });
  invalidAccounting.physical_payload_charge_upper_bound++;
  for (const reply of [{ text: 'PRIVATE-REPORT-CANARY', code: 1 }, { raw: invalidAccounting, code: 1 },
    { raw: rawReport('deposit', diagnostic(10)), code: 0 }]) {
    await value.reply(reply);
    const actual = await storePrivateFile('deposit', value);
    assert.deepEqual(actual, await originalMainStore('deposit', value));
    assert.equal(actual.code, 'invalid_core_report'); assert.equal(actual.storage, null);
    const args = await value.arguments(); assert.deepEqual(args.at(-2), args.at(-1));
    privateResult(actual, value);
  }
});

test('Cloud consumer and CLI forward each explicit selector through the actual default adapter and joined child', async t => {
  for (const [key, flag, version] of SELECTORS) {
    const value = await fixture(t, { [key]: true });
    const expected = diagnostic(version);
    await value.reply({ raw: rawReport('deposit', expected), code: 1 });
    const result = await storePrivateFile('deposit', value);
    const cli = await runCloudFile({ operation: 'deposit', config: value.config, bundle: value.bundle });
    assert.deepEqual(result, cli); assert.equal(result.status, 'incomplete');
    assert.equal(result.code, 'retained_operation_incomplete');
    assert.deepEqual(result.storage.deposit_diagnostics, expected);
    frozen(result.storage.deposit_diagnostics); privateResult(result, value);
    assert.equal(result.storage.uncertain_payload_bytes, 192);
    const args = await value.arguments(); assert.deepEqual(args[0], args[1]);
    assert.deepEqual(args[0], ['--control-socket', value.configuration.controlSocket, 'storage', 'fragments', 'deposit',
      '--state', value.state, flag, '--identity', value.configuration.identity, '--passphrase-file', value.configuration.passphraseFile,
      '--input', join(value.bundle, 'file.pgp'), '--already-encrypted']);
    const { deposit_diagnostics, ...accounting } = result.storage;
    const baseline = await originalMainStore('deposit', value);
    assert.deepEqual(accounting, baseline.storage); assert.deepEqual({ ...result, storage: accounting }, baseline);
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud create keeps every configured selector inactive and ignores malformed diagnostics exactly as main', async t => {
  for (const [key] of SELECTORS) {
    const value = await fixture(t, { [key]: true }, 'create');
    await value.reply({ raw: rawReport('create', { raw: 'PRIVATE-DIAGNOSTIC-CANARY' }), code: 0 });
    const actual = await storePrivateFile('create', value);
    assert.deepEqual(actual, await originalMainStore('create', value));
    assert.equal(actual.status, 'complete'); assert.equal(Object.hasOwn(actual.storage, 'deposit_diagnostics'), false);
    const args = await value.arguments(); assert.deepEqual(args[0], args[1]);
    assert.equal(args[0].some(arg => SELECTORS.some(([, flag]) => arg === flag)), false);
    assert.equal(args[0].filter(arg => arg === '--provider-key').length, 3);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
    privateResult(actual, value);
  }
});

test('Cloud selected deposits require exact version and closed fields without weakening custody or errors', async t => {
  for (const [key, flag, version] of SELECTORS) {
    const value = await fixture(t, { [key]: true });
    // Establish that this fixture can actually return a valid selected report;
    // a broken child must not make every negative case pass as a generic error.
    const valid = diagnostic(version);
    await value.reply({ raw: rawReport('deposit', valid), code: 1 });
    const positive = await storePrivateFile('deposit', value);
    assert.equal(positive.code, 'retained_operation_incomplete');
    assert.deepEqual(positive.storage.deposit_diagnostics, valid);
    privateResult(positive, value);
    let childCalls = 1;
    assert.equal((await value.arguments()).length, childCalls);
    const bad = diagnostic(version); bad.failures[0].raw = 'PRIVATE-DIAGNOSTIC-CANARY';
    const invalid = [undefined, null, bad, { ...diagnostic(version), version: 1 },
      { ...diagnostic(version), version: version === 10 ? 9 : 10 }, { ...diagnostic(version), version: 11 }];
    for (const current of invalid) {
      await value.reply({ raw: rawReport('deposit', current), code: 1 });
      const result = await storePrivateFile('deposit', value);
      assert.equal(result.code, 'invalid_core_report'); assert.equal(result.storage, null);
      const calls = await value.arguments();
      assert.equal(calls.length, ++childCalls);
      assert.equal(calls.at(-1)[7], flag);
      privateResult(result, value);
    }
    assert.equal((await lstat(value.state)).isDirectory(), true);
    assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
  }
});

test('Cloud v10 retains whole challenge buckets and nullable wire outcome without asserting a remote cause', async t => {
  const value = await fixture(t, { challengeReadDiagnosticsV10: true });
  for (const read of [null, { step: 'length_read', returned_outcome: 'io_eof' },
    { step: 'body_read', returned_outcome: null }, { step: 'verification', returned_outcome: 'verification_rejected' }]) {
    const current = diagnostic(10); current.failures[0].agent_detail.challenge.read = read;
    await value.reply({ raw: rawReport('deposit', current), code: 1 });
    const result = await runCloudFile({ operation: 'deposit', config: value.config, bundle: value.bundle });
    assert.deepEqual(result.storage.deposit_diagnostics, current);
    assert.equal(result.storage.deposit_diagnostics.failures[0].agent_detail.challenge.before_challenge, '1_to_5s');
    assert.equal(result.storage.deposit_diagnostics.failures[0].agent_detail.challenge.in_challenge, '90_to_120s');
    frozen(result.storage.deposit_diagnostics); privateResult(result, value);
    assert.equal(result.status, 'incomplete');
  }
  const invalid = diagnostic(10); invalid.failures[0].agent_detail.challenge.phase = 'grant_write_flush';
  await value.reply({ raw: rawReport('deposit', invalid), code: 1 });
  const result = await storePrivateFile('deposit', value);
  assert.equal(result.code, 'invalid_core_report'); assert.equal(result.storage, null);
  privateResult(result, value);
});

test('Cloud configuration rejects mixed or nonboolean selectors before launching a child', async t => {
  const value = await fixture(t);
  for (const [key] of SELECTORS) for (const replacement of ['true', 1, null]) {
    await writeFile(value.config, JSON.stringify({ ...value.configuration, [key]: replacement }));
    await assert.rejects(storePrivateFile('deposit', value), { code: 'invalid_configuration' });
  }
  for (let first = 0; first < SELECTORS.length; first++) for (let second = first + 1; second < SELECTORS.length; second++) {
    await writeFile(value.config, JSON.stringify({ ...value.configuration, [SELECTORS[first][0]]: true, [SELECTORS[second][0]]: true }));
    await assert.rejects(storePrivateFile('deposit', value), { code: 'invalid_configuration' });
  }
  await assert.rejects(lstat(value.argv), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
});

test('Cloud ciphertext verification and cancellation stay ahead of selected diagnostic process authority', async t => {
  const value = await fixture(t, { challengeReadDiagnosticsV10: true });
  await writeFile(join(value.bundle, 'file.pgp'), Buffer.alloc(CIPHER.length, 0x55));
  await assert.rejects(storePrivateFile('deposit', value), { code: 'CIPHER_IDENTITY_MISMATCH' });
  await assert.rejects(originalMainStore('deposit', value), { code: 'CIPHER_IDENTITY_MISMATCH' });
  await writeFile(join(value.bundle, 'file.pgp'), CIPHER);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(storePrivateFile('deposit', value, { signal: cancel.signal }), { code: 'cancelled' });
  await assert.rejects(lstat(value.argv), { code: 'ENOENT' });
  assert.equal((await lstat(value.state)).isDirectory(), true);
  assert.deepEqual(await readFile(join(value.bundle, 'file.pgp')), CIPHER);
});
