#!/usr/bin/env python3
"""Publish latest.json only after both architecture artifacts are complete."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile

release = Path(sys.argv[1])
version = sys.argv[2]
manifest = {'schema': 1, 'version': version, 'artifacts': {}}
for arch in ('amd64', 'arm64'):
    path = release / f'blink-agent-linux-{arch}.tar.gz'
    with tarfile.open(path) as archive:
        binary_sha = hashlib.sha256(archive.extractfile('blink-agent').read()).hexdigest()
    manifest['artifacts'][arch] = {
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'binary_sha256': binary_sha,
        'size': path.stat().st_size,
    }
temporary = release.parent / '.latest.json.tmp'
temporary.write_text(json.dumps(manifest, indent=2) + '\n')
temporary.replace(release.parent / 'latest.json')
