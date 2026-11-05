// SPDX-License-Identifier: GPL-3.0-only
// Owner-process orchestration seams, not evidence of Rust or distributed storage execution.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openStorageMaintenance, validateStorageMaintenance } from '../src/storage-maintenance.mjs';

const ENTRIES = [{ config: '/private/core.json', enrollment: '/private/maintenance' }];
function fake() {
  const calls = [];
  const core = { startMaintenance: async (request, options) => { calls.push(['start', request, options]); },
    maintenanceStatus: async () => ({ stage: 'waiting_for_core', owned_process_running: true }),
    close: async () => { calls.push(['close']); } };
  return { core, calls };
}

test('explicit existing enrollment list is closed, canonical, unique and bounded', () => {
  assert.deepEqual(validateStorageMaintenance(ENTRIES), ENTRIES);
  for (const value of [[], {}, null, [ENTRIES[0], ENTRIES[0]],
    [{ ...ENTRIES[0], authorizationSeconds: 100 }], [{ ...ENTRIES[0], config: '/private/../core' }],
    [{ ...ENTRIES[0], enrollment: 'relative' }],
    Array.from({ length: 9 }, (_, i) => ({ config: `/private/c${i}`, enrollment: `/private/e${i}` }))]) {
    assert.throws(() => validateStorageMaintenance(value), { code: 'INVALID_STORAGE_MAINTENANCE' });
  }
});

test('same adapter is reused for foreground access; other access never enrolls itself', async () => {
  const f = fake(), opened = [];
  const other = {};
  const registry = await openStorageMaintenance(ENTRIES, { storageFactory: async path => {
    opened.push(path); return path === ENTRIES[0].config ? f.core : other;
  } });
  assert.deepEqual(f.calls[0][1], { enrollment: ENTRIES[0].enrollment });
  assert.equal(await registry.storageFactory(ENTRIES[0].config), f.core);
  assert.equal(await registry.storageFactory(ENTRIES[0].config), f.core);
  assert.equal(await registry.storageFactory('/private/unregistered.json'), other);
  assert.deepEqual(opened, [ENTRIES[0].config, '/private/unregistered.json']);
  const status = await registry.status();
  assert.equal(status.configured_sessions, 1);
  assert.equal(status.automatic_enrollment, false);
  assert.equal(JSON.stringify(status).includes('/private'), false);
  await Promise.all([registry.close(), registry.close()]);
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 1);
  await assert.rejects(registry.storageFactory(ENTRIES[0].config), { code: 'STORAGE_MAINTENANCE_CLOSED' });
});

test('partial startup joins all opened owners and does not invent replacement authorization', async () => {
  const a = fake(), b = fake();
  b.core.startMaintenance = async () => { throw new Error('private-secret-path'); };
  let count = 0;
  await assert.rejects(openStorageMaintenance([...ENTRIES,
    { config: '/private/second.json', enrollment: '/private/second-enrollment' }], {
    storageFactory: async () => ++count === 1 ? a.core : b.core,
  }), { code: 'STORAGE_MAINTENANCE_START_FAILED' });
  assert.equal(a.calls.at(-1)[0], 'close');
  assert.equal(b.calls.at(-1)[0], 'close');
  assert.equal(count, 2);
});

test('abort during open joins the late owner before returning and never starts it', async () => {
  const cancel = new AbortController(), f = fake();
  await assert.rejects(openStorageMaintenance(ENTRIES, { signal: cancel.signal,
    storageFactory: async () => { cancel.abort(); return f.core; },
  }), { code: 'STORAGE_MAINTENANCE_CLOSED' });
  assert.deepEqual(f.calls, [['close']]);
});

test('cleanup failure is retained while every owner is still asked to close', async () => {
  const a = fake(), b = fake(), cancel = new AbortController();
  a.core.close = async () => { throw new Error('private failure'); };
  let count = 0;
  const registry = await openStorageMaintenance([...ENTRIES,
    { config: '/private/b.json', enrollment: '/private/b-enrollment' }], {
    signal: cancel.signal, storageFactory: async () => ++count === 1 ? a.core : b.core,
  });
  cancel.abort();
  await assert.rejects(registry.close(), { code: 'STORAGE_MAINTENANCE_CLEANUP_UNCONFIRMED' });
  await assert.rejects(registry.close(), { code: 'STORAGE_MAINTENANCE_CLEANUP_UNCONFIRMED' });
  assert.equal(b.calls.at(-1)[0], 'close');
});
