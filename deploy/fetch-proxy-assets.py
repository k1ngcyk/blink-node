#!/usr/bin/env python3
"""Mirror pinned, checksum-verified upstream binaries into the Master image."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
MAX_DOWNLOAD = 100 * 1024 * 1024


def fetch_asset(asset, mirror=''):
    urls = [asset['url']]
    if mirror:
        parsed = urllib.parse.urlsplit(mirror)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Proxy asset mirror must be an HTTPS URL without credentials')
        urls.append(mirror.rstrip('/') + '/' + asset['file'])
    for url in urls:
        for attempt in range(3):
            request = urllib.request.Request(url, headers={'User-Agent': 'BlinkNode-release'})
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    data = response.read(MAX_DOWNLOAD + 1)
            except urllib.error.HTTPError as error:
                if error.code not in (408, 429, 500, 502, 503, 504):
                    break
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead):
                pass
            else:
                # Mirror availability never relaxes the pinned integrity check.
                if len(data) > MAX_DOWNLOAD or hashlib.sha256(data).hexdigest() != asset['sha256']:
                    raise RuntimeError('Proxy release checksum mismatch: ' + asset['file'])
                return data
            if attempt < 2:
                print('Retrying proxy release download: ' + asset['file'], flush=True)
                time.sleep(2 ** attempt)
    raise RuntimeError('Cannot download proxy release from configured sources: ' + asset['file'])


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
            data = fetch_asset(asset, os.environ.get('BLINK_PROXY_ASSET_MIRROR', ''))
            temporary = target.with_suffix(target.suffix + '.tmp')
            temporary.write_bytes(data)
            temporary.replace(target)
            print('Verified ' + asset['file'])


if __name__ == '__main__':
    main()
