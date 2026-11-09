#!/usr/bin/env python3
"""Mirror pinned, checksum-verified upstream binaries into the Master image."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def main():
    manifest = json.loads((ROOT / 'deploy/agent/proxy-assets.json').read_text())
    output = ROOT / 'web/public/downloads/proxy'
    output.mkdir(parents=True, exist_ok=True)
    for engine in manifest.values():
        for arch in ('amd64', 'arm64'):
            asset = engine[arch]
            target = output / asset['file']
            if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == asset['sha256']:
                continue
            request = urllib.request.Request(asset['url'], headers={'User-Agent': 'BlinkNode-release'})
            with urllib.request.urlopen(request, timeout=180) as response:
                data = response.read(100 * 1024 * 1024 + 1)
            if len(data) > 100 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != asset['sha256']:
                raise RuntimeError('Proxy release checksum mismatch: ' + asset['file'])
            temporary = target.with_suffix(target.suffix + '.tmp')
            temporary.write_bytes(data)
            temporary.replace(target)
            print('Verified ' + asset['file'])


if __name__ == '__main__':
    main()
