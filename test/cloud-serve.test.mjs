// SPDX-License-Identifier: GPL-3.0-only
// Pure CLI/lifecycle seam checks; these do not prove peer storage or WebDAV interoperability.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments, validateConfiguration, startCloudService } from '../scripts/cloud-serve.mjs';

const CONFIG = { version: 1, catalog: '/private/catalog', workDirectory: '/private/work',
  bearerToken: 'synthetic-only-test-token-1234567890' };

test('CLI requires one explicit private config; never accepts host binding or inline secrets', () => {
  assert.equal(parseArguments(['--config', '/private/service.json']), '/private/service.json');
  for (const args of [[], ['--host', '0.0.0.0'], ['--token', CONFIG.bearerToken],
    ['--config', '/a', '--config=/b'], ['--config', '/a', 'extra']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('configuration fixes local scope, rejects unknown settings and bounds resource use', () => {
  const config = validateConfiguration(CONFIG);
  assert.equal(config.port, 0);
  assert.equal(config.maxOpenBytes, 256 * 1024 ** 2);
  assert.equal(config.maxConcurrent, 2);
  assert.deepEqual(config.allowedOrigins, []);
  for (const change of [{ version: 2 }, { host: '0.0.0.0' }, { copies: 1 }, { coreBinary: '/anything' },
    { storageFactory: 'executable' }, { bearerToken: 'short' }, { port: 65536 }, { maxConcurrent: 0 },
    { maxOpenBytes: 8 * 1024 ** 3 + 1 }, { allowedOrigins: ['*'] },
    { allowedOrigins: ['http://external.example'] }, { allowedOrigins: ['https://example.test/path'] }]) {
    assert.throws(() => validateConfiguration({ ...CONFIG, ...change }));
  }
  assert.deepEqual(validateConfiguration({ ...CONFIG, allowedOrigins: ['https://ui.example.test'] }).allowedOrigins,
    ['https://ui.example.test']);
});

test('explicit startup binds verified catalog backend; close is ordered and idempotent', async () => {
  const order = [];
  const cancel = new AbortController();
  let backendSignal;
  const backend = { close: async () => order.push('catalog-close') };
  const service = await startCloudService(CONFIG, { signal: cancel.signal,
    openCatalog: async (options, context) => {
      assert.equal(options.catalog, CONFIG.catalog);
      assert.equal(options.workDirectory, CONFIG.workDirectory);
      assert.equal(options.maxOpenFiles, 2);
      assert.equal(Object.hasOwn(options, 'bearerToken'), false);
      backendSignal = context.signal;
      order.push('catalog-open');
      return backend;
    },
    startServer: async options => {
      assert.equal(options.backend, backend);
      assert.equal(options.bearerToken, CONFIG.bearerToken);
      assert.equal(options.maxFileBytes, 256 * 1024 ** 2);
      assert.equal(Object.hasOwn(options, 'host'), false);
      order.push('server-start');
      return { origin: 'http://127.0.0.1:32123', baseURL: 'http://127.0.0.1:32123/dav/spaces/',
        close: async () => order.push('server-close') };
    } });
  assert.equal(service.origin, 'http://127.0.0.1:32123');
  assert.equal(JSON.stringify(service).includes(CONFIG.bearerToken), false);
  await Promise.all([service.close(), service.close()]);
  assert.equal(backendSignal.aborted, true);
  assert.deepEqual(order, ['catalog-open', 'server-start', 'server-close', 'catalog-close']);
});

test('listener failure and cancellation clean the catalog and expose no successful service', async () => {
  let closes = 0;
  await assert.rejects(startCloudService(CONFIG, {
    openCatalog: async () => ({ close: async () => { closes++; } }),
    startServer: async () => { throw new Error('synthetic bind failure'); },
  }));
  assert.equal(closes, 1);
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(startCloudService(CONFIG, { signal: cancel.signal,
    openCatalog: async () => { assert.fail('cancelled operation opened catalog'); },
    startServer: async () => { assert.fail('cancelled operation listened'); },
  }));
});

test('server cleanup failure does not skip catalog cleanup or claim a successful close', async () => {
  let catalogClosed = false;
  const service = await startCloudService(CONFIG, {
    openCatalog: async () => ({ close: async () => { catalogClosed = true; } }),
    startServer: async () => ({ origin: 'http://127.0.0.1:12345', close: async () => { throw new Error('close failed'); } }),
  });
  await assert.rejects(service.close());
  assert.equal(catalogClosed, true);
});
