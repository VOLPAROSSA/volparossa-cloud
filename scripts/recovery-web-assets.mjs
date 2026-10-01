// SPDX-License-Identifier: GPL-3.0-only
// Public, immutable UI assets only. Owner/catalog metadata stays behind bearer auth.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const require = value => { if (!value) throw new Error('RECOVERY_WEB_ASSET_PROVENANCE_FAILED'); };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };

export async function loadRecoveryWebAssets({ distDirectory, origin }) {
  const url = new URL(origin);
  require(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1'
    && isAbsolute(distDirectory) && await realpath(distDirectory) === distDirectory);
  const pinBytes = await readFile(new URL('../third_party/opencloud-web-ui.json', import.meta.url));
  const pins = JSON.parse(pinBytes);
  const patchBytes = await readFile(new URL('../' + pins.patch, import.meta.url));
  const report = JSON.parse(await readFile(join(distDirectory, 'BUILD_REPORT.json')));
  require(report.version === 1 && report.kind === 'opencloud-web-owner-recovery-build'
    && report.source_revision === pins.revision && report.source_tree === pins.tree
    && report.pins_sha256 === sha(pinBytes) && report.patch_sha256 === sha(patchBytes)
    && report.lock_sha256 === pins.lock_sha256 && report.node === '24.19.0' && report.pnpm === '11.27.0'
    && report.lifecycle_scripts === false && report.build_network === false && report.global_installation === false);
  require(report.files && Object.keys(report.files).length > 0 && Object.keys(report.files).length <= 10000);
  const assets = new Map();
  let total = 0;
  for (const [name, expected] of Object.entries(report.files)) {
    require(/^[A-Za-z0-9_./ -]+$/u.test(name) && !name.startsWith('/')
      && name.split('/').every(part => part && part !== '.' && part !== '..')
      && Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && expected.bytes <= 32 * 1024 ** 2);
    const path = join(distDirectory, name);
    const info = await lstat(path);
    require(info.isFile() && !info.isSymbolicLink() && info.size === expected.bytes
      && await realpath(path) === path);
    const data = await readFile(path);
    require(sha(data) === expected.sha256);
    total += data.length;
    require(total <= 120 * 1024 ** 2);
    assets.set('/' + name.split('/').map(encodeURIComponent).join('/'),
      { data, contentType: TYPES[extname(name)] ?? 'application/octet-stream' });
  }
  require(assets.has('/index.html') && assets.has('/UPSTREAM_LICENSE'));
  assets.set('/', assets.get('/index.html'));
  const json = value => ({ data: Buffer.from(JSON.stringify(value)), contentType: 'application/json' });
  assets.set('/config.json', json({ server: origin, theme: origin + '/recovery-theme.json',
    apps: ['files'], external_apps: [], scripts: [], styles: [], customTranslations: [],
    options: { volparossaOwnerRecovery: true, tokenStorageLocal: false,
      disabledExtensions: ['com.github.opencloud-eu.web.files.floating-action-button'],
      disableFeedbackLink: true, disableSponsorLink: true, contextHelpers: false,
      announcement: { bannerText: 'VOLPAROSSA · Private read-only recovery · Selected files only' },
      embed: { enabled: false, delegateAuthentication: false } } }));
  assets.set('/recovery-theme.json', json({ common: { name: 'VOLPAROSSA Private Recovery',
    slogan: 'Selected private files · Read only', logo: '/img/opencloud-icon.png',
    logoMobile: '/img/opencloud-icon.png', shareRoles: {}, urls: {} }, clients: { web: { defaults: {},
    themes: [{ label: 'Light', isDark: false }, { label: 'Dark', isDark: true }] } } }));
  return assets;
}
