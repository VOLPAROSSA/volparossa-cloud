#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Explicit owner CLI. Never starts a service, fetches software or searches for credentials.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readPrivateJSON, importPrivateFile, restorePrivateFile, storePrivateFile, restoreStoredFile,
  PrivateFileError } from '../src/private-file.mjs';

const FLAGS = {
  import: ['source-config', 'bundle'], create: ['config', 'bundle'], deposit: ['config', 'bundle'],
  restore: ['config', 'bundle', 'output'], 'restore-local': ['bundle', 'cipher', 'output'],
};
export function parseArguments(argv) {
  const operation = argv[0];
  if (!Object.hasOwn(FLAGS, operation)) throw new PrivateFileError('INVALID_OPERATION');
  const { values, positionals } = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false,
    options: Object.fromEntries(FLAGS[operation].map(name => [name, { type: 'string' }])) });
  if (positionals.length || FLAGS[operation].some(key => !values[key])) throw new PrivateFileError('MISSING_ARGUMENT');
  return { operation, ...values };
}
export async function run(options, { signal } = {}) {
  const { operation, config, bundle, cipher, output } = options;
  if (operation === 'import') {
    const source = await readPrivateJSON(options['source-config']);
    if (!source || Object.keys(source).sort().join(',') !== 'resource,source,version' || source.version !== 1) {
      throw new PrivateFileError('INVALID_SOURCE_CONFIGURATION');
    }
    return importPrivateFile({ source: source.source, resource: source.resource, output: bundle }, { signal });
  }
  if (operation === 'restore-local') return restorePrivateFile({ bundle, cipher, output }, { signal });
  if (operation === 'restore') return restoreStoredFile({ config, bundle, output }, { signal });
  return storePrivateFile(operation, { config, bundle }, { signal });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cancel = new AbortController();
  for (const kind of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(kind, () => cancel.abort());
  try {
    const result = await run(parseArguments(process.argv.slice(2)), { signal: cancel.signal });
    console.log(JSON.stringify(result));
    if (result.status && result.status !== 'complete') process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ success: false, code: 'PRIVATE_FILE_OPERATION_FAILED' }));
    process.exitCode = 1;
  }
}
