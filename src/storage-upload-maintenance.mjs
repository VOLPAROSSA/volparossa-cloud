// SPDX-License-Identifier: GPL-3.0-only
// Finite owner admission reservations, never a peer scheduler or replica ledger.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { CoreStorage } from '../vendor/volparossa-image/core-storage.mjs';

const CHARGE_MAX = 512 * 1024 ** 3;
const MAX_SECONDS = 2678400;
const HASH = /^[0-9a-f]{64}$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const POLICY_KEYS = ['version', 'expiresAt', 'maxSessions', 'maxChargedBytes', 'perArchiveMaxChargedBytes',
  'fromProviderKey', 'lifetimeSeconds', 'renewBeforeSeconds', 'maximumTurnBytes', 'existing'];
function check(value, code = 'INVALID_STORAGE_MAINTENANCE') {
  if (!value) throw Object.assign(new Error(code), { name: 'StorageMaintenanceError', code });
}
function keys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function canonical(path) {
  check(typeof path === 'string' && path.length <= 4096 && path !== '/' && isAbsolute(path)
    && normalize(path) === path && !/[\x00-\x1f\x7f]/u.test(path));
  return path;
}
async function directory(path) {
  canonical(path);
  const info = await lstat(path);
  check(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o7777) === 0o700
    && await realpath(path) === path, 'PRIVATE_MAINTENANCE_DIRECTORY_REQUIRED');
}
async function retained(path, maximum = 65536) {
  canonical(path); await directory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    check(before.isFile() && before.uid === BigInt(process.getuid()) && before.nlink === 1n
      && (before.mode & 0o7777n) === 0o600n && before.size > 0n && before.size <= BigInt(maximum), 'MAINTENANCE_INPUT_INVALID');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    check(offset === Number(before.size) && ['dev', 'ino', 'size', 'uid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs']
      .every(key => before[key] === after[key] && after[key] === named[key]), 'MAINTENANCE_INPUT_CHANGED');
    return { bytes: bytes.subarray(0, offset), sha256: hash(bytes.subarray(0, offset)) };
  } finally { await file.close(); }
}
async function json(path, maximum) {
  const record = await retained(path, maximum);
  return { ...record, value: JSON.parse(record.bytes) };
}
async function absent(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function durableIntent(root, value) {
  const target = join(root, 'MAINTENANCE.json');
  const stage = join(root, `.MAINTENANCE-${randomBytes(16).toString('hex')}.tmp`);
  check(await absent(target), 'MAINTENANCE_INTENT_EXISTS');
  const bytes = encode(value);
  check(bytes.length <= 32768, 'MAINTENANCE_INTENT_BOUND');
  try {
    const fd = await open(stage, 'wx', 0o600);
    try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
    // The upload workspace flock and registry admission lock cover this rename.
    await rename(stage, target);
    const parent = await open(root, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(stage, { force: true }); }
}

export function validateUploadMaintenance(value) {
  check(keys(value, POLICY_KEYS) && value.version === 2
    && integer(value.expiresAt, 1, Number.MAX_SAFE_INTEGER)
    && integer(value.maxSessions, 1, 8) && integer(value.maxChargedBytes, 1, 8 * CHARGE_MAX)
    && integer(value.perArchiveMaxChargedBytes, 1, Math.min(CHARGE_MAX, value.maxChargedBytes))
    && HASH.test(value.fromProviderKey) && integer(value.lifetimeSeconds, 1, MAX_SECONDS)
    && integer(value.renewBeforeSeconds, 1, MAX_SECONDS) && integer(value.maximumTurnBytes, 1, 134217728)
    && Array.isArray(value.existing) && value.existing.length <= 8);
  const existing = value.existing.map(entry => {
    check(keys(entry, ['config', 'enrollment']));
    return Object.freeze({ config: canonical(entry.config), enrollment: canonical(entry.enrollment) });
  });
  check(new Set(existing.map(entry => entry.config)).size === existing.length
    && new Set(existing.map(entry => entry.enrollment)).size === existing.length);
  return Object.freeze({ ...value, existing: Object.freeze(existing) });
}

export async function openUploadMaintenance(value, { signal,
  storageFactory = path => CoreStorage.open(path), now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const policy = validateUploadMaintenance(value);
  const records = new Map(), byConfig = new Map(), cores = new Set(), opening = new Set();
  let closed = false, closing, admitting = false, activated = false;
  const active = () => check(!closed && !signal?.aborted, 'STORAGE_MAINTENANCE_CLOSED');
  const charged = () => [...records.values()].reduce((sum, entry) => sum + entry.ceiling, 0);
  const bounded = () => records.size <= policy.maxSessions && charged() <= policy.maxChargedBytes
    && ![...records.values()].some(entry => entry.unknown);
  const admit = () => {
    active();
    check(policy.expiresAt > now() && policy.expiresAt - now() <= MAX_SECONDS, 'MAINTENANCE_POLICY_EXPIRED');
    check(bounded(), 'MAINTENANCE_ADMISSION_UNCERTAIN');
  };
  const own = async config => {
    active();
    if (byConfig.has(config)) return byConfig.get(config);
    const pending = (async () => {
      const core = await storageFactory(config);
      cores.add(core); byConfig.set(config, core);
      active(); return core;
    })();
    opening.add(pending);
    try { return await pending; } finally { opening.delete(pending); }
  };
  const configRecord = async config => {
    const data = await json(config);
    canonical(data.value.stateDirectory);
    return data;
  };
  async function enrollment(entry) {
    const path = join(entry.enrollment, 'enrollment.json');
    const before = await json(path, 32768);
    const result = await entry.core.maintenanceStatus({ enrollment: entry.enrollment }, { signal });
    const after = await json(path, 32768);
    check(before.sha256 === after.sha256 && result.status === 'complete', 'MAINTENANCE_ENROLLMENT_UNCONFIRMED');
    const authority = after.value.enrollment;
    check(authority?.version === 1 && authority.archive === entry.state
      && integer(authority.maximum_charged, 1, CHARGE_MAX)
      && integer(authority.expires, 1, Number.MAX_SAFE_INTEGER), 'MAINTENANCE_AUTHORITY_MISMATCH');
    if (entry.intent) {
      const selected = entry.intent.providers.filter(provider => provider.key !== entry.intent.fromProviderKey);
      check(authority.expires === entry.intent.expiresAt
        && authority.maximum_charged === entry.intent.maximumChargedBytes
        && authority.lifetime === entry.intent.lifetimeSeconds
        && authority.renew_before === entry.intent.renewBeforeSeconds
        && authority.maximum_turn === entry.intent.maximumTurnBytes
        && Buffer.from(authority.source).toString('hex') === entry.intent.fromProviderKey
        && Array.isArray(authority.providers) && Array.isArray(authority.grants)
        && authority.providers.length === selected.length && authority.grants.length === selected.length
        && selected.every((provider, index) => Buffer.from(authority.providers[index]).toString('hex') === provider.key
          && typeof authority.grants[index] === 'string' && /^(?:[0-9a-f]{2}){1,2048}$/u.test(authority.grants[index])
          && hash(Buffer.from(authority.grants[index], 'hex')) === provider.sha256), 'MAINTENANCE_AUTHORITY_MISMATCH');
    }
    return { authority, sha256: after.sha256 };
  }
  async function start(entry) {
    if (entry.session || entry.unknown) return;
    try {
      if (entry.intent) await unchanged(entry);
      const bound = await enrollment(entry);
      check(bound.authority.maximum_charged === entry.ceiling, 'MAINTENANCE_AUTHORITY_MISMATCH');
      entry.expiresAt = bound.authority.expires;
      if (entry.expiresAt <= now()) { entry.stateName = 'expired'; return; }
      check(bounded(), 'MAINTENANCE_ADMISSION_UNCERTAIN');
      entry.session = await entry.core.startMaintenance({ enrollment: entry.enrollment }, { signal });
      entry.stateName = 'active';
      entry.session.done.then(() => {
        entry.session = null;
        entry.stateName = entry.expiresAt <= now() ? 'expired' : 'degraded';
      }, () => { entry.session = null; entry.stateName = 'degraded'; });
    } catch {
      entry.stateName = 'degraded';
      // Missing enrollment is an expected interrupted deposit. An existing but
      // unverifiable/mismatched authorization may carry unknown obligations.
      try { if (!await absent(entry.enrollment)) entry.unknown = true; }
      catch { entry.unknown = true; }
    }
  }
  async function unchanged(entry) {
    const intent = await json(join(entry.root, 'MAINTENANCE.json'), 32768);
    check(intent.sha256 === entry.intentHash, 'MAINTENANCE_INTENT_CHANGED');
    check((await retained(entry.config)).sha256 === entry.intent.configSha256, 'MAINTENANCE_CONFIG_CHANGED');
    for (const provider of entry.intent.providers) {
      check((await retained(provider.grant, 2048)).sha256 === provider.sha256, 'MAINTENANCE_GRANT_CHANGED');
    }
  }
  async function recover({ root, catalogSha256, cipherSha256, cipherBytes }) {
    active(); await directory(root);
    const config = join(root, 'core.json'), path = join(root, 'MAINTENANCE.json');
    if (await absent(path)) {
      // Pre-v2 archives are never silently enrolled. Unknown obligations block
      // new admissions, while ordinary reads and owner cleanup stay possible.
      if (!await absent(join(root, 'journal'))) {
        const state = join(root, 'journal');
        if (!records.has(state)) records.set(state, { state, ceiling: policy.maxChargedBytes,
          unknown: true, stateName: 'degraded', expiresAt: 0 });
      }
      return;
    }
    const original = await json(path, 32768), intent = original.value;
    check(keys(intent, ['version', 'kind', 'expiresAt', 'maximumChargedBytes', 'configSha256',
      'catalogSha256', 'cipherSha256', 'cipherBytes', 'fromProviderKey', 'providers',
      'lifetimeSeconds', 'renewBeforeSeconds', 'maximumTurnBytes'])
      && intent.version === 1 && intent.kind === 'cloud-upload-maintenance-intent'
      && integer(intent.expiresAt, 1, Number.MAX_SAFE_INTEGER)
      && integer(intent.maximumChargedBytes, 1, CHARGE_MAX)
      && HASH.test(intent.configSha256) && HASH.test(intent.catalogSha256) && HASH.test(intent.cipherSha256)
      && intent.catalogSha256 === catalogSha256 && intent.cipherSha256 === cipherSha256
      && intent.cipherBytes === cipherBytes && integer(cipherBytes, 1, 8 * 1024 ** 3)
      && intent.maximumChargedBytes >= 2 * cipherBytes && HASH.test(intent.fromProviderKey)
      && integer(intent.lifetimeSeconds, 1, MAX_SECONDS) && integer(intent.renewBeforeSeconds, 1, MAX_SECONDS)
      && integer(intent.maximumTurnBytes, 1, 134217728) && Array.isArray(intent.providers)
      && intent.providers.length >= 3 && intent.providers.length <= 8, 'MAINTENANCE_INTENT_INVALID');
    for (const provider of intent.providers) check(keys(provider, ['key', 'grant', 'sha256'])
      && HASH.test(provider.key) && HASH.test(provider.sha256) && canonical(provider.grant), 'MAINTENANCE_INTENT_INVALID');
    check(new Set(intent.providers.map(provider => provider.key)).size === intent.providers.length
      && intent.providers.some(provider => provider.key === intent.fromProviderKey), 'MAINTENANCE_INTENT_INVALID');
    const configured = await configRecord(config), state = configured.value.stateDirectory;
    check(state === join(root, 'journal'), 'MAINTENANCE_STATE_MISMATCH');
    let entry = records.get(state);
    if (entry) {
      check(entry.config === config && entry.enrollment === join(root, 'maintenance')
        && entry.ceiling === intent.maximumChargedBytes, 'MAINTENANCE_DUPLICATE_AUTHORITY');
    } else {
      entry = { root, config, state, enrollment: join(root, 'maintenance'), ceiling: intent.maximumChargedBytes,
        core: await own(config), stateName: 'pending' };
      records.set(state, entry);
    }
    Object.assign(entry, { root, intent, intentHash: original.sha256, expiresAt: intent.expiresAt });
    try { await unchanged(entry); }
    catch { entry.unknown = true; entry.stateName = 'degraded'; }
    if (activated && bounded()) await start(entry);
  }
  async function reserve(input) {
    active(); check(!admitting, 'MAINTENANCE_ADMISSION_BUSY'); admitting = true;
    try {
      admit();
      const { root, catalogSha256, cipherSha256, cipherBytes } = input;
      await directory(root);
      const config = join(root, 'core.json');
      const configured = await configRecord(config), state = configured.value.stateDirectory;
      check(state === join(root, 'journal'), 'MAINTENANCE_STATE_MISMATCH');
      if (records.has(state)) {
        const entry = records.get(state);
        check(entry.intent && entry.intent.catalogSha256 === catalogSha256
          && entry.intent.cipherSha256 === cipherSha256 && entry.intent.cipherBytes === cipherBytes,
        'MAINTENANCE_PENDING_MISMATCH');
        await unchanged(entry);
        check(entry.intent.expiresAt > now(), 'MAINTENANCE_POLICY_EXPIRED');
        return;
      }
      check(integer(cipherBytes, 1, 8 * 1024 ** 3) && HASH.test(catalogSha256) && HASH.test(cipherSha256)
        && policy.perArchiveMaxChargedBytes >= 2 * cipherBytes, 'MAINTENANCE_ARCHIVE_CEILING');
      check(records.size < policy.maxSessions
        && charged() + policy.perArchiveMaxChargedBytes <= policy.maxChargedBytes, 'MAINTENANCE_CAPACITY');
      const providers = configured.value.providers;
      check(Array.isArray(providers) && providers.length >= 3 && providers.length <= 8
        && providers.some(provider => provider.key === policy.fromProviderKey), 'MAINTENANCE_PROVIDER_TEMPLATE');
      const retainedProviders = [];
      for (const provider of providers) {
        check(keys(provider, ['key', 'grant']) && HASH.test(provider.key), 'MAINTENANCE_PROVIDER_TEMPLATE');
        retainedProviders.push({ ...provider, sha256: (await retained(provider.grant, 2048)).sha256 });
      }
      check(new Set(providers.map(provider => provider.key)).size === providers.length, 'MAINTENANCE_PROVIDER_TEMPLATE');
      admit();
      const intent = { version: 1, kind: 'cloud-upload-maintenance-intent', expiresAt: policy.expiresAt,
        maximumChargedBytes: policy.perArchiveMaxChargedBytes, configSha256: configured.sha256,
        catalogSha256, cipherSha256, cipherBytes, fromProviderKey: policy.fromProviderKey,
        providers: retainedProviders, lifetimeSeconds: policy.lifetimeSeconds,
        renewBeforeSeconds: policy.renewBeforeSeconds, maximumTurnBytes: policy.maximumTurnBytes };
      const entry = { root, config, state, enrollment: join(root, 'maintenance'), intent,
        ceiling: intent.maximumChargedBytes, expiresAt: intent.expiresAt, stateName: 'pending',
        core: await own(config) };
      records.set(state, entry); // Keep this reservation even if persistence fails.
      try { await durableIntent(root, intent); entry.intentHash = hash(encode(intent)); }
      catch (error) { entry.unknown = true; entry.stateName = 'degraded'; throw error; }
    } finally { admitting = false; }
  }
  async function complete(root, { signal: requestSignal } = {}) {
    active();
    requestSignal?.throwIfAborted();
    const entry = records.get(join(root, 'journal'));
    check(entry?.intent && !entry.unknown, 'MAINTENANCE_ADMISSION_UNCONFIRMED');
    await unchanged(entry);
    check(entry.intent.expiresAt > now() && bounded(), 'MAINTENANCE_POLICY_EXPIRED');
    if (await absent(entry.enrollment)) {
      const i = entry.intent;
      const operationSignal = signal && requestSignal ? AbortSignal.any([signal, requestSignal]) : requestSignal ?? signal;
      operationSignal?.throwIfAborted();
      const result = await entry.core.enrollMaintenance({ enrollment: entry.enrollment,
        fromProviderKey: i.fromProviderKey, providers: i.providers.filter(p => p.key !== i.fromProviderKey)
          .map(({ key, grant }) => ({ key, grant })), authorizationSeconds: MAX_SECONDS,
        authorizationExpiresAt: i.expiresAt, lifetimeSeconds: i.lifetimeSeconds,
        renewBeforeSeconds: i.renewBeforeSeconds, maximumChargedBytes: i.maximumChargedBytes,
        maximumTurnBytes: i.maximumTurnBytes }, { signal: operationSignal });
      check(result.status === 'complete' && result.local_process_joined === true, 'MAINTENANCE_ENROLLMENT_UNCONFIRMED');
    }
    requestSignal?.throwIfAborted();
    await start(entry);
    check(entry.session && entry.stateName === 'active', 'MAINTENANCE_START_UNCONFIRMED');
  }
  async function recoverVisible(input) {
    try { await recover(input); }
    catch {
      active(); canonical(input.root);
      const state = join(input.root, 'journal'), entry = records.get(state);
      if (entry) { entry.unknown = true; entry.stateName = 'degraded'; }
      else records.set(state, { state, ceiling: policy.maxChargedBytes,
        unknown: true, stateName: 'degraded', expiresAt: 0 });
    }
  }
  const close = () => {
    if (!closing) {
      closed = true; signal?.removeEventListener('abort', abort);
      closing = (async () => {
        await Promise.allSettled([...opening]);
        const results = await Promise.allSettled([...cores].map(core => core.close()));
        check(results.every(result => result.status === 'fulfilled'), 'STORAGE_MAINTENANCE_CLEANUP_UNCONFIRMED');
      })();
    }
    return closing;
  };
  const abort = () => { close().catch(() => {}); };
  try {
    active();
    for (const selected of policy.existing) {
      const config = await configRecord(selected.config), state = config.value.stateDirectory;
      const duplicate = records.get(state);
      if (duplicate) {
        check(duplicate.enrollment === selected.enrollment && duplicate.configHash === config.sha256,
          'MAINTENANCE_DUPLICATE_AUTHORITY');
        byConfig.set(selected.config, duplicate.core); continue;
      }
      const entry = { ...selected, state, configHash: config.sha256, core: await own(selected.config),
        ceiling: policy.maxChargedBytes, unknown: true, expiresAt: 0, stateName: 'degraded' };
      records.set(state, entry);
      try {
        const bound = await enrollment(entry);
        entry.ceiling = bound.authority.maximum_charged; entry.expiresAt = bound.authority.expires;
        entry.unknown = false; entry.stateName = 'pending';
      } catch { /* An unverifiable obligation reserves the whole budget; no new authority. */ }
    }
    signal?.addEventListener('abort', abort, { once: true }); active();
    return Object.freeze({ version: 2, reserve, recover: recoverVisible, complete,
      async checkCharge(root, storage) {
        active();
        const entry = records.get(join(root, 'journal'));
        check(entry?.intent && !entry.unknown, 'MAINTENANCE_ADMISSION_UNCONFIRMED');
        await unchanged(entry);
        check(entry.intent.expiresAt > now(), 'MAINTENANCE_POLICY_EXPIRED');
        check(integer(storage?.physical_payload_charge_upper_bound, 0, entry.ceiling)
          && storage.logical_ciphertext_bytes === entry.intent.cipherBytes, 'MAINTENANCE_CHARGE_BOUND');
      },
      storageFactory: async path => { active(); canonical(path); return byConfig.get(path) ?? storageFactory(path); },
      async activate() { active(); activated = true; if (bounded()) for (const entry of records.values()) await start(entry); },
      async status() {
        active();
        return Object.freeze({ version: 2, kind: 'cloud-owner-storage-maintenance',
          automatic_enrollment: true, automatic_grant_refresh: false, expires_at: policy.expiresAt,
          new_authorization_allowed: policy.expiresAt > now() && policy.expiresAt - now() <= MAX_SECONDS
            && bounded() && records.size < policy.maxSessions
            && charged() + policy.perArchiveMaxChargedBytes <= policy.maxChargedBytes,
          configured_sessions: records.size, maximum_sessions: policy.maxSessions,
          reserved_archive_ceiling_bytes: charged(), maximum_charged_bytes: policy.maxChargedBytes,
          sessions: Object.freeze([...records.values()].map(entry => Object.freeze({
            state: entry.expiresAt && entry.expiresAt <= now() ? 'expired' : entry.stateName,
            reserved_ceiling_bytes: entry.ceiling, expires_at: entry.expiresAt,
            owned_session: !!entry.session, authority_uncertain: !!entry.unknown,
            accounting_is_reservation_not_measured_charge: true }))) });
      }, close });
  } catch (error) { await close(); throw error; }
}
