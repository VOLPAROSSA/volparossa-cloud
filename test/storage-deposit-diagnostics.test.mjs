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
