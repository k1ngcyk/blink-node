import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('assets', Path(__file__).with_name('fetch-proxy-assets.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
DATA = b'verified release'
ASSET = {'url': 'https://github.com/example/release', 'file': 'core.tar.gz', 'sha256': hashlib.sha256(DATA).hexdigest()}
MIRROR = 'https://mirror.example/downloads/proxy'


class AssetTests(unittest.TestCase):
    def test_transient_failure_retries_then_falls_back_with_checksum(self):
        error = urllib.error.HTTPError(ASSET['url'], 504, 'Gateway Timeout', {}, None)
        with patch.object(assets.urllib.request, 'urlopen', side_effect=[error, error, error, io.BytesIO(DATA)]) as fetch, patch.object(assets.time, 'sleep'):
            self.assertEqual(assets.fetch_asset(ASSET, MIRROR), DATA)
            self.assertEqual(fetch.call_count, 4)
            self.assertEqual(fetch.call_args.args[0].full_url, MIRROR + '/' + ASSET['file'])

    def test_network_failure_recovers_without_mirror(self):
        with patch.object(assets.urllib.request, 'urlopen', side_effect=[urllib.error.URLError('offline'), io.BytesIO(DATA)]) as fetch, patch.object(assets.time, 'sleep'):
            self.assertEqual(assets.fetch_asset(ASSET), DATA)
            self.assertEqual(fetch.call_count, 2)

    def test_corrupt_or_oversized_download_never_publishes_or_falls_back(self):
        for content, limit in [(b'corrupt', 100), (DATA, 4)]:
            with self.subTest(content=content), patch.object(assets, 'MAX_DOWNLOAD', limit), patch.object(assets.urllib.request, 'urlopen', return_value=io.BytesIO(content)) as fetch:
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    assets.fetch_asset(ASSET, MIRROR)
                self.assertEqual(fetch.call_count, 1)

    def test_permanent_failure_skips_retries_and_checks_mirror(self):
        error = urllib.error.HTTPError(ASSET['url'], 404, 'Not Found', {}, None)
        with patch.object(assets.urllib.request, 'urlopen', side_effect=[error, io.BytesIO(DATA)]) as fetch:
            self.assertEqual(assets.fetch_asset(ASSET, MIRROR), DATA)
            self.assertEqual(fetch.call_count, 2)


if __name__ == '__main__':
    unittest.main()
