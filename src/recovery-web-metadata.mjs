// SPDX-License-Identifier: GPL-3.0-only
// Actual owner-selected recovery catalog projection, not the origin's accounts,
// permissions or a substitute Graph service. Called only after local bearer auth.
import { recoverySpaceId, isRecoverySpaceId } from './private-resource-id.mjs';
const OWNER = Object.freeze({ id: 'volparossa-owner-recovery', displayName: 'Private recovery' });
export class RecoveryMetadataError extends Error {
  constructor(status) { super('Recovery metadata request rejected'); this.status = status; }
}
const check = (value, status = 400) => { if (!value) throw new RecoveryMetadataError(status); };
const part = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !['.', '..'].includes(value) && !/[\\/\x00-\x1f\x7f]/u.test(value);

function query(url, permitted = {}) {
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    check(!seen.has(key) && Object.hasOwn(permitted, key) && permitted[key].includes(value));
    seen.add(key);
  }
}

function capabilities() {
  return { ocs: { meta: { status: 'ok', statuscode: 100, message: 'OK' }, data: {
    version: { major: '0', minor: '1', micro: '0', string: 'owner-recovery' }, capabilities: {
      core: { 'support-sse': false, 'support-radicale': false, 'check-for-updates': false,
        status: { edition: 'owner-recovery', product: 'VOLPAROSSA private recovery',
          productversion: '0.1.0-owner-recovery' } },
      dav: { reports: [], trashbin: '' },
      files: { app_providers: [], archivers: [], permanent_deletion: false, undelete: false,
        versioning: false, privateLinks: false, tags: false, thumbnail: { enabled: false } },
      files_sharing: { api_enabled: false, allow_custom: false, can_rename: false,
        public: { enabled: false, can_edit: false, can_contribute: false } },
      graph: { 'personal-data-export': false, users: { create_disabled: true, delete_disabled: true,
        change_password_self_disabled: true, edit_login_allowed_disabled: true } },
      notifications: { 'ocs-endpoints': [] },
      spaces: { enabled: true, projects: true, max_quota: 0 },
      groupware: { enabled: false }, search: { property: {} },
    },
  } } };
}

export async function recoveryMetadata(target, { origin, backend, resourceId, signal }) {
  check(typeof target === 'string' && target.length <= 8192 && target.startsWith('/')
    && !target.startsWith('//') && !/[#\\\x00-\x20\x7f]/u.test(target));
  const url = new URL(target, origin);
  check(url.origin === origin);
  signal.throwIfAborted();
  if (url.pathname === '/volparossa/recovery/session') {
    query(url);
    return { version: 1, authority: 'owner-local-catalog', readOnly: true, upstreamAccount: false, owner: OWNER };
  }
  if (url.pathname === '/ocs/v1.php/cloud/capabilities') {
    query(url, { format: ['json'] });
    return capabilities();
  }
  if (url.pathname === '/graph/v1beta1/roleManagement/permissions/roleDefinitions') {
    query(url);
    // Web 8's listRoleDefinitions consumes response.data directly, unlike
    // the drive collection. This local read-only authority grants no roles.
    return [];
  }
  const drive = entry => ({ id: recoverySpaceId(entry.name), name: entry.name, driveType: 'project',
    driveAlias: `project/${entry.name}`, description: 'Owner-selected private recovery; read only',
    // A personal drive would cause the original client to offer upload solely
    // from owner identity. Projects retain its normal permission checks.
    owner: { user: OWNER }, root: { id: resourceId([entry.name]), permissions: [] },
    webUrl: `${origin}/dav/spaces/${encodeURIComponent(entry.name)}/`,
  });
  if (url.pathname === '/graph/v1beta1/me/drives') {
    query(url, { '$filter': ['driveType eq personal', 'driveType eq project', 'driveType eq mountpoint',
      "driveType eq 'personal'", "driveType eq 'project'", "driveType eq 'mountpoint'"], '$orderby': ['name asc'] });
    const filter = url.searchParams.get('$filter');
    if (filter && !['driveType eq project', "driveType eq 'project'"].includes(filter)) return { value: [] };
    const entries = await backend.list([], { signal });
    signal.throwIfAborted();
    check(Array.isArray(entries) && entries.length <= 256, 503);
    const names = new Set();
    for (const entry of entries) {
      check(entry.kind === 'directory' && part(entry.name) && !names.has(entry.name), 503);
      names.add(entry.name);
    }
    return { value: [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(drive) };
  }
  const match = /^\/graph\/v1beta1\/drives\/([^/]+)(\/root\/permissions)?$/u.exec(url.pathname);
  if (match) {
    query(url, match[2] ? { '$top': ['0'], '$count': ['true'], '$filter': ["grantedToV2 ne ''"],
      '$select': ['@libre.graph.permissions.actions.allowedValues'] } : {});
    let id;
    try { id = decodeURIComponent(match[1]); } catch { throw new RecoveryMetadataError(400); }
    check(isRecoverySpaceId(id) && typeof backend.resolveResourceId === 'function', 404);
    const parts = await backend.resolveResourceId(id, { signal });
    signal.throwIfAborted();
    check(Array.isArray(parts) && parts.length === 1 && part(parts[0])
      && recoverySpaceId(parts[0]) === id, 404);
    const entry = await backend.stat(parts, { signal });
    signal.throwIfAborted();
    check(entry?.kind === 'directory', 404);
    return match[2] ? { value: [], '@libre.graph.permissions.actions.allowedValues': [],
      '@libre.graph.permissions.roles.allowedValues': [], '@odata.count': 0 } : drive({ name: parts[0] });
  }
  throw new RecoveryMetadataError(404);
}
