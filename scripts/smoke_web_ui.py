#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Actual original OpenCloud UI in a fresh isolated Firefox profile; synthetic backend.

No existing browser profile, real account, external service or peer-store claim.
Only optional explicitly selected installed Firefox executable is used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


class Marionette:
    def __init__(self, port):
        end = time.monotonic() + 30
        while True:
            try:
                self.sock = socket.create_connection(('127.0.0.1', port), timeout=2)
                break
            except OSError:
                if time.monotonic() > end:
                    raise
                time.sleep(.2)
        self.sock.settimeout(20)
        self.id = 0
        self.read()
        self.session = self.call('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {'acceptInsecureCerts': False}}})

    def read(self):
        size = b''
        while not size.endswith(b':'):
            part = self.sock.recv(1)
            if not part:
                raise RuntimeError('Browser protocol closed')
            size += part
            if len(size) > 12:
                raise RuntimeError('Browser frame bound')
        length = int(size[:-1])
        if length > 4 * 1024**2:
            raise RuntimeError('Browser frame bound')
        data = b''
        while len(data) < length:
            data += self.sock.recv(length - len(data))
        return json.loads(data)

    def call(self, method, params=None):
        self.id += 1
        data = json.dumps([0, self.id, method, params or {}]).encode()
        self.sock.sendall(str(len(data)).encode() + b':' + data)
        while True:
            message = self.read()
            if isinstance(message, list) and message[0] == 1 and message[1] == self.id:
                if message[2]:
                    raise RuntimeError('Browser command failed: ' + message[2].get('error', 'unknown'))
                return message[3]

    def script(self, script, args=None):
        value = self.call('WebDriver:ExecuteScript', {'script': script, 'args': args or [],
          'newSandbox': False, 'sandbox': None, 'scriptTimeout': 15000})
        return value.get('value') if isinstance(value, dict) and 'value' in value else value

    def click(self, selector):
        element = self.call('WebDriver:FindElement', {'using': 'css selector', 'value': selector})
        element = element.get('value', element)
        self.call('WebDriver:ElementClick', {'id': element['element-6066-11e4-a52e-4f735466cecf']})

    def wait(self, script):
        end = time.monotonic() + 30
        while time.monotonic() < end:
            value = self.script(script)
            if value:
                return value
            time.sleep(.2)
        # Only synthetic test text, never used by product service.
        print(json.dumps({'synthetic_page_debug': self.script('return document.body.innerText.slice(0,4000)')}), flush=True)
        print(json.dumps({'synthetic_ui_errors': self.script('return window.__vpUIErrors || []')}), flush=True)
        print(json.dumps({'synthetic_runtime': self.script("const s=document.getElementById('opencloud')?.__vue_app__?.config.globalProperties.$pinia?._s;return s ? {spaces:s.get('spaces')?.spaces?.map(v=>v.id),initialized:s.get('spaces')?.spacesInitialized,loading:s.get('spaces')?.spacesLoading,userReady:s.get('auth')?.userContextReady,resources:performance.getEntriesByType('resource').map(v=>new URL(v.name).pathname).filter(v=>v.startsWith('/graph'))}:null;")}), flush=True)
        raise RuntimeError('UI condition timed out')


def firefox_command(work, firefox):
    args = ['bwrap', '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid',
            '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL']
    for name in ('/usr', '/bin', '/sbin', '/lib', '/lib64'):
        if Path(name).exists():
            args += ['--ro-bind', name, name]
    args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home',
             '--tmpfs', '/root', '--tmpfs', '/run', '--dir', '/etc']
    for name in ('/etc/fonts', '/etc/ld.so.cache'):
        if Path(name).exists():
            args += ['--ro-bind', name, name]
    args += ['--bind', str(work), '/state', '--clearenv',
             '--setenv', 'HOME', '/state/home', '--setenv', 'PATH', '/usr/bin:/bin',
             '--setenv', 'XDG_CACHE_HOME', '/state/cache', '--setenv', 'MOZ_HEADLESS', '1',
             '--setenv', 'MOZ_CRASHREPORTER_DISABLE', '1', '--setenv', 'MOZ_NO_REMOTE', '1',
             firefox, '--headless', '--no-remote', '--profile', '/state/profile', '--marionette']
    return args


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--dist', required=True)
    parser.add_argument('--firefox', default='/usr/bin/firefox')
    parser.add_argument('--yes', required=True, action='store_true')
    args = parser.parse_args()
    if not args.firefox.startswith('/usr/') or not Path(args.firefox).is_file():
        raise ValueError('Explicit existing system Firefox required')
    build = ROOT / 'build'
    build.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='web-ui-smoke-', dir=build) as temporary:
        work = Path(temporary)
        for name in ('profile', 'downloads', 'home', 'cache', 'private'):
            (work / name).mkdir(mode=0o700)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        prefs = {'marionette.port': port, 'marionette.enabled': True,
          'browser.shell.checkDefaultBrowser': False, 'browser.startup.homepage': 'about:blank',
          'browser.startup.page': 0, 'browser.aboutwelcome.enabled': False,
          'datareporting.policy.dataSubmissionEnabled': False, 'toolkit.telemetry.enabled': False,
          'browser.safebrowsing.downloads.enabled': False, 'browser.safebrowsing.malware.enabled': False,
          'browser.safebrowsing.phishing.enabled': False, 'app.update.enabled': False,
          'extensions.update.enabled': False, 'extensions.getAddons.cache.enabled': False,
          'network.captive-portal-service.enabled': False, 'network.connectivity-service.enabled': False,
          'network.dns.disablePrefetch': True, 'network.prefetch-next': False, 'network.predictor.enabled': False,
          'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 1,
          'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 1,
          'network.proxy.no_proxies_on': '127.0.0.1,localhost',
          'browser.download.folderList': 2, 'browser.download.dir': '/state/downloads',
          'browser.download.useDownloadDir': True, 'browser.download.alwaysOpenPanel': False,
          'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream,text/plain',
          'pdfjs.disabled': True}
        (work / 'profile/user.js').write_text(''.join('user_pref(' + json.dumps(k) + ', ' + json.dumps(v) + ');\n' for k, v in prefs.items()))
        token = 'synthetic-private-recovery-token-1234567890'
        server = subprocess.Popen([args.node, str(ROOT / 'scripts/web-ui-fixture.mjs'),
            str(work / 'private'), args.dist], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={'PATH': '/usr/bin:/bin', 'VP_SYNTHETIC_TOKEN': token})
        browser = None
        client = None
        completed = False
        try:
            if not select.select([server.stdout], [], [], 20)[0]:
                raise RuntimeError('Fixture did not listen')
            line = server.stdout.readline()
            if not line:
                raise RuntimeError('Fixture failed: ' + server.stderr.read()[-2000:])
            origin = json.loads(line)['origin']
            log = (work / 'browser.log').open('w')
            browser = subprocess.Popen(firefox_command(work, args.firefox), stdout=log, stderr=subprocess.STDOUT)
            client = Marionette(port)
            client.call('WebDriver:Navigate', {'url': origin + '/#/files/spaces/projects'})
            client.wait("return !!document.getElementById('volparossa-recovery-token')")
            client.script("window.__vpUIErrors=[];addEventListener('error',e=>window.__vpUIErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__vpUIErrors.push(String(e.reason?.message||e.reason)));console.error=(...a)=>window.__vpUIErrors.push(a.map(v=>String(v?.message||v)).join(' ').slice(0,1000));")
            client.script("const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){this.addEventListener('loadend',()=>{if(this.status>=400)window.__vpUIErrors.push(method+' '+url+' '+this.status)});return open.call(this,method,url,...rest)};")
            client.script("document.getElementById('volparossa-recovery-token').value=arguments[0];document.querySelector('#volparossa-owner-recovery form').requestSubmit();", ['wrong-token-that-is-at-least-32-characters'])
            client.wait("return document.querySelector('#volparossa-owner-recovery [role=status]')?.textContent.includes('failed')")
            assert client.script("return !document.body.innerText.includes('notes.txt')")
            client.script("document.getElementById('volparossa-recovery-token').value=arguments[0];document.querySelector('#volparossa-owner-recovery form').requestSubmit();", [token])
            client.wait("return !document.getElementById('volparossa-owner-recovery') && document.body.innerText.includes('\\nSelected\\n')")
            print(json.dumps({'stage': 'original-project-ui-visible'}), flush=True)
            client.call('WebDriver:Navigate', {'url': origin + '/#/files/spaces/project/Selected'})
            client.wait("return !!document.querySelector('[data-test-resource-name=\"notes.txt\"]')")
            assert client.script("return !document.querySelector('[id^=app-floating-action-button]')")
            for name, content in [('notes.txt', b'Synthetic VOLPAROSSA owner recovery through original OpenCloud Files.\n'),
                                  ('detail.txt', b'Nested selected recovery file.\n')]:
                if name == 'detail.txt':
                    client.script("document.querySelector('[data-test-resource-name=\"Folder\"]').closest('a,button').click();")
                    client.wait("return !!document.querySelector('[data-test-resource-name=\"detail.txt\"]')")
                client.script("document.querySelector('[data-test-resource-name=\"'+arguments[0]+'\"]').closest('a,button').click();", [name])
                client.wait("return [...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Download')")
                client.click('.oc-modal-body-actions-confirm')
                end = time.monotonic() + 20
                target = work / 'downloads' / name
                while time.monotonic() < end and not target.exists():
                    time.sleep(.1)
                if not target.exists():
                    print(json.dumps({'synthetic_download_error': client.script('return window.__vpUIErrors'),
                      'synthetic_page': client.script('return document.body.innerText.slice(-3000)'),
                      'download_entries': [p.name for p in (work / 'downloads').iterdir()]}), flush=True)
                assert target.read_bytes() == content
                print(json.dumps({'stage': 'original-file-download', 'sha256': hashlib.sha256(content).hexdigest()}), flush=True)
            # The bearer remains in memory, never in URL or web storage.
            assert client.script("return !location.href.includes(arguments[0]) && !JSON.stringify(localStorage).includes(arguments[0]) && !JSON.stringify(sessionStorage).includes(arguments[0])", [token])
            client.script("document.getElementById('_userMenuButton').click();")
            client.wait("return !!document.getElementById('volparossa-recovery-close')")
            client.script("document.getElementById('volparossa-recovery-close').click();")
            client.wait("return !!document.getElementById('volparossa-recovery-token')")
            completed = True
        finally:
            if client:
                try: client.call('WebDriver:DeleteSession')
                except (OSError, RuntimeError): pass
                client.sock.close()
            if browser:
                browser.terminate()
                try: browser.wait(timeout=10)
                except subprocess.TimeoutExpired: browser.kill(); browser.wait(timeout=10)
                if not completed:
                    print((work / 'browser.log').read_text()[-4000:], flush=True)
            server.send_signal(signal.SIGTERM)
            output, error = server.communicate(timeout=15)
            if server.returncode or not output:
                raise RuntimeError('Fixture cleanup failed: ' + error[-2000:])
            cleanup = json.loads(output.strip().splitlines()[-1])
            if not completed:
                print(json.dumps({'synthetic_backend_cleanup': cleanup}), flush=True)
            assert cleanup['private_cleanup'] and cleanup['opened'] == cleanup['disposed']
            if completed:
                assert cleanup['opened'] == 2
            assert not list((work / 'private').iterdir())
    pins_path = ROOT / 'third_party/opencloud-web-ui.json'
    pins = json.loads(pins_path.read_text())
    report = {'version': 1, 'kind': 'opencloud-web-owner-recovery-ui-smoke',
      'success': completed, 'original_files_ui': True, 'wrong_token_denied': True,
      'file_downloads_verified': 2, 'nested_directory_navigation': True, 'logout_relocks': True,
      'synthetic_backend': True, 'peer_storage_proven': False, 'private_cleanup': True,
      'source_revision': pins['revision'], 'source_tree': pins['tree'],
      'upstream_version': pins['upstream_version'],
      'pins_sha256': hashlib.sha256(pins_path.read_bytes()).hexdigest(),
      'patch_sha256': hashlib.sha256((ROOT / pins['patch']).read_bytes()).hexdigest(),
      'build_report_sha256': hashlib.sha256((Path(args.dist) / 'BUILD_REPORT.json').read_bytes()).hexdigest(),
      'browser': {key: client.session.get('capabilities', {}).get(key) for key in ('browserName', 'browserVersion')},
      'private_profile_removed': not work.exists()}
    output = build / ('web-ui-smoke-report-' + str(time.time_ns()) + '.json')
    with output.open('x') as stream:
        json.dump(report, stream, indent=2, sort_keys=True)
        stream.write('\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
