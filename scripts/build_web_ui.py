#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit, workspace-only pinned OpenCloud UI build. No package lifecycle hooks.

Download installs only frozen-lock dependencies and a hash-pinned pnpm under
ignored build/. Build runs without networking and with private empty homes.
No credentials, source accounts, global tools or development-host policy changes.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PINS = ROOT / 'third_party/opencloud-web-ui.json'


def require(value, message='UI build boundary or provenance mismatch'):
    if not value:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tool(pins, target):
    spec = pins['tool']
    if target.exists():
        receipt = json.loads((target / 'receipt.json').read_text())
        require(receipt['integrity'] == spec['integrity'])
        for name, sha in receipt['files'].items():
            require(digest(target / name) == sha)
        return
    with urllib.request.urlopen(spec['url'], timeout=30) as response:
        require(response.status == 200 and response.url == spec['url'])
        data = response.read(spec['download_max_bytes'] + 1)
    require(len(data) <= spec['download_max_bytes'])
    require('sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == spec['integrity'])
    target.mkdir(mode=0o700)
    records = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for item in archive:
            path = PurePosixPath(item.name)
            require(item.isfile() and path.parts[0] == 'package' and len(path.parts) >= 2
                    and not path.is_absolute() and str(path) == item.name
                    and all(p not in ('', '.', '..') for p in path.parts)
                    and '\\' not in item.name and item.name not in records
                    and len(records) < spec['files'] and 0 <= item.size <= spec['unpacked_bytes'])
            total += item.size
            require(total <= spec['unpacked_bytes'])
            with archive.extractfile(item) as stream:
                content = stream.read(item.size + 1)
            require(len(content) == item.size)
            destination = target.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as stream:
                stream.write(content)
            destination.chmod(0o444)
            records[item.name] = hashlib.sha256(content).hexdigest()
    require(total == spec['unpacked_bytes'] and len(records) == spec['files']
            and 'package/LICENSE' in records and 'package/bin/pnpm.cjs' in records)
    receipt = dict(version=1, integrity=spec['integrity'], archive_sha256=hashlib.sha256(data).hexdigest(),
                   files=records, global_installation=False, lifecycle_scripts=False)
    (target / 'receipt.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')


def sandbox(source, state, tooling, node, online):
    args = ['bwrap', '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid',
            '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL']
    if not online:
        args += ['--unshare-net']
    for name in ('/usr', '/bin', '/sbin', '/lib', '/lib64'):
        if Path(name).exists():
            args += ['--ro-bind', name, name]
    args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home',
             '--tmpfs', '/root', '--tmpfs', '/run', '--dir', '/etc']
    for name in ('/etc/ssl', '/etc/hosts', '/etc/nsswitch.conf'):
        if Path(name).exists():
            args += ['--ro-bind', name, name]
    if online:
        args += ['--ro-bind', str(Path('/etc/resolv.conf').resolve(strict=True)), '/etc/resolv.conf']
    args += ['--bind', str(source), '/work', '--bind', str(state), '/state',
             '--ro-bind', str(tooling), '/tooling', '--ro-bind', str(node.parent.parent), '/node',
             '--chdir', '/work', '--clearenv', '--setenv', 'PATH', '/node/bin:/usr/bin:/bin',
             '--setenv', 'HOME', '/state/home', '--setenv', 'XDG_CACHE_HOME', '/state/cache',
             '--setenv', 'XDG_DATA_HOME', '/state/data', '--setenv', 'XDG_CONFIG_HOME', '/state/config',
             '--setenv', 'TMPDIR', '/tmp', '--setenv', 'CI', '1',
             '--setenv', 'NODE_OPTIONS', '--max-old-space-size=4096',
             '--setenv', 'npm_config_cache', '/state/npm-cache',
             '--setenv', 'PNPM_HOME', '/state/pnpm-home',
             '/node/bin/node', '/tooling/package/bin/pnpm.cjs']
    return args


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--yes', action='store_true', required=True)
    args = parser.parse_args()
    require(args.download or args.build)
    pins = json.loads(PINS.read_text())
    source = Path(args.source).resolve(strict=True)
    node = Path(args.node).resolve(strict=True)
    build = ROOT / 'build'
    require(source.parent == build and source.is_dir() and node.is_file())
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    tree = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}'], text=True).strip()
    require(revision == pins['revision'] and tree == pins['tree'])
    for name, field in [('pnpm-lock.yaml', 'lock_sha256'), ('pnpm-workspace.yaml', 'workspace_sha256'),
                        ('LICENSE', 'license_sha256')]:
        require(digest(source / name) == pins[field])
    require(subprocess.check_output([str(node), '--version'], text=True).strip() == 'v24.19.0')
    require(shutil.disk_usage(build).free >= 8 * 1024**3, 'At least 8 GiB free scratch required')
    tooling = build / 'pnpm-11.27.0'
    state = build / 'web-ui-build-state'
    state.mkdir(mode=0o700, exist_ok=True)
    for name in ('home', 'cache', 'config', 'data', 'npm-cache', 'pnpm-home', 'store'):
        (state / name).mkdir(mode=0o700, exist_ok=True)
    if args.download:
        tool(pins, tooling)
        print(json.dumps(dict(stage='frozen-dependencies', lifecycle_scripts=False, global_install=False)), flush=True)
        subprocess.run(sandbox(source, state, tooling, node, True) + [
            'install', '--frozen-lockfile', '--ignore-scripts', '--no-runtime',
            '--store-dir', '/state/store', '--child-concurrency=2', '--network-concurrency=8'], check=True)
    if args.build:
        require(tooling.is_dir())
        tool(pins, tooling)  # Reverify existing tool bytes; cannot download in this branch.
        patch = ROOT / pins['patch']
        require(patch.is_file())
        difference = subprocess.check_output(['git', '-C', str(source), 'diff', '--binary', 'HEAD'])
        require(difference == patch.read_bytes(), 'Source must match the reviewed owner-recovery patch exactly')
        print(json.dumps(dict(stage='offline-vite-build', source=revision, patch_sha256=digest(patch))), flush=True)
        subprocess.run(sandbox(source, state, tooling, node, False) + ['exec', 'vite', 'build'], check=True)
        dist = source / 'dist'
        require((dist / 'index.html').is_file())
        shutil.copyfile(source / 'LICENSE', dist / 'UPSTREAM_LICENSE')
        files = {}
        for path in sorted(dist.rglob('*')):
            if path.is_file():
                require(not path.is_symlink())
                files[str(path.relative_to(dist))] = dict(bytes=path.stat().st_size, sha256=digest(path))
        report = dict(version=1, kind='opencloud-web-owner-recovery-build', source_revision=revision,
                      source_tree=tree, pins_sha256=digest(PINS), patch_sha256=digest(patch),
                      lock_sha256=pins['lock_sha256'], node='24.19.0', pnpm='11.27.0',
                      lifecycle_scripts=False, build_network=False, global_installation=False, files=files)
        (dist / 'BUILD_REPORT.json').write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        print(json.dumps(dict(built=True, files=len(files), report_sha256=digest(dist / 'BUILD_REPORT.json'))))
    require(digest(source / 'pnpm-lock.yaml') == pins['lock_sha256'])


if __name__ == '__main__':
    main()
