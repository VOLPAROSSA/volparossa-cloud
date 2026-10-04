#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""One private DAV file in standard OpenPGP; no networking or peer operations."""
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile

VENDOR = Path(__file__).resolve().parents[1] / 'vendor/volparossa-image/immich_snapshot.py'
spec = importlib.util.spec_from_file_location('cloud_openpgp', VENDOR)
CRYPTO = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CRYPTO)
require = CRYPTO.require
MAX_BYTES = 8 * 1024**3
MAX_METADATA = 65536
RECEIPT_KEYS = {'version', 'kind', 'cipher_file', 'cipher_sha256', 'cipher_bytes', 'encryption', 'source_consistency'}


def directory(value):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'PRIVATE_DIRECTORY_REQUIRED')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_DIRECTORY_REQUIRED')
    return path


@contextmanager
def private_file(value, maximum):
    path = Path(value)
    directory(path.parent)
    require(path.resolve(strict=True) == path, 'PRIVATE_FILE_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and 0 <= info.st_size <= maximum, 'PRIVATE_FILE_REQUIRED')
        yield stream, info
        require(CRYPTO.identity(os.fstat(stream.fileno())) == CRYPTO.identity(info), 'INPUT_CHANGED')


def json_value(encoded):
    def pairs(items):
        value = {}
        for key, entry in items:
            require(key not in value, 'DUPLICATE_METADATA_KEY')
            value[key] = entry
        return value
    return json.loads(encoded, object_pairs_hook=pairs)


def source_metadata(value):
    if isinstance(value, dict) and value.get('kind') == 'owner-upload':
        require(set(value) == {'kind', 'space', 'name', 'size', 'sha256', 'lastModified'}
                and all(isinstance(value[key], str) and 0 < len(value[key].encode()) <= 1024
                    and value[key] not in ('.', '..') and not re.search(r'[\\/\x00-\x1f\x7f]', value[key])
                    for key in ('space', 'name'))
                and type(value['size']) is int and 0 <= value['size'] <= MAX_BYTES
                and isinstance(value['sha256'], str) and re.fullmatch('[0-9a-f]{64}', value['sha256'])
                and value['lastModified'] is None, 'UPLOAD_METADATA_INVALID')
        return value
    require(isinstance(value, dict) and set(value) == {'url', 'size', 'etag', 'lastModified'}, 'SOURCE_METADATA_INVALID')
    require(type(value['size']) is int and 0 <= value['size'] <= MAX_BYTES
            and isinstance(value['url'], str) and 0 < len(value['url']) <= 16384
            and isinstance(value['etag'], str) and re.fullmatch(r'"[\x21\x23-\x7e]{0,1024}"', value['etag'])
            and (value['lastModified'] is None or isinstance(value['lastModified'], str)
                 and len(value['lastModified']) <= 16384), 'SOURCE_METADATA_INVALID')
    return value


def receipt(value):
    require(isinstance(value, dict) and set(value) == RECEIPT_KEYS
            and (value['version'], value['source_consistency']) in (
                (1, 'strong-etag-conditional-ranges'), (2, 'owner-upload-snapshot'))
            and value['kind'] == 'volparossa-cloud-private-file' and value['cipher_file'] == 'file.pgp'
            and value['encryption'] == 'OpenPGP-AES256'
            and type(value['cipher_bytes']) is int and 1 <= value['cipher_bytes'] <= MAX_BYTES + 1024**2
            and re.fullmatch('[0-9a-f]{64}', value['cipher_sha256']), 'RECEIPT_INVALID')
    return value


def hash_file(path, maximum):
    with private_file(path, maximum) as (stream, info):
        return hashlib.file_digest(stream, 'sha256').hexdigest(), info.st_size


def publish(staging, target):
    # Persist the private directory entries as well as the already-fsynced files
    # before the existing atomic no-replace publication and parent fsync.
    fd = os.open(staging, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    CRYPTO.publish(staging, target)


def create(source, metadata, output):
    with private_file(metadata, MAX_METADATA) as (stream, _):
        selected = source_metadata(json_value(stream.read(MAX_METADATA + 1)))
    parent = directory(Path(output).parent)
    target = CRYPTO.new_target(output, Path(source))
    staging = Path(tempfile.mkdtemp(prefix='f-', dir=parent))
    try:
        key = secrets.token_hex(32).encode('ascii')
        CRYPTO.private_write(staging / 'recovery.key', key + b'\n')
        cipher = staging / 'file.pgp'
        with private_file(source, MAX_BYTES) as (input_file, info):
            require(info.st_size == selected['size'], 'SOURCE_SIZE_CHANGED')
            with open(os.open(cipher, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as encrypted:
                with CRYPTO.private_agent(parent) as home:
                    with CRYPTO.crypt_process(home, key, encrypt=True, output=encrypted, timeout_seconds=3600) as process:
                        with tarfile.open(fileobj=process.stdin, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                            member = tarfile.TarInfo('content.bin')
                            member.mode, member.size = 0o600, info.st_size
                            reader = CRYPTO.HashedReader(input_file)
                            archive.addfile(member, reader)
                            require(input_file.read(1) == b'', 'SOURCE_SIZE_CHANGED')
                            if selected.get('kind') == 'owner-upload':
                                require(reader.hash.hexdigest() == selected['sha256'], 'UPLOAD_SOURCE_CHANGED')
                            manifest = CRYPTO.canonical(dict(version=1, kind='volparossa-cloud-file-content',
                                source=selected, content_sha256=reader.hash.hexdigest(), content_bytes=info.st_size))
                            require(len(manifest) <= MAX_METADATA, 'METADATA_LIMIT')
                            member = tarfile.TarInfo('metadata.json')
                            member.mode, member.size = 0o600, len(manifest)
                            archive.addfile(member, io.BytesIO(manifest))
                        process.stdin.close()
                encrypted.flush()
                os.fsync(encrypted.fileno())
        digest, length = hash_file(cipher, MAX_BYTES + 1024**2)
        upload = selected.get('kind') == 'owner-upload'
        result = receipt(dict(version=2 if upload else 1, kind='volparossa-cloud-private-file', cipher_file='file.pgp',
            cipher_sha256=digest, cipher_bytes=length, encryption='OpenPGP-AES256',
            source_consistency='owner-upload-snapshot' if upload else 'strong-etag-conditional-ranges'))
        CRYPTO.private_write(staging / 'receipt.json', CRYPTO.canonical(result) + b'\n')
        publish(staging, target)
        return result
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def unpack(source, staging, owner_upload):
    with tarfile.open(fileobj=source, mode='r|') as archive:
        member = archive.next()
        require(member is not None and member.name == 'content.bin' and member.isreg()
                and not member.linkname and 0 <= member.size <= MAX_BYTES, 'INVALID_CONTENT_ENTRY')
        expected_bytes = member.size
        digest = hashlib.sha256()
        with archive.extractfile(member) as contents, open(os.open(staging / 'content.bin',
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as output:
            remaining = expected_bytes
            while remaining:
                chunk = contents.read(min(remaining, 65536))
                require(chunk, 'TRUNCATED_CONTENT')
                remaining -= len(chunk)
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        member = archive.next()
        require(member is not None and member.name == 'metadata.json' and member.isreg()
                and not member.linkname and 0 < member.size <= MAX_METADATA, 'INVALID_METADATA_ENTRY')
        with archive.extractfile(member) as stream:
            encoded = stream.read(MAX_METADATA + 1)
        value = json_value(encoded)
        require(isinstance(value, dict) and set(value) == {'version', 'kind', 'source', 'content_sha256', 'content_bytes'}
                and value['version'] == 1 and value['kind'] == 'volparossa-cloud-file-content'
                and value['content_bytes'] == expected_bytes
                and value['content_sha256'] == digest.hexdigest(), 'CONTENT_MANIFEST_MISMATCH')
        selected = source_metadata(value['source'])
        require((selected.get('kind') == 'owner-upload') == owner_upload, 'CONTENT_SOURCE_MISMATCH')
        require(selected['size'] == expected_bytes, 'CONTENT_SOURCE_MISMATCH')
        if selected.get('kind') == 'owner-upload':
            require(selected['sha256'] == digest.hexdigest(), 'UPLOAD_SOURCE_CHANGED')
        require(archive.next() is None, 'UNEXPECTED_ARCHIVE_ENTRY')
        CRYPTO.private_write(staging / 'metadata.json', CRYPTO.canonical(value) + b'\n')
    # Consume the GPG stream completely before awaiting its authenticated terminal status.
    trailing = 0
    while chunk := source.read(65536):
        trailing += len(chunk)
        require(trailing <= 10240 and not any(chunk), 'UNEXPECTED_ARCHIVE_TRAILER')
    return expected_bytes


def restore(bundle, cipher_path, output):
    bundle = directory(bundle)
    with private_file(bundle / 'receipt.json', 4096) as (stream, _):
        expected = receipt(json_value(stream.read(4097)))
    with private_file(bundle / 'recovery.key', 65) as (stream, info):
        raw = stream.read(66)
        require(info.st_size == 65 and re.fullmatch(rb'[0-9a-f]{64}\n', raw), 'RECOVERY_KEY_INVALID')
        key = raw[:-1]
    target = CRYPTO.new_target(output, bundle)
    parent = directory(target.parent)
    require(target != Path(cipher_path) and not Path(cipher_path).is_relative_to(target), 'OUTPUT_OVERLAP')
    staging = Path(tempfile.mkdtemp(prefix='r-', dir=parent))
    try:
        with private_file(cipher_path, MAX_BYTES + 1024**2) as (cipher, info):
            require(info.st_size == expected['cipher_bytes']
                    and hashlib.file_digest(cipher, 'sha256').hexdigest() == expected['cipher_sha256'], 'CIPHER_IDENTITY_MISMATCH')
            cipher.seek(0)
            with CRYPTO.private_agent(parent) as home:
                with CRYPTO.crypt_process(home, key, encrypt=False, output=subprocess.PIPE,
                        timeout_seconds=3600, input_stream=cipher) as process:
                    length = unpack(process.stdout, staging, expected['version'] == 2)
        # No plaintext output becomes visible at the requested path before GOODMDC,
        # exact ciphertext identity and the encrypted content manifest all agree.
        publish(staging, target)
        return dict(version=1, kind='volparossa-cloud-private-restore', restored=True,
                    bytes=length, openpgp_integrity_verified=True, manifest_verified=True,
                    cipher_sha256=expected['cipher_sha256'])
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    encrypt = commands.add_parser('encrypt')
    encrypt.add_argument('--source', required=True)
    encrypt.add_argument('--metadata', required=True)
    encrypt.add_argument('--output', required=True)
    decrypt = commands.add_parser('decrypt')
    decrypt.add_argument('--bundle', required=True)
    decrypt.add_argument('--cipher', required=True)
    decrypt.add_argument('--output', required=True)
    args = parser.parse_args()
    result = create(args.source, args.metadata, args.output) if args.operation == 'encrypt' else restore(args.bundle, args.cipher, args.output)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise InterruptedError('PRIVATE_FILE_INTERRUPTED')
    for kind in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(kind, interrupted)
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.SubprocessError, CRYPTO.SnapshotError):
        print(json.dumps({'success': False, 'code': 'PRIVATE_FILE_OPERATION_FAILED'}), file=sys.stderr)
        raise SystemExit(1)
