#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Driver boundary checks only: no browser, model, peer or native-upload proof."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import socket
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
UI = runpy.run_path(str(ROOT / 'scripts/smoke_owner_upload_ui.py'))
BASE = runpy.run_path(str(ROOT / 'scripts/smoke_web_ui.py'))


def settings():
    return dict(origin='http://127.0.0.1:35431', bearerToken='a' * 43,
        expectedBytes=262145,
        expectedSha256='9012cf78cb493db125d4a0f4f761ae8cb021c5ed16b5085bf32cd4252be575f6')


class OwnerUploadUIBoundary(unittest.TestCase):
    def test_upload_observations_are_closed_bounded_and_consistent(self):
        valid = dict(puts=1, completed=1, created=1, last_status=201, statuses=[201])
        self.assertEqual(UI['upload_observation'](valid), valid)
        for change in (dict(puts=True), dict(completed=65536), dict(created=2),
                       dict(last_status=99), dict(last_status='201'),
                       dict(statuses=[]), dict(statuses=[True]), dict(statuses=[200]),
                       dict(response='PRIVATE_SENTINEL'), dict(url='private-name')):
            with self.subTest(change=change), self.assertRaises(ValueError):
                UI['upload_observation'](dict(valid, **change))
        self.assertEqual(UI['failure_kind'](UI['UIConditionTimeout']('private')),
                         'condition_timeout')
        self.assertEqual(UI['failure_kind'](TimeoutError('private')), 'transport_timeout')

    def test_native_retry_receipt_requires_one_final_success_and_all_attempts_finished(self):
        def receipt(statuses):
            return dict(puts=len(statuses), completed=len(statuses), created=statuses.count(201),
                last_status=statuses[-1] if statuses else 0, statuses=statuses)
        for statuses in ([201], [503, 201], [0, 401, 503, 201]):
            value = receipt(statuses)
            result = UI['upload_receipt'](value)
            self.assertEqual(result, value)
            self.assertIsNot(result['statuses'], value['statuses'])
        for statuses in ([], [0], [503], [200, 201], [204, 201], [299, 201],
                         [201, 503], [201, 201], [0, 503, 503, 503, 201]):
            with self.subTest(statuses=statuses), self.assertRaises(ValueError):
                UI['upload_receipt'](receipt(statuses))
        for change in (dict(puts=2), dict(completed=2), dict(created=0), dict(puts=True),
                       dict(last_status=503), dict(statuses=[201, 503]), dict(raw='PRIVATE')):
            with self.subTest(change=change), self.assertRaises(ValueError):
                UI['upload_receipt'](dict(receipt([201]), **change))

    def test_exact_independently_derived_fixture_and_loopback_input(self):
        body = bytes(range(256)) * 1024 + b'U'
        self.assertEqual(UI['CONTENT'], body)
        self.assertEqual(UI['CONTENT_SHA'], hashlib.sha256(body).hexdigest())
        self.assertEqual(UI['settings'](settings()), settings())
        for change in (dict(origin='https://example.com'), dict(origin='http://127.0.0.1:99999'),
                       dict(origin='http://localhost:35431'), dict(bearerToken='a' * 42),
                       dict(expectedBytes=True), dict(expectedBytes=786433),
                       dict(expectedSha256='1' * 64), dict(executable='/private/forbidden')):
            with self.subTest(fields=tuple(change)), self.assertRaises(ValueError):
                UI['settings'](dict(settings(), **change))

    def test_frame_bounds_and_eof_do_not_turn_into_hanging_browser_wait(self):
        for wire, expected in ((b'2:{}', {}), (b'6:[1,2', None), (b'99999999:', None),
                               (b':', None), (b'x:', None), (b'2:', None)):
            left, right = socket.socketpair()
            with self.subTest(wire=wire), left, right:
                right.sendall(wire)
                right.shutdown(socket.SHUT_WR)
                if expected is None:
                    with self.assertRaises(ValueError):
                        UI['read_frame'](left)
                else:
                    self.assertEqual(UI['read_frame'](left), expected)

    def test_only_fresh_profile_and_pinned_runtime_are_mounted(self):
        work = Path('/private-owner/new-ui-profile')
        argv = UI['command'](work, BASE['firefox_command'])
        mounts = [argv[n + 1:n + 3] for n, value in enumerate(argv) if value == '--bind']
        self.assertEqual(mounts, [[str(work), '/state']])
        self.assertIn('--clearenv', argv)
        self.assertIn('/opt/volparossa-cloud/build/firefox-esr', argv)
        self.assertIn('/runtime/firefox-esr', argv)
        for forbidden in ('/private-owner', '/opt/volparossa-cloud', '/run/volparossa/control.sock'):
            self.assertNotIn(forbidden, argv)
        prefs = UI['preferences'](12345)
        self.assertFalse(prefs['toolkit.telemetry.enabled'])
        self.assertEqual(prefs['network.proxy.http_port'], 1)
        self.assertEqual(prefs['browser.download.dir'], '/state/downloads')

    def test_guest_guard_runs_before_any_browser_or_temporary_work(self):
        with mock.patch.object(UI['socket'], 'gethostname', return_value='not-a-disposable-guest'), \
             mock.patch.object(UI['subprocess'], 'Popen') as launch, \
             mock.patch.object(UI['tempfile'], 'TemporaryDirectory') as directory:
            with self.assertRaises(ValueError):
                UI['run']('upload', Path('/no-work'), settings())
            launch.assert_not_called()
            directory.assert_not_called()

    def test_browser_start_failure_is_closed_and_cleanup_is_retained(self):
        class FailedMarionette:
            def __init__(self, _port):
                raise RuntimeError('PRIVATE_SENTINEL_NOT_EXPORTED')

        browser = mock.Mock()
        browser.poll.return_value = 1
        base = dict(Marionette=FailedMarionette, firefox_command=BASE['firefox_command'])
        # This is deliberately a failed synthetic protocol seam, not a successful
        # browser run. It exercises the real exception/finally and closed report.
        with tempfile.TemporaryDirectory() as temporary, \
             mock.patch.object(UI['socket'], 'gethostname', return_value='volparossa-alpha'), \
             mock.patch.object(UI['os'], 'geteuid', return_value=os.getuid() or 12345), \
             mock.patch.dict(UI['run'].__globals__, {'private_directory': lambda _path: None}), \
             mock.patch.object(UI['runpy'], 'run_path', return_value=base), \
             mock.patch.object(UI['subprocess'], 'Popen', return_value=browser):
            report = UI['run']('upload', Path(temporary), settings())
            self.assertEqual(list(Path(temporary).iterdir()), [])
        self.assertFalse(report['success'])
        self.assertEqual(report['stage'], 'browser_start')
        self.assertTrue(report['browser_stopped_and_joined'])
        self.assertTrue(report['private_profile_removed'])
        self.assertFalse(report['peer_storage_proven'])
        self.assertFalse(report['upload_201_observed'])
        self.assertEqual(report['failure_kind'], 'browser_command')
        self.assertIsNone(report['upload_observation'])
        self.assertEqual(report['file_downloads_verified'], 0)
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(report))
        self.assertNotIn(settings()['bearerToken'], json.dumps(report))
        browser.wait.assert_called_once_with(timeout=15)

    def test_failed_upload_retains_only_last_closed_observation_and_cleanup(self):
        observation = dict(puts=1, completed=0, created=0, last_status=0, statuses=[])

        class FailedUpload:
            def __init__(self, _port):
                self.session = dict(capabilities=dict(browserName='firefox', browserVersion='140.16.0'))
                self.sock = mock.Mock()
                self.polls = 0

            def call(self, method, _params=None):
                if method == 'WebDriver:FindElement':
                    return {'element-6066-11e4-a52e-4f735466cecf': 'synthetic-input'}
                return None

            def click(self, _selector):
                pass

            def script(self, script, _args=None):
                if script == 'return window.__vpUpload':
                    self.polls += 1
                    if self.polls == 1:
                        return observation
                    raise TimeoutError('PRIVATE_SENTINEL_NOT_EXPORTED')
                if script.startswith('return !!document.querySelector'):
                    return False
                return True

        browser = mock.Mock()
        browser.poll.return_value = 1
        base = dict(Marionette=FailedUpload, firefox_command=BASE['firefox_command'])
        # Failure-only seam: not an actual upload or browser success claim.
        with tempfile.TemporaryDirectory() as temporary, \
             mock.patch.object(UI['socket'], 'gethostname', return_value='volparossa-alpha'), \
             mock.patch.object(UI['os'], 'geteuid', return_value=os.getuid() or 12345), \
             mock.patch.dict(UI['run'].__globals__, {'private_directory': lambda _path: None}), \
             mock.patch.object(UI['runpy'], 'run_path', return_value=base), \
             mock.patch.object(UI['time'], 'sleep'), \
             mock.patch.object(UI['subprocess'], 'Popen', return_value=browser):
            report = UI['run']('upload', Path(temporary), settings())
            self.assertEqual(list(Path(temporary).iterdir()), [])
        self.assertFalse(report['success'])
        self.assertEqual(report['stage'], 'upload_commit')
        self.assertEqual(report['failure_kind'], 'transport_timeout')
        self.assertEqual(report['upload_observation'], observation)
        self.assertTrue(report['original_file_input_used'])
        self.assertFalse(report['upload_201_observed'])
        self.assertTrue(report['browser_stopped_and_joined'])
        self.assertTrue(report['private_profile_removed'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(report))
        self.assertNotIn(settings()['bearerToken'], json.dumps(report))

    def test_native_file_input_and_download_are_not_replaced_by_fixture_requests(self):
        source = (ROOT / 'scripts/smoke_owner_upload_ui.py').read_text()
        for required in ('WebDriver:ElementSendKeys', '#files-file-upload-input',
                         "'.oc-modal-body-actions-confirm'", 'WebDriver:Refresh',
                         "peer_storage_proven=False", "source_shutdown_owned_by_parent=True",
                         'sys.stdin.buffer.read(4097)'):
            self.assertIn(required, source)
        for forbidden in ('web-ui-fixture.mjs', 'synthetic_page_debug', 'synthetic_ui_errors',
                          'browser.log', 'fetch(', '.send('):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__':
    unittest.main()
