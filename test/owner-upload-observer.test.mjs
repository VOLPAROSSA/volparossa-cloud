// SPDX-License-Identifier: GPL-3.0-only
// Actual observer JavaScript with synthetic XHRs; no browser/network/peer proof.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const driver = fileURLToPath(new URL('../scripts/smoke_owner_upload_ui.py', import.meta.url));
const observer = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c',
  "import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])['UPLOAD_OBSERVER']))", driver],
{ encoding: 'utf8' }));

function fixture() {
  const calls = [];
  class XHR {
    listeners = [];
    status = 0;
    open(...args) { calls.push({ target: this, args }); return 'unchanged-open-result'; }
    addEventListener(name, callback, options) {
      assert.equal(name, 'loadend');
      assert.equal(options.once, true);
      this.listeners.push(callback);
    }
    complete(status) {
      this.status = status;
      for (const callback of this.listeners.splice(0)) callback();
    }
  }
  const scope = { XMLHttpRequest: XHR, window: {} };
  runInNewContext(observer, scope);
  const value = () => JSON.parse(JSON.stringify(scope.window.__vpUpload));
  function put(status) {
    const xhr = new XHR();
    assert.equal(xhr.open('PUT', '/PRIVATE-SYNTHETIC-NAME', true), 'unchanged-open-result');
    xhr.complete(status);
    return xhr;
  }
  return { XHR, calls, value, put };
}

test('real observer retains bounded completion order without replacing native open', () => {
  const f = fixture();
  for (const status of [0, 401, 503, 201]) f.put(status);
  assert.deepEqual(f.value(), { puts: 4, completed: 4, created: 1, last_status: 201,
    statuses: [0, 401, 503, 201] });
  assert.equal(f.calls.length, 4);
  for (const call of f.calls) {
    assert.ok(call.target instanceof f.XHR);
    assert.deepEqual(call.args, ['PUT', '/PRIVATE-SYNTHETIC-NAME', true]);
  }
  assert.equal(JSON.stringify(f.value()).includes('PRIVATE'), false);
});

test('GET and an unfinished PUT cannot fabricate completed upload evidence', () => {
  const f = fixture();
  const get = new f.XHR();
  get.open('GET', '/PRIVATE-SYNTHETIC-NAME', true);
  get.complete(200);
  const put = new f.XHR();
  put.open('PUT', '/PRIVATE-SYNTHETIC-NAME', true);
  assert.deepEqual(f.value(), { puts: 1, completed: 0, created: 0, last_status: 0, statuses: [] });
});

test('overflow stays visible and cannot be mistaken for a four-attempt success', () => {
  const f = fixture();
  for (const status of [503, 503, 503, 503, 201]) f.put(status);
  assert.deepEqual(f.value(), { puts: 5, completed: 5, created: 1, last_status: 201,
    statuses: [503, 503, 503, 503] });
});
