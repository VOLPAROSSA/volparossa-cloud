# SPDX-License-Identifier: GPL-3.0-only
"""Actual owner crypto helpers invoked with a non-traversable inherited cwd."""
from contextlib import chdir
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PrivateHelperCwdTests(unittest.TestCase):
    def test_owner_paths_work_without_traversing_the_callers_directory(self):
        build = ROOT / 'build'
        build.mkdir(exist_ok=True, mode=0o700)
        with TemporaryDirectory(dir=build) as temporary:
            owner = Path(temporary)
            blocked = owner / 'caller'
            blocked.mkdir()
            source = blocked / 'source'
            source.mkdir()
            data, meta = owner / 'input', owner / 'metadata'
            data.write_bytes(b'x')
            meta.write_text(json.dumps(dict(url='http://127.0.0.1/x', etag='"x"',
                                            size=1, lastModified=None)))
            for path in (data, meta):
                path.chmod(0o600)

            def run(script, *args, payload=None):
                result = subprocess.run([sys.executable, '-I', '-B', ROOT / 'scripts' / script, *args],
                    input=payload, capture_output=True, check=True, timeout=30)
                return json.loads(result.stdout)

            with chdir(source):
                blocked.chmod(0)
                try:
                    if os.access(source, os.X_OK):
                        self.skipTest('requires an unprivileged process without DAC override')
                    bundle, restored, catalog = (owner / n for n in ('bundle', 'restored', 'catalog'))
                    receipt = run('private_file.py', 'encrypt', '--source', data, '--metadata', meta,
                        '--output', bundle)
                    run('private_file.py', 'decrypt', '--bundle', bundle, '--cipher', bundle / 'file.pgp',
                        '--output', restored)
                    self.assertEqual((restored / 'content.bin').read_bytes(), b'x')
                    entry = dict(segments=['owner', 'x'], bundle=str(bundle), config=str(owner / 'core.json'),
                        size=1, sha256=hashlib.sha256(b'x').hexdigest(), cipherSha256=receipt['cipher_sha256'],
                        cipherBytes=receipt['cipher_bytes'], lastModified=None)
                    index = dict(version=1, kind='volparossa-cloud-private-catalog-index', entries=[entry])
                    run('private_catalog.py', 'seal', '--output', catalog, payload=json.dumps(index).encode())
                    self.assertEqual(run('private_catalog.py', 'decrypt', '--catalog', catalog), index)
                    self.assertFalse(any(p.name.startswith('g-') for p in owner.iterdir()))
                finally:
                    blocked.chmod(0o700)


if __name__ == '__main__':
    unittest.main()
