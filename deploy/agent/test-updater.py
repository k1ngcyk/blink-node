"""Updater regression with real HTTP, archives, files and executable validation."""
import hashlib
import http.server
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('update-agent.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def executable(version, build):
    return f"#!/bin/sh\nprintf 'blink-agent {version}\\n'\n# build {build}\n".encode()


class Service:
    def __init__(self, binary):
        self.binary = binary
        self.running = True
        self.good = True
        self.restarts = []

    def active(self):
        return self.running

    def restart(self):
        self.restarts.append(self.binary.read_bytes())

    def healthy(self):
        return self.good


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / 'blink-agent'
        self.old = executable('0.1.0', 'old')
        self.binary.write_bytes(self.old)
        self.binary.chmod(0o755)
        self.directory = self.root / 'state'
        self.service = Service(self.binary)
        self.files = {}
        self.requests = []
        self.redirect = False
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                owner.requests.append(self.path)
                if owner.redirect:
                    self.send_response(302)
                    self.send_header('Location', '/redirected')
                    self.end_headers()
                    return
                data = owner.files.get(self.path)
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.config = self.root / 'config.toml'
        self.config.write_text(f'server_url = "http://localhost:{self.server.server_port}"\nallow_insecure_localhost = true\nterminal_user = "root"\n')
        self.identity = self.root / 'identity.json'
        self.identity.write_text('preserve-existing-credential')
        self.arch = patch.object(updater.platform, 'machine', return_value='x86_64')
        self.arch.start()
        self.addCleanup(self.arch.stop)
        self.publish()

    def publish(self, version='0.1.1', binary=None, symlink=False):
        self.new = binary if binary is not None else executable(version, 'new')
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            member = tarfile.TarInfo('blink-agent')
            if symlink:
                member.type = tarfile.SYMTYPE
                member.linkname = '/etc/passwd'
                archive.addfile(member)
            else:
                member.size = len(self.new)
                archive.addfile(member, io.BytesIO(self.new))
            # The updater must never extract or execute packaged scripts.
            extra = tarfile.TarInfo('../should-not-exist')
            extra.size = 4
            archive.addfile(extra, io.BytesIO(b'evil'))
        data = buffer.getvalue()
        self.manifest = {'schema': 1, 'version': version, 'artifacts': {'amd64': {
            'sha256': hashlib.sha256(data).hexdigest(),
            'binary_sha256': hashlib.sha256(self.new).hexdigest(),
            'size': len(data),
        }}}
        self.files[f'/downloads/agent/v{version}/blink-agent-linux-amd64.tar.gz'] = data
        self.publish_manifest()

    def publish_manifest(self):
        self.files['/downloads/agent/latest.json'] = json.dumps(self.manifest).encode()

    def run_update(self, **options):
        return updater.update(self.config, self.binary, self.directory, self.service, **options)

    def state(self):
        return updater.load_state(self.directory)

    def test_success_keeps_identity_config_and_backup(self):
        config = self.config.read_bytes()
        self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.new)
        self.assertEqual(self.binary.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.config.read_bytes(), config)
        self.assertEqual(self.identity.read_text(), 'preserve-existing-credential')
        self.assertEqual((self.directory / 'previous-agent').read_bytes(), self.old)
        self.assertNotIn('pending', self.state())
        self.assertFalse((self.root / 'should-not-exist').exists())
        self.assertEqual(self.service.restarts, [self.new])
        self.run_update()
        self.assertEqual(self.service.restarts, [self.new])

    def test_same_version_rebuild_updates_by_binary_hash(self):
        self.publish('0.1.0')
        self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.new)

    def test_downgrade_is_ignored(self):
        self.publish('0.0.9')
        self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.old)
        self.assertEqual(len(self.requests), 1)

    def test_check_does_not_install(self):
        self.run_update(check=True)
        self.assertEqual(self.binary.read_bytes(), self.old)
        self.assertEqual(self.service.restarts, [])
        self.assertEqual(len(self.requests), 1)

    def test_stopped_agent_is_not_started(self):
        self.service.running = False
        self.run_update()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.service.restarts, [])

    def test_master_without_manifest_does_not_break_agent(self):
        self.files.clear()
        self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.old)

    def test_archive_hash_mismatch_never_executes_or_replaces(self):
        self.manifest['artifacts']['amd64']['sha256'] = '0' * 64
        self.publish_manifest()
        with self.assertRaisesRegex(updater.UpdateError, 'archive SHA256'):
            self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.old)
        self.assertEqual(self.service.restarts, [])

    def test_binary_hash_mismatch_is_rejected(self):
        self.manifest['artifacts']['amd64']['binary_sha256'] = '0' * 64
        self.publish_manifest()
        with self.assertRaisesRegex(updater.UpdateError, 'binary SHA256'):
            self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.old)

    def test_wrong_version_is_rejected(self):
        self.publish(binary=executable('0.2.0', 'wrong-version'))
        with self.assertRaisesRegex(updater.UpdateError, 'version mismatch'):
            self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.old)

    def test_symlink_binary_is_rejected(self):
        self.publish(symlink=True)
        with self.assertRaisesRegex(updater.UpdateError, 'regular file'):
            self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.old)

    def test_failed_health_rolls_back_and_quarantines_build(self):
        self.service.good = False
        with self.assertRaisesRegex(updater.UpdateError, 'health check'):
            self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.old)
        self.assertEqual(self.service.restarts, [self.new, self.old])
        self.assertEqual(self.state()['failed_sha256'], hashlib.sha256(self.new).hexdigest())
        self.run_update()
        self.assertEqual(self.service.restarts, [self.new, self.old])
        self.service.good = True
        self.run_update(retry_failed=True)
        self.assertEqual(self.binary.read_bytes(), self.new)

    def test_interrupted_update_recovers_before_network_access(self):
        self.directory.mkdir()
        (self.directory / 'previous-agent').write_bytes(self.old)
        updater.save_state(self.directory, {'pending': {
            'backup_sha256': hashlib.sha256(self.old).hexdigest(),
            'target_sha256': hashlib.sha256(self.new).hexdigest(),
        }})
        self.binary.write_bytes(self.new)
        self.service.running = False
        self.run_update()
        self.assertEqual(self.binary.read_bytes(), self.old)
        self.assertEqual(self.requests, [])
        self.assertNotIn('pending', self.state())

    def test_corrupt_recovery_backup_preserves_transaction(self):
        self.directory.mkdir()
        (self.directory / 'previous-agent').write_bytes(b'corrupt')
        updater.save_state(self.directory, {'pending': {'backup_sha256': '0' * 64, 'target_sha256': '1' * 64}})
        with self.assertRaisesRegex(updater.UpdateError, 'corrupt'):
            self.run_update()
        self.assertIn('pending', self.state())
        self.assertEqual(self.binary.read_bytes(), self.old)

    def test_redirect_is_not_followed(self):
        self.redirect = True
        with self.assertRaisesRegex(updater.UpdateError, 'redirect'):
            self.run_update()
        self.assertEqual(len(self.requests), 1)

    def test_public_http_and_url_credentials_are_rejected(self):
        for origin in ('http://example.com', 'https://user:pass@example.com', 'https://example.com/path'):
            with self.subTest(origin=origin):
                self.config.write_text(f'server_url = "{origin}"\nallow_insecure_localhost = true\n')
                with self.assertRaises(updater.UpdateError):
                    self.run_update()

    def test_manifest_limits_and_versions(self):
        for size in (0, True, updater.MAX_DOWNLOAD + 1):
            self.manifest['artifacts']['amd64']['size'] = size
            with self.assertRaises(updater.UpdateError):
                updater.release_metadata(self.manifest, 'amd64')
        for version in ('../1.0', '0.1.0/evil', '01.0.0', '1.2', '1.2.3;id'):
            with self.assertRaises(updater.UpdateError):
                updater.version_tuple(version)

    def test_size_limit_is_enforced(self):
        self.files['/large'] = b'x' * 100
        with self.assertRaisesRegex(updater.UpdateError, 'size limit'):
            updater.fetch(f'http://localhost:{self.server.server_port}/large', io.BytesIO(), 20)

    def test_python_39_config_reader(self):
        origin = f'http://localhost:{self.server.server_port}'
        with patch.dict('sys.modules', {'tomllib': None}):
            self.assertEqual(updater.master_origin(self.config), origin)
            self.config.write_text(f"'server_url' = '{origin}' # comment\nallow_insecure_localhost = true # comment\n")
            self.assertEqual(updater.master_origin(self.config), origin)
            with self.config.open('a') as config:
                config.write(f'\nserver_url = "{origin}"\n')
            with self.assertRaisesRegex(updater.UpdateError, 'Duplicate'):
                updater.master_origin(self.config)


