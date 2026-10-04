#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Original Files/Uppy upload or reopened download in an explicit disposable guest.

The parent owns the real Cloud service, source shutdown, encrypted storage,
provider withdrawal and service restart. This driver never replaces that backend.
Private bearer input stays on stdin; output contains closed observations only.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

SOURCE = Path('/opt/volparossa-cloud')
RUNTIME = SOURCE / 'build/firefox-esr'
SPACE = 'owner-uploads'
NAME = 'private-upload.bin'
CONTENT = bytes(range(256)) * (262144 // 256) + b'U'
CONTENT_SHA = hashlib.sha256(CONTENT).hexdigest()
STAGES = frozenset(('input', 'browser_start', 'locked_ui', 'wrong_token', 'unlock',
    'upload_menu', 'file_selection', 'upload_commit', 'reload', 'original_download_1',
    'original_download_2', 'logout', 'cleanup'))
# Pinned Uppy core 6.0.1 fetcher permits three retries after the initial PUT.
# Observe that existing native behavior; do not start or retry requests here.
MAX_UPLOAD_ATTEMPTS = 4
UPLOAD_OBSERVER = (
    "window.__vpUpload={puts:0,completed:0,created:0,last_status:0,statuses:[]};"
    "const open=XMLHttpRequest.prototype.open;"
    "XMLHttpRequest.prototype.open=function(method,url,...rest){"
    "if(method.toUpperCase()==='PUT'){"
    "window.__vpUpload.puts=Math.min(5,window.__vpUpload.puts+1);"
    "this.addEventListener('loadend',()=>{"
    "window.__vpUpload.completed=Math.min(5,window.__vpUpload.completed+1);"
    "window.__vpUpload.last_status=this.status;"
    "if(window.__vpUpload.statuses.length<4)window.__vpUpload.statuses.push(this.status);"
    "if(this.status===201)window.__vpUpload.created=Math.min(5,window.__vpUpload.created+1)"
    "},{once:true})}return open.call(this,method,url,...rest)};"
)


class UIConditionTimeout(TimeoutError):
    pass


def upload_observation(value):
    """Closed counters only: never retain XHR URLs, headers or response bodies."""
    require(type(value) is dict and set(value) == {'puts', 'completed', 'created', 'last_status', 'statuses'})
    require(all(type(value[key]) is int and 0 <= value[key] <= MAX_UPLOAD_ATTEMPTS
                for key in ('puts', 'completed', 'created')))
    require(value['created'] <= value['completed'] <= value['puts'])
    require(type(value['last_status']) is int
        and (value['last_status'] == 0 or 100 <= value['last_status'] <= 599))
    statuses = value['statuses']
    require(type(statuses) is list and len(statuses) == value['completed']
        and all(type(status) is int and (status == 0 or 100 <= status <= 599) for status in statuses))
    require(value['created'] == statuses.count(201)
        and value['last_status'] == (statuses[-1] if statuses else 0))
    return dict(value, statuses=list(statuses))


def upload_receipt(value):
    """One logical success after only the pinned uploader's bounded retries."""
    value = upload_observation(value)
    require(1 <= value['puts'] == value['completed'] <= MAX_UPLOAD_ATTEMPTS
        and value['created'] == 1 and value['last_status'] == 201
        and all(not 200 <= status < 300 for status in value['statuses'][:-1]))
    return value


def failure_kind(error):
    if isinstance(error, UIConditionTimeout):
        return 'condition_timeout'
    if isinstance(error, TimeoutError):
        return 'transport_timeout'
    if isinstance(error, OSError):
        return 'transport_error'
    if isinstance(error, RuntimeError):
        return 'browser_command'
    if isinstance(error, subprocess.SubprocessError):
        return 'subprocess_error'
    return 'boundary_failed'


def require(value):
    if not value:
        raise ValueError('Owner upload UI boundary failed')


def settings(value):
    require(type(value) is dict and set(value) == {'origin', 'bearerToken', 'expectedBytes', 'expectedSha256'})
    require(type(value['origin']) is str and re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', value['origin']))
    require(1 <= int(value['origin'].rsplit(':', 1)[1]) <= 65535)
    require(type(value['bearerToken']) is str and re.fullmatch(r'[A-Za-z0-9_-]{43}', value['bearerToken']))
    require(type(value['expectedBytes']) is int and value['expectedBytes'] == len(CONTENT))
    require(value['expectedSha256'] == CONTENT_SHA)
    return value


def read_frame(stream):
    size = bytearray()
    while True:
        byte = stream.recv(1)
        require(bool(byte))
        if byte == b':':
            break
        require(byte.isdigit() and len(size) < 8)
        size.extend(byte)
    require(bool(size))
    length = int(size)
    require(0 < length <= 4 * 1024**2)
    data = bytearray()
    while len(data) < length:
        part = stream.recv(length - len(data))
        require(bool(part))
        data.extend(part)
    return json.loads(data)


def command(work, original_command):
    # Reuse the original smoke's owner-isolated Firefox mount plan. The reviewed
    # guest parent pins this runtime; no executable is fetched or chosen by input.
    result = original_command(work, '/runtime/firefox-esr')
    index = result.index('--clearenv')
    result[index:index] = ['--ro-bind', str(RUNTIME), '/runtime']
    return result


def private_directory(path):
    info = path.lstat()
    require(path.is_absolute() and path.resolve() == path and stat.S_ISDIR(info.st_mode)
        and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700)


def preferences(port):
    return {'marionette.port': port, 'marionette.enabled': True,
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
        'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream', 'pdfjs.disabled': True}


def run(mode, root, value):
    require(mode in ('upload', 'download'))
    require(socket.gethostname() == 'volparossa-alpha' and os.geteuid() != 0)
    private_directory(root)
    value = settings(value)
    base = runpy.run_path(str(SOURCE / 'scripts/smoke_web_ui.py'))

    class Marionette(base['Marionette']):
        last_upload_observation = None

        def read(self):
            return read_frame(self.sock)

        def wait(self, script, seconds=120):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                result = self.script(script)
                if result:
                    return result
                time.sleep(.2)
            # Do not inherit the synthetic-only driver's page/error dump.
            raise UIConditionTimeout('Owner upload UI condition timeout')

        def wait_upload(self, seconds=1800):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                self.last_upload_observation = upload_observation(
                    self.script('return window.__vpUpload'))
                if self.last_upload_observation['created'] == 1:
                    return
                time.sleep(.2)
            raise UIConditionTimeout('Owner upload UI condition timeout')

    report = dict(version=1, kind='cloud-owner-upload-original-ui', mode=mode, success=False,
        stage='input', original_files_ui=True, synthetic_backend=False,
        original_file_input_used=False, upload_201_observed=False, uploaded_file_listed=False,
        reload_reauthenticated=False, file_downloads_verified=0, wrong_token_denied=False,
        logout_relocks=False, token_absent_from_url_and_web_storage=False,
        browser_stopped_and_joined=False, private_profile_removed=False,
        upload_receipt=None,
        browser_version=None, bytes=len(CONTENT), sha256=CONTENT_SHA,
        peer_storage_proven=False, service_restart_owned_by_parent=True,
        source_shutdown_owned_by_parent=True, owner_secrets_exported=False)
    browser = client = work = None
    try:
        with tempfile.TemporaryDirectory(prefix='owner-ui-', dir=root) as temporary:
            work = Path(temporary)
            for name in ('profile', 'downloads', 'uploads', 'home', 'cache'):
                (work / name).mkdir(mode=0o700)
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            (work / 'profile/user.js').write_text(''.join('user_pref(' + json.dumps(key) + ', '
                + json.dumps(val) + ');\n' for key, val in preferences(port).items()))
            try:
                report['stage'] = 'browser_start'
                browser = subprocess.Popen(command(work, base['firefox_command']), stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                    env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
                client = Marionette(port)
                caps = client.session.get('capabilities', {})
                require(caps.get('browserName') == 'firefox' and caps.get('browserVersion') == '140.16.0')
                report['browser_version'] = '140.16.0'
                report['stage'] = 'locked_ui'
                target = value['origin'] + '/#/files/spaces/project/' + SPACE
                client.call('WebDriver:Navigate', {'url': target})
                client.wait("return !!document.getElementById('volparossa-recovery-token')")
                submit = "document.getElementById('volparossa-recovery-token').value=arguments[0];document.querySelector('#volparossa-owner-recovery form').requestSubmit();"
                report['stage'] = 'wrong_token'
                client.script(submit, ['wrong-token-that-is-at-least-32-characters'])
                client.wait("return document.querySelector('#volparossa-owner-recovery [role=status]')?.textContent.includes('failed')")
                require(client.script("return !document.querySelector('[data-test-resource-name=\"private-upload.bin\"]')"))
                report['wrong_token_denied'] = True
                report['stage'] = 'unlock'
                client.script(submit, [value['bearerToken']])
                client.wait("return !document.getElementById('volparossa-owner-recovery') && [...document.querySelectorAll('[id^=app-floating-action-button-]')].some(e=>!e.disabled)")
                listed = "return !!document.querySelector('[data-test-resource-name=\"private-upload.bin\"]')"
                if mode == 'upload':
                    require(not client.script(listed))
                    report['stage'] = 'upload_menu'
                    client.click('[id^=app-floating-action-button-]')
                    client.wait("return !!document.getElementById('files-file-upload-input')")
                    require(client.script("return !document.getElementById('files-folder-upload-input') && !document.getElementById('new-folder-btn') && !document.getElementById('new-shortcut-btn')"))
                    # Observe only the real native Uppy XHR's bounded completion
                    # facts; this observer does not issue or replace any request.
                    client.script(UPLOAD_OBSERVER)
                    with (work / 'uploads' / NAME).open('xb') as output:
                        os.fchmod(output.fileno(), 0o600)
                        output.write(CONTENT)
                    report['stage'] = 'file_selection'
                    element = client.call('WebDriver:FindElement', {'using': 'css selector', 'value': '#files-file-upload-input'})
                    element = element.get('value', element)
                    client.call('WebDriver:ElementSendKeys', {'id': element['element-6066-11e4-a52e-4f735466cecf'],
                        'text': '/state/uploads/' + NAME})
                    report['original_file_input_used'] = True
                    report['stage'] = 'upload_commit'
                    client.wait_upload(seconds=1800)
                    report['upload_receipt'] = upload_receipt(client.script('return window.__vpUpload'))
                    report['upload_201_observed'] = True
                    client.wait(listed)
                    report['uploaded_file_listed'] = True
                    report['stage'] = 'reload'
                    client.call('WebDriver:Refresh')
                    client.wait("return !!document.getElementById('volparossa-recovery-token')")
                    client.script(submit, [value['bearerToken']])
                    client.wait(listed)
                    report['reload_reauthenticated'] = True
                else:
                    client.wait(listed)
                    report['uploaded_file_listed'] = True
                    require(not list((work / 'uploads').iterdir()))
                    for number in (1, 2):
                        report['stage'] = f'original_download_{number}'
                        downloaded = work / 'downloads' / NAME
                        require(not downloaded.exists())
                        client.script("document.querySelector('[data-test-resource-name=\"private-upload.bin\"]').closest('a,button').click();")
                        client.wait("return [...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Download')")
                        client.click('.oc-modal-body-actions-confirm')
                        deadline = time.monotonic() + 900
                        while time.monotonic() < deadline:
                            if downloaded.exists() and downloaded.stat().st_size == len(CONTENT):
                                break
                            require(browser.poll() is None)
                            time.sleep(.2)
                        info = downloaded.lstat()
                        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                            and info.st_nlink == 1 and info.st_size == len(CONTENT))
                        require(hashlib.sha256(downloaded.read_bytes()).hexdigest() == CONTENT_SHA)
                        downloaded.unlink()
                        require(not list((work / 'downloads').iterdir()))
                        report['file_downloads_verified'] += 1
                report['stage'] = 'logout'
                require(client.script("return !location.href.includes(arguments[0]) && !JSON.stringify(localStorage).includes(arguments[0]) && !JSON.stringify(sessionStorage).includes(arguments[0])", [value['bearerToken']]))
                report['token_absent_from_url_and_web_storage'] = True
                client.click('#_userMenuButton')
                client.wait("return !!document.getElementById('volparossa-recovery-close')")
                client.click('#volparossa-recovery-close')
                client.wait("return !!document.getElementById('volparossa-recovery-token')")
                report['logout_relocks'] = True
                report['success'] = True
            finally:
                if client is not None:
                    try:
                        client.call('WebDriver:DeleteSession')
                    except (OSError, RuntimeError, ValueError):
                        pass
                    client.sock.close()
                if browser is not None:
                    if browser.poll() is None:
                        os.killpg(browser.pid, signal.SIGTERM)
                    try:
                        browser.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(browser.pid, signal.SIGKILL)
                        browser.wait(timeout=5)
                    report['browser_stopped_and_joined'] = browser.poll() is not None
    except (ValueError, TypeError, KeyError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        report['success'] = False
        report['failure_kind'] = failure_kind(error)
        report['upload_observation'] = getattr(client, 'last_upload_observation', None)
    finally:
        report['private_profile_removed'] = work is not None and not work.exists()
        report['success'] = report['success'] and report['browser_stopped_and_joined'] and report['private_profile_removed']
        if report['success']:
            report['stage'] = 'cleanup'
    return report


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise ValueError('Owner upload UI interrupted')
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('mode', choices=('upload', 'download'))
        parser.add_argument('private_parent', type=Path)
        parser.add_argument('--yes', required=True, action='store_true')
        args = parser.parse_args()
        result = run(args.mode, args.private_parent, settings(json.loads(sys.stdin.buffer.read(4097))))
    except (ValueError, TypeError, KeyError, OSError, RuntimeError, subprocess.SubprocessError):
        result = dict(version=1, kind='cloud-owner-upload-ui-input-failure', success=False, stage='input')
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result['success'] else 1)
