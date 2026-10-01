#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicitly stage exact OpenCloud Web SDK bytes for a local interoperability trial.

Does not install packages, run package scripts, start services or change any host
configuration. The caller must explicitly request a download into a new directory
under this worktree's ignored build/ directory. All package notices are retained.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PINS = ROOT / 'third_party/opencloud-web-sdk.json'


def require(value):
    if not value:
        raise ValueError('SDK staging identity or boundary failed')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError('SDK redirects are not allowed')


def stage(output):
    pins = json.loads(PINS.read_text())
    require(pins['version'] == 1 and pins['package'] == '@opencloud-eu/web-client'
            and pins['package_version'] == '8.0.0'
            and pins['url'] == 'https://registry.npmjs.org/@opencloud-eu/web-client/-/web-client-8.0.0.tgz'
            and pins['files'] == 109 and pins['unpacked_bytes'] == 1109076)
    build = ROOT / 'build'
    if not build.exists():
        build.mkdir(mode=0o700)
    require(build.resolve(strict=True) == build and stat.S_ISDIR(build.lstat().st_mode)
            and build.lstat().st_uid == os.getuid())
    output = Path(output)
    require(output.is_absolute() and output.parent == build and not output.exists()
            and not output.is_symlink() and output.name not in ('', '.', '..'))
    with urllib.request.build_opener(NoRedirect).open(pins['url'], timeout=30) as response:
        require(response.status == 200)
        encoded = response.read(2 * 1024**2 + 1)
    require(len(encoded) <= 2 * 1024**2
            and 'sha512-' + base64.b64encode(hashlib.sha512(encoded).digest()).decode() == pins['integrity'])
    staging = Path(tempfile.mkdtemp(prefix='web-sdk-stage-', dir=build))
    try:
        records = {}
        total = 0
        with tarfile.open(fileobj=io.BytesIO(encoded), mode='r:gz') as archive:
            for member in archive:
                path = PurePosixPath(member.name)
                require(member.isfile() and len(path.parts) >= 2 and path.parts[0] == 'package'
                        and not path.is_absolute() and str(path) == member.name
                        and all(part not in ('', '.', '..') for part in path.parts)
                        and '\\' not in member.name and member.name not in records
                        and 0 <= member.size <= 2 * 1024**2 and len(records) < pins['files'])
                total += member.size
                require(total <= pins['unpacked_bytes'])
                with archive.extractfile(member) as stream:
                    data = stream.read(member.size + 1)
                require(len(data) == member.size)
                target = staging.joinpath(*path.parts)
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    stream.write(data)
                target.chmod(0o444)
                records[member.name] = dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        require(len(records) == pins['files'] and total == pins['unpacked_bytes']
                and 'package/LICENSE' in records and 'package/dist/web-client/webdav.js' in records)
        metadata = json.loads((staging / 'package/package.json').read_text())
        require(metadata['name'] == pins['package'] and metadata['version'] == pins['package_version'])
        receipt = dict(version=1, kind='opencloud-web-sdk-trial', pins_sha256=hashlib.sha256(PINS.read_bytes()).hexdigest(),
                       archive_sha256=hashlib.sha256(encoded).hexdigest(), files=records,
                       package_scripts_run=False, source_build_claimed=False, global_installation=False)
        with (staging / 'receipt.json').open('x') as stream:
            json.dump(receipt, stream, sort_keys=True, indent=2)
            stream.write('\n')
        # The caller selected a fresh child of its own private build directory.
        require(not output.exists() and not output.is_symlink())
        staging.rename(output)
        return dict(staged=True, version=pins['package_version'], files=len(records),
                    archive_sha256=receipt['archive_sha256'], executed=False)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true', required=True)
    parser.add_argument('--yes', action='store_true', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(dict(plan='stage-pinned-published-sdk-under-worktree-build',
                          network_origin='https://registry.npmjs.org', execute_or_install=False)), flush=True)
    print(json.dumps(stage(args.output), sort_keys=True))
