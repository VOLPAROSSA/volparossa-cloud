// SPDX-License-Identifier: GPL-3.0-only
// Service-owned handles to existing core enrollments, not an app-side repair scheduler.
import { isAbsolute, normalize, sep } from 'node:path';
import { CoreStorage } from '../vendor/volparossa-image/core-storage.mjs';
import { openUploadMaintenance, validateUploadMaintenance } from './storage-upload-maintenance.mjs';

export class StorageMaintenanceError extends Error {
  constructor(code) { super(code); this.name = 'StorageMaintenanceError'; this.code = code; }
}
function check(value, code = 'INVALID_STORAGE_MAINTENANCE') {
  if (!value) throw new StorageMaintenanceError(code);
}
function canonical(value) {
  check(typeof value === 'string' && value.length <= 4096 && isAbsolute(value)
    && value !== sep && normalize(value) === value && !/[\x00-\x1f\x7f]/u.test(value));
  return value;
}
export function validateStorageMaintenance(value) {
  if (value?.version === 2) return validateUploadMaintenance(value);
  check(Array.isArray(value) && value.length > 0 && value.length <= 8);
  const entries = value.map(entry => {
    check(entry && typeof entry === 'object' && !Array.isArray(entry)
      && Object.keys(entry).sort().join(',') === 'config,enrollment');
    return Object.freeze({ config: canonical(entry.config), enrollment: canonical(entry.enrollment) });
  });
  check(new Set(entries.map(entry => entry.config)).size === entries.length
    && new Set(entries.map(entry => entry.enrollment)).size === entries.length);
  return Object.freeze(entries);
}

/** Start only the explicit, previously signed enrollments, with no grant creation or retries. */
export async function openStorageMaintenance(value, {
  signal, storageFactory = path => CoreStorage.open(path),
} = {}) {
  if (value?.version === 2) return openUploadMaintenance(value, { signal, storageFactory });
  const entries = validateStorageMaintenance(value);
  const owned = new Map();
  let closed = false, closing;
  const active = () => check(!closed && !signal?.aborted, 'STORAGE_MAINTENANCE_CLOSED');
  const close = () => {
    if (!closing) {
      closed = true;
      signal?.removeEventListener('abort', abort);
      closing = (async () => {
        // Attempt every owned close even when another child fails to join.
        const results = await Promise.allSettled([...owned.values()].map(async entry => entry.core.close()));
        check(results.every(result => result.status === 'fulfilled'), 'STORAGE_MAINTENANCE_CLEANUP_UNCONFIRMED');
      })();
    }
    return closing;
  };
  const abort = () => { close().catch(() => {}); }; // The retained close promise reports failures to the owner.
  try {
    active();
    for (const entry of entries) {
      const core = await storageFactory(entry.config);
      owned.set(entry.config, { core, enrollment: entry.enrollment });
      active();
      // CoreStorage owns pause/join/resume around foreground operations on this same object.
      await core.startMaintenance({ enrollment: entry.enrollment }, { signal });
      active();
    }
    signal?.addEventListener('abort', abort, { once: true });
    active();
    return Object.freeze({
      storageFactory: async path => {
        active();
        canonical(path);
        // Unenrolled catalog entries retain ordinary storage behavior; reading them never enrolls them.
        return owned.get(path)?.core ?? storageFactory(path);
      },
      async status() {
        active();
        const records = await Promise.all([...owned.values()].map(entry =>
          entry.core.maintenanceStatus({ enrollment: entry.enrollment }, { signal })));
        return Object.freeze({ version: 1, kind: 'cloud-owner-storage-maintenance',
          configured_sessions: entries.length, automatic_enrollment: false,
          automatic_grant_refresh: false, sessions: Object.freeze(records) });
      },
      close,
    });
  } catch (error) {
    await close();
    if (error instanceof StorageMaintenanceError) throw error;
    throw new StorageMaintenanceError('STORAGE_MAINTENANCE_START_FAILED');
  }
}
