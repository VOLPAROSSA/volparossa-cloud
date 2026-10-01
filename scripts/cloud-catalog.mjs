#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readPrivateJSON } from '../src/private-file.mjs';
import { createPrivateCatalog, openPrivateCatalog, PrivateCatalogError } from '../src/private-catalog.mjs';

export function parseArguments(argv) {
  const operation = argv[0];
  if (!['create', 'inspect'].includes(operation)) throw new PrivateCatalogError('INVALID_OPERATION');
  const required = operation === 'create' ? ['selection', 'catalog', 'work-directory'] : ['catalog', 'work-directory'];
  const allowed = operation === 'create' ? [...required, 'max-total-bytes'] : required;
  const { values } = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false,
    options: Object.fromEntries(allowed.map(name => [name, { type: 'string' }])) });
  if (required.some(name => !values[name])) throw new PrivateCatalogError('MISSING_ARGUMENT');
  if (Object.hasOwn(values, 'max-total-bytes') && !/^[1-9][0-9]{0,10}$/u.test(values['max-total-bytes'])) {
    throw new PrivateCatalogError('INVALID_BYTE_BUDGET');
  }
  return { operation, ...values };
}

export async function run(options, { signal } = {}) {
  if (options.operation === 'create') {
    const selection = await readPrivateJSON(options.selection, 2 * 1024 ** 2);
    if (!selection || typeof selection !== 'object' || Object.keys(selection).sort().join(',') !== 'files,version'
      || selection.version !== 1) throw new PrivateCatalogError('INVALID_SELECTION');
    return createPrivateCatalog({ selection: selection.files, output: options.catalog,
      workDirectory: options['work-directory'],
      ...(options['max-total-bytes'] ? { maxTotalBytes: Number(options['max-total-bytes']) } : {}),
    }, { signal });
  }
  if (options.operation !== 'inspect') throw new PrivateCatalogError('INVALID_OPERATION');
  const backend = await openPrivateCatalog({ catalog: options.catalog, workDirectory: options['work-directory'] }, { signal });
  try {
    let files = 0;
    let directories = 0;
    let plaintextBytes = 0;
    const pending = [[]];
    while (pending.length) {
      const path = pending.pop();
      directories++;
      for (const entry of await backend.list(path, { signal })) {
        if (entry.kind === 'directory') pending.push([...path, entry.name]);
        else { files++; plaintextBytes += entry.size; }
      }
    }
    return { version: 1, kind: 'volparossa-cloud-private-catalog-summary', files, directories,
      plaintextBytes, ownerOnly: true, contentMaterialized: false, secondDeviceRecoveryProven: false };
  } finally { await backend.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const controller = new AbortController();
  for (const kind of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(kind, () => controller.abort());
  try { console.log(JSON.stringify(await run(parseArguments(process.argv.slice(2)), { signal: controller.signal }))); }
  catch {
    console.error(JSON.stringify({ success: false, code: 'PRIVATE_CATALOG_OPERATION_FAILED' }));
    process.exitCode = 1;
  }
}