class HealthTests(unittest.TestCase):
    def check(self, connected=True, restart=False, running=True):
        clock = [0]
        service = updater.Service()

        def properties():
            return {'ActiveState': 'active', 'SubState': 'running' if running else 'exited',
                    'MainPID': '123', 'InvocationID': 'second' if restart and clock[0] else 'first'}

        def sleep(seconds):
            clock[0] += seconds

        message = 'Connected to master' if connected else 'Control connection lost; retrying'
        output = json.dumps({'fields': {'message': message}})
        with patch.object(service, 'properties', side_effect=properties), \
                patch.object(updater.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(updater.time, 'sleep', side_effect=sleep), \
                patch.object(updater.subprocess, 'run', return_value=SimpleNamespace(stdout=output)):
            return service.healthy(timeout=15), clock[0]

    def test_requires_connection_and_ten_seconds_stability(self):
        self.assertEqual(self.check(), (True, 10))

    def test_unconnected_process_is_not_healthy(self):
        self.assertEqual(self.check(connected=False), (False, 15))

    def test_crash_and_restart_is_not_healthy(self):
        self.assertEqual(self.check(restart=True), (False, 1))

    def test_exited_process_is_not_healthy(self):
        self.assertEqual(self.check(running=False), (False, 0))


class OpenRCIdentityTests(unittest.TestCase):
    def test_native_and_binfmt_children_reject_other_programs_and_zombies(self):
        binary = str(updater.BINARY).encode()
        stat = '123 (blink-agent) S ' + '0 ' * 18 + '12345'
        for cmdline, expected in (
            (binary + b'\0run\0', True),
            (b'/usr/bin/qemu-aarch64\0' + binary + b'\0run\0', True),
            (b'/usr/bin/qemu-x86_64-static\0' + binary + b'\0run\0', True),
            (b'/bin/sh\0' + binary + b'\0', False),
            (b'/usr/bin/qemu-aarch64\0/bin/sh\0' + binary + b'\0', False),
        ):
            with self.subTest(cmdline=cmdline), \
                 patch.object(updater.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(stdout='123:started')]), \
                 patch.object(updater.Path, 'read_text', return_value=stat), \
                 patch.object(updater.Path, 'read_bytes', return_value=cmdline):
                self.assertEqual(updater.OpenRCService().active(), expected)
        with patch.object(updater.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(stdout='123:started')]), \
             patch.object(updater.Path, 'read_text', return_value=stat.replace(') S ', ') Z ')), \
             patch.object(updater.Path, 'read_bytes', return_value=binary):
            self.assertFalse(updater.OpenRCService().active())


if __name__ == '__main__':
    unittest.main()
