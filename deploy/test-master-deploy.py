import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('master_deploy', Path(__file__).with_name('master-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
REVISION = 'a' * 40
DIGEST = deploy.IMAGE + '@sha256:' + 'b' * 64


class Docker:
    def __init__(self, env):
        self.env = env
        self.original = env.read_bytes()
        self.calls = []
        self.fail = None

    def pull(self, revision):
        self.calls.append(('pull', revision))
        if self.fail == 'pull':
            raise RuntimeError('pull failed')
        return DIGEST

    def migrate(self, env):
        assert self.env.read_bytes() == self.original
        assert DIGEST.encode() in env.read_bytes()
        self.calls.append(('migrate', None))
        if self.fail == 'migrate':
            raise RuntimeError('migration failed')

    def activate(self, env):
        image = env.read_bytes()
        self.calls.append(('activate', image))
        if self.fail == 'activate' and DIGEST.encode() in image:
            raise RuntimeError('healthcheck failed')

    def verify(self, env):
        self.calls.append(('verify', None))
        if self.fail == 'verify':
            raise RuntimeError('update feed missing')


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.env = self.base / '.env'
        self.original = b'BLINK_DOMAIN=example.com\nBLINK_IMAGE=previous-image\nOTHER_SETTING=retain\n'
        self.env.write_bytes(self.original)
        self.docker = Docker(self.env)

    def run_deploy(self, revision=REVISION):
        deploy.deploy(revision, self.base, self.docker)

    def test_success_pins_digest_and_keeps_other_settings(self):
        self.run_deploy()
        self.assertEqual(self.env.read_bytes(), self.original.replace(b'previous-image', DIGEST.encode()))
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)
        state = json.loads((self.base / '.deploy/current.json').read_text())
        self.assertEqual(state['revision'], REVISION)
        self.assertEqual((self.base / '.deploy' / state['previous_env']).read_bytes(), self.original)
        self.assertFalse((self.base / '.deploy/pending.json').exists())
        self.assertEqual([c[0] for c in self.docker.calls], ['pull', 'migrate', 'activate', 'verify'])

    def test_failed_pull_or_migration_leaves_production_running(self):
        for failure in ('pull', 'migrate'):
            with self.subTest(failure=failure):
                self.docker.fail = failure
                with self.assertRaises(RuntimeError):
                    self.run_deploy()
                self.assertEqual(self.env.read_bytes(), self.original)
                self.assertNotIn('activate', [c[0] for c in self.docker.calls])

    def test_failed_health_or_feed_rolls_back_image_and_env(self):
        for failure in ('activate', 'verify'):
            with self.subTest(failure=failure):
                self.docker.fail = failure
                with self.assertRaises(RuntimeError):
                    self.run_deploy()
                self.assertEqual(self.env.read_bytes(), self.original)
                self.assertEqual(self.docker.calls[-1], ('activate', self.original))
                self.assertFalse((self.base / '.deploy/pending.json').exists())

    def test_interrupted_deployment_recovers_before_new_pull(self):
        history = self.base / '.deploy'
        history.mkdir()
        (history / 'previous.env').write_bytes(self.original)
        (history / 'pending.json').write_text(json.dumps({'backup': 'previous.env'}))
        self.env.write_bytes(b'BLINK_IMAGE=interrupted\n')
        self.run_deploy()
        self.assertEqual(self.docker.calls[0], ('activate', self.original))

    def test_untrusted_revision_never_reaches_docker(self):
        for revision in ('main', 'latest', 'a' * 39, 'a' * 40 + ';id', '../elsewhere'):
            with self.assertRaises(ValueError):
                self.run_deploy(revision)
        self.assertEqual(self.docker.calls, [])

    def test_rejects_recovery_path_outside_private_history(self):
        history = self.base / '.deploy'
        history.mkdir()
        (history / 'pending.json').write_text(json.dumps({'backup': '../outside.env'}))
        with self.assertRaisesRegex(RuntimeError, 'recovery path'):
            self.run_deploy()
        self.assertEqual(self.env.read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()
