#!/usr/bin/env python3
"""Installed root-owned on the Master; CI supplies only a full commit SHA."""
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

BASE = Path('/opt/blink-node')
IMAGE = 'registry.windgyre.com/library/blink-node-web'


def atomic_write(path, data):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name + '-')
    try:
        with os.fdopen(fd, 'wb') as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def with_image(data, image):
    text = data.decode()
    pattern = r'^(?:export\s+)?BLINK_IMAGE=.*$'
    line = 'BLINK_IMAGE=' + image
    if re.search(pattern, text, flags=re.MULTILINE):
        return re.sub(pattern, line, text, flags=re.MULTILINE).encode()
    return (text.rstrip() + '\n' + line + '\n').encode()


class Docker:
    def __init__(self, base):
        self.base = base

    def compose(self, env, *args, timeout=240):
        subprocess.run(['docker', 'compose', '--env-file', str(env), '-f',
                        str(self.base / 'deploy/compose.yml'), *args], check=True, timeout=timeout)

    def pull(self, revision):
        tag = IMAGE + ':' + revision
        subprocess.run(['docker', 'pull', tag], check=True, timeout=600)
        result = subprocess.run(['docker', 'image', 'inspect', tag, '--format', '{{json .RepoDigests}}'],
                                check=True, capture_output=True, text=True, timeout=30)
        for digest in json.loads(result.stdout):
            if re.fullmatch(re.escape(IMAGE) + r'@sha256:[a-f0-9]{64}', digest):
                return digest
        raise RuntimeError('Pulled image has no expected registry digest')

    def migrate(self, env):
        self.compose(env, 'run', '--rm', '--no-deps', '--pull', 'never', 'migrate')

    def activate(self, env):
        self.compose(env, 'up', '-d', '--no-deps', '--pull', 'never', '--wait',
                     '--wait-timeout', '120', 'web', 'gateway')

    def verify(self, env):
        # Healthchecks cover Web/gateway; additionally verify the Agent update feed.
        self.compose(env, 'exec', '-T', 'web', 'node', '-e',
                     "fetch('http://127.0.0.1:3000/downloads/agent/latest.json')"
                     ".then(async r=>{const m=await r.json();if(!r.ok||m.schema!==1||"
                     "!m.artifacts?.amd64||!m.artifacts?.arm64)throw Error('Invalid update feed')})"
                     ".catch(e=>{console.error(e.message);process.exit(1)})", timeout=30)


def deploy(revision, base=BASE, docker=None):
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('Expected exactly one full Git commit SHA')
    docker = docker or Docker(base)
    env = base / '.env'
    if env.is_symlink() or not env.is_file():
        raise RuntimeError('Missing regular Master .env file')
    history = base / '.deploy'
    history.mkdir(mode=0o700, exist_ok=True)
    history.chmod(0o700)
    with (history / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        pending = history / 'pending.json'
        if pending.exists():
            recovery = json.loads(pending.read_text())
            backup = history / recovery['backup']
            if backup.parent != history or not backup.name.endswith('.env'):
                raise RuntimeError('Invalid deployment recovery path')
            atomic_write(env, backup.read_bytes())
            docker.activate(env)
            pending.unlink()
            print('Recovered the previous Master image after an interrupted deployment.', flush=True)
        digest = docker.pull(revision)
        original = env.read_bytes()
        timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = history / f'{timestamp}-{revision[:12]}.env'
        atomic_write(backup, original)
        candidate = history / 'candidate.env'
        atomic_write(candidate, with_image(original, digest))
        try:
            # Existing migrations run in a database transaction. Keep old services
            # running until migrations succeed; image rollback doesn't undo schema.
            docker.migrate(candidate)
            atomic_write(pending, json.dumps({'backup': backup.name, 'revision': revision}).encode())
            try:
                atomic_write(env, candidate.read_bytes())
                docker.activate(env)
                docker.verify(env)
            except BaseException:
                atomic_write(env, original)
                docker.activate(env)
                pending.unlink()
                print('Deployment failed; previous image and .env restored.', flush=True)
                raise
            atomic_write(history / 'current.json', json.dumps({
                'revision': revision, 'image': digest, 'deployed_at': timestamp,
                'previous_env': backup.name,
            }, indent=2).encode())
            pending.unlink()
            print(f'Deployed {revision}: {digest}', flush=True)
        finally:
            candidate.unlink(missing_ok=True)


def interrupted(_signum, _frame):
    raise InterruptedError('Deployment interrupted')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        print('Usage (root): blink-node-deploy <40-character-commit-sha>', file=sys.stderr)
        return 1
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        deploy(sys.argv[1])
    except Exception as error:
        print(f'Master deployment failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
