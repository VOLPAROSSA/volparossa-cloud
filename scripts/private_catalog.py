#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Owner-local encrypted catalog using the existing supervised OpenPGP helpers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile

FILE = runpy.run_path(str(Path(__file__).with_name('private_file.py')))
CRYPTO = FILE['CRYPTO']
require = CRYPTO.require
MAX_BYTES = 2 * 1024**2
MAX_CIPHER = MAX_BYTES + 65536


def receipt(value):
    require(isinstance(value, dict) and set(value) == {'version', 'kind', 'cipher_file',
        'cipher_bytes', 'cipher_sha256', 'encryption'} and value['version'] == 1
        and value['kind'] == 'volparossa-cloud-private-catalog' and value['cipher_file'] == 'catalog.pgp'
        and value['encryption'] == 'OpenPGP-AES256' and type(value['cipher_bytes']) is int
        and 0 < value['cipher_bytes'] <= MAX_CIPHER and isinstance(value['cipher_sha256'], str)
        and re.fullmatch('[0-9a-f]{64}', value['cipher_sha256']), 'CATALOG_RECEIPT_INVALID')
    return value


def payload(encoded):
    require(0 < len(encoded) <= MAX_BYTES, 'CATALOG_LIMIT')
    value = FILE['json_value'](encoded)
    require(isinstance(value, dict) and set(value) == {'version', 'kind', 'entries'}
        and value['version'] == 1 and value['kind'] == 'volparossa-cloud-private-catalog-index'
        and isinstance(value['entries'], list) and 1 <= len(value['entries']) <= 256, 'CATALOG_INVALID')
    return value


def seal(output):
    encoded = sys.stdin.buffer.read(MAX_BYTES + 1)
    payload(encoded)
    parent = FILE['directory'](Path(output).parent)
    target = Path(output)
    require(target.is_absolute() and target.parent == parent
        and not target.exists() and not target.is_symlink(), 'CATALOG_OUTPUT_EXISTS')
    staging = Path(tempfile.mkdtemp(prefix='cat-', dir=parent))
    try:
        key = secrets.token_hex(32).encode('ascii')
        CRYPTO.private_write(staging / 'recovery.key', key + b'\n')
        cipher = staging / 'catalog.pgp'
        with open(os.open(cipher, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as encrypted:
            with CRYPTO.private_agent(parent) as home:
                with CRYPTO.crypt_process(home, key, encrypt=True, output=encrypted, timeout_seconds=90) as process:
                    process.stdin.write(encoded)
                    process.stdin.close()
            encrypted.flush()
            os.fsync(encrypted.fileno())
        digest, length = FILE['hash_file'](cipher, MAX_CIPHER)
        report = receipt(dict(version=1, kind='volparossa-cloud-private-catalog', cipher_file='catalog.pgp',
            cipher_bytes=length, cipher_sha256=digest, encryption='OpenPGP-AES256'))
        CRYPTO.private_write(staging / 'receipt.json', CRYPTO.canonical(report) + b'\n')
        FILE['publish'](staging, target)
        return report
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def decrypt(catalog):
    root = FILE['directory'](catalog)
    with FILE['private_file'](root / 'receipt.json', 4096) as (stream, _):
        expected = receipt(FILE['json_value'](stream.read(4097)))
    with FILE['private_file'](root / 'recovery.key', 65) as (stream, info):
        key = stream.read(66)
        require(info.st_size == 65 and re.fullmatch(rb'[a-f0-9]{64}\n', key), 'CATALOG_KEY_INVALID')
    with FILE['private_file'](root / 'catalog.pgp', MAX_CIPHER) as (cipher, info):
        require(info.st_size == expected['cipher_bytes']
            and hashlib.file_digest(cipher, 'sha256').hexdigest() == expected['cipher_sha256'], 'CATALOG_IDENTITY_MISMATCH')
        cipher.seek(0)
        with CRYPTO.private_agent(root.parent) as home:
            with CRYPTO.crypt_process(home, key[:-1], encrypt=False, output=subprocess.PIPE,
                    timeout_seconds=90, input_stream=cipher) as process:
                encoded = process.stdout.read(MAX_BYTES + 1)
                require(len(encoded) <= MAX_BYTES, 'CATALOG_LIMIT')
    # Private plaintext goes only through the caller's pipe after authenticated
    # GPG completion. No file, source URL, key or index is printed in diagnostics.
    return payload(encoded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    commands.add_parser('seal').add_argument('--output', required=True)
    commands.add_parser('decrypt').add_argument('--catalog', required=True)
    args = parser.parse_args()
    value = seal(args.output) if args.operation == 'seal' else decrypt(args.catalog)
    print(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False))


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise InterruptedError('CATALOG_INTERRUPTED')
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, CRYPTO.SnapshotError):
        print(json.dumps({'success': False, 'code': 'PRIVATE_CATALOG_OPERATION_FAILED'}), file=sys.stderr)
        raise SystemExit(1)
