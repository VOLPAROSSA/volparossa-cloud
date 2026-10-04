#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Hold a Linux owner-workspace lock until the supervised parent's pipe closes."""
import fcntl
import os
from pathlib import Path
import signal
import stat
import sys

# Foreground shutdown signals also reach this supervised process. Keep the
# exclusive lock until the owner has drained work and closed its stdin pipe;
# releasing on the signal could admit a second writer during shutdown. Parent
# death also closes the pipe. The existing owner's bounded SIGKILL escalation
# still fails cleanup rather than fabricating a normal acknowledgement.
for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(signum, signal.SIG_IGN)

try:
    root = Path(sys.argv[1])
    info = root.lstat()
    if root.resolve(strict=True) != root or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError()
    fd = os.open(root / 'LOCK', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, 'rb') as held:
        info = os.fstat(held.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError()
        fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.write(1, b'LOCKED\n')
        while os.read(0, 1):
            pass
except (OSError, ValueError, IndexError):
    sys.exit(1)
