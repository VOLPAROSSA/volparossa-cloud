#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Replay the actual builder's strict patch gate, without downloads or a UI build.

Run with --source pointing to an existing local checkout containing pinned
OpenCloud Web 11e699ac. Only new workspace-local sparse clones are modified;
the supplied checkout, including any existing changes, is never changed.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / 'build/opencloud-web-11e699'
PINS = json.loads((ROOT / 'third_party/opencloud-web-ui.json').read_text())
BUILDER = runpy.run_path(str(ROOT / 'scripts/build_web_ui.py'))
GIT_ENV = {'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
# Measured by applying the ORIGINAL Cloud 311f607 patch to exact upstream
# 11e699ac, before canonicalizing any diff metadata/order. All eight complete
# postimages must remain byte-identical, not just the added upload lines.
POSTIMAGES = {
    'packages/web-app-files/src/components/CreateOrUploadMenu.vue':
        (7285, '14879499f3bafd9301a32ae02774a3469897bb210fc85af340c97b8f216ebb20'),
    'packages/web-pkg/src/composables/download/useDownloadFile.ts':
        (4318, 'cc72566bcf3b0eeefeeab701edab65cb90a09020820c346d64323850bfb37041'),
    'packages/web-pkg/src/composables/piniaStores/config/types.ts':
        (3909, 'cfb5842839820b03b0e9bd2b44913353e65fc7f4c95c141d00da2392c7ef0fdb'),
    'packages/web-pkg/src/composables/upload/useUpload.ts':
        (3516, 'fe3aacf897c9e1207d8029d9e118f146ec4c395ee8d38971afdb898113d384ff'),
    'packages/web-pkg/src/services/uppy/uppyService.ts':
        (11661, '12dbebfdb89bb05230b2efa3a129f944767a6ed9ae522df85e1dd4a3ba45ce45'),
    'packages/web-runtime/src/components/Topbar/UserMenu.vue':
        (6623, '45c28a434c678a5900e28326c08452e67ff55081d26094b9aa873ac06c254430'),
    'packages/web-runtime/src/index.ts':
        (13771, '5a34f9836e0341fac48d90aad66a0e050b1dad2945f42368080da6220a34ec9a'),
    'packages/web-runtime/src/services/auth/authService.ts':
        (16076, '3f34f74aaa45f9c103206513e6c6e915163f7102488b26a2882cd52a4b332562'),
}


def git(source, *args, data=None):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(source), *args],
                                   input=data, env=dict(os.environ, **GIT_ENV), timeout=30,
                                   stderr=subprocess.PIPE)


def builder_patch_gate(source, root):
    # Execute the four original statements from main(), ending at the exact
    # bytes comparison. Do not copy a weaker stand-in check or run main()'s
    # dependency installation, sandbox or vite command.
    tree = ast.parse((ROOT / 'scripts/build_web_ui.py').read_text())
    main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
    branch = next(node for node in main.body if isinstance(node, ast.If)
                  and isinstance(node.test, ast.Attribute) and node.test.attr == 'build')
    start = next(index for index, node in enumerate(branch.body) if isinstance(node, ast.Assign)
                 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'patch')
    nodes = branch.body[start:start + 4]
    expected = "Source must match the reviewed owner-recovery patch exactly"
    if len(nodes) != 4 or not any(isinstance(node, ast.Constant) and node.value == expected
                                  for node in ast.walk(nodes[-1])):
        raise AssertionError('builder patch-gate shape changed; review the exact gate')
    scope = dict(BUILDER, source=source, ROOT=root, pins=PINS)
    with patch.dict(os.environ, GIT_ENV):
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'actual-builder-patch-gate', 'exec'), scope)


class WebUIPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not UPSTREAM.is_dir():
            raise AssertionError('Pass --source EXISTING_PINNED_WEB_CHECKOUT; no automatic download')
        if git(UPSTREAM, 'rev-parse', PINS['revision'] + '^{tree}').decode().strip() != PINS['tree']:
            raise AssertionError('existing upstream object does not match the pinned tree')
        (ROOT / 'build').mkdir(mode=0o700, exist_ok=True)

    def source(self, directory, raw):
        source = directory / 'source'
        git(ROOT, 'clone', '--shared', '--no-checkout', '--quiet', '--', str(UPSTREAM.resolve()), str(source))
        git(source, 'sparse-checkout', 'set', '--no-cone', '--stdin',
            data=''.join('/' + name + '\n' for name in POSTIMAGES).encode())
        git(source, 'checkout', '--detach', '--quiet', PINS['revision'])
        self.assertEqual(git(source, 'rev-parse', 'HEAD').decode().strip(), PINS['revision'])
        git(source, 'apply', '--check', '-', data=raw)
        git(source, 'apply', '-', data=raw)
        self.assertEqual(set(git(source, 'diff', '--name-only', 'HEAD').decode().splitlines()), set(POSTIMAGES))
        for name, identity in POSTIMAGES.items():
            data = (source / name).read_bytes()
            self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), identity, name)
        return source

    def test_canonical_patch_passes_actual_builder_with_all_original_postimages(self):
        with tempfile.TemporaryDirectory(prefix='web-patch-check-', dir=ROOT / 'build') as name:
            source = self.source(Path(name), (ROOT / PINS['patch']).read_bytes())
            builder_patch_gate(source, ROOT)

    def test_applicable_noncanonical_patch_is_still_rejected(self):
        # Reproduce the observed failure class: git apply accepts omitted index
        # metadata, but the unchanged strict builder must still reject it.
        raw = b''.join(line for line in (ROOT / PINS['patch']).read_bytes().splitlines(keepends=True)
                       if not line.startswith(b'index '))
        with tempfile.TemporaryDirectory(prefix='web-patch-reject-', dir=ROOT / 'build') as name:
            directory = Path(name)
            source = self.source(directory, raw)
            selected = directory / PINS['patch']
            selected.parent.mkdir(mode=0o700)
            selected.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, 'Source must match the reviewed owner-recovery patch exactly'):
                builder_patch_gate(source, directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=UPSTREAM)
    args, remaining = parser.parse_known_args()
    UPSTREAM = args.source.resolve(strict=True)
    unittest.main(argv=[sys.argv[0], *remaining])
