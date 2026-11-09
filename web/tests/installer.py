"""Isolated Linux installer regression. systemctl is a command-recording stub;
real release binaries, downloads, SHA256, enrollment and permissions are tested.
The separate Docker smoke exercises that same release binary's WSS and PTY.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import tarfile
import threading
import tomllib
import uuid

release = Path('/releases/downloads/agent') / ('v' + os.environ['AGENT_VERSION'])
installer = release / 'install.sh'
state = {'token': secrets.token_urlsafe(32), 'bad_hash': False, 'deny': False}


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if state['bad_hash'] and self.path.endswith('/SHA256SUMS'):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(('0' * 64 + '  blink-agent-linux-amd64.tar.gz\n' + '0' * 64 + '  blink-agent-linux-arm64.tar.gz\n').encode())
        else:
            super().do_GET()

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path == '/agent/enroll'
        if state['deny'] or payload['token'] != state['token']:
            self.send_response(401)
            self.end_headers()
            return
        assert len(payload['credential']) == 43
        state['credential'] = payload['credential']
        state['id'] = str(uuid.uuid4())
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'id': state['id']}).encode())


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory='/releases'))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://localhost:{server.server_port}'
Path('/etc/systemd/system').mkdir(parents=True, exist_ok=True)
Path('/usr/local/bin/systemctl').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> /tmp/systemctl-calls\nexit 0\n')
Path('/usr/local/bin/systemctl').chmod(0o755)


def run(*args, ok=True):
    result = subprocess.run(['bash', str(installer), '--server', origin, '--allow-insecure-localhost', *args], input=state['token'] + '\n', capture_output=True, text=True, timeout=45)
    assert state['token'] not in result.stdout + result.stderr
    assert (result.returncode == 0) == ok, result.stdout + result.stderr
    assert not list(Path('/var/tmp').glob('blink-install.*')), 'temporary token must be removed'
    return result


state['bad_hash'] = True
assert 'checksum' in run(ok=False).stderr.lower()
assert not Path('/usr/local/bin/blink-agent').exists()
state['bad_hash'] = False
state['deny'] = True
for args in ([], ['--enable-terminal']):
    assert 'Enrollment failed' in run(*args, ok=False).stderr
    assert not Path('/etc/blink-agent').exists(), 'failed enrollment should permit retry'
    assert not Path('/var/lib/blink-agent').exists()
    assert not Path('/etc/systemd/system/blink-agent.service.d').exists()
    assert not Path('/usr/local/libexec/blink-agent-update').exists()
state['deny'] = False
override = Path('/etc/systemd/system/blink-agent.service.d/terminal.conf')
# An existing local service policy must never be silently overwritten.
override.parent.mkdir()
override.write_text('[Service]\nUser=custom\n')
assert 'Existing' in run('--enable-terminal', ok=False).stderr
assert override.read_text() == '[Service]\nUser=custom\n'
shutil.rmtree(override.parent)
package = Path('/tmp/root-terminal-package')
package.mkdir()
arch = 'arm64' if os.uname().machine == 'aarch64' else 'amd64'
with tarfile.open(release / f'blink-agent-linux-{arch}.tar.gz') as archive:
    for name in ['enable-root-terminal.sh', 'root-terminal.conf.example', 'enable-auto-update.sh', 'update-agent.py', 'blink-agent-update.service', 'blink-agent-update.timer']:
        (package / name).write_bytes(archive.extractfile(name).read())
for terminal, auto_update in ((False, True), (True, True), (False, False)):
    state['token'] = secrets.token_urlsafe(32)
    run(*(['--enable-terminal'] if terminal else []), *([] if auto_update else ['--no-auto-update']))
    config = Path('/etc/blink-agent/config.toml')
    assert f'terminal_enabled = {str(terminal).lower()}' in config.read_text()
    settings = tomllib.loads(config.read_text())
    assert settings['allow_root_terminal'] == terminal
    assert settings['terminal_user'] == ('root' if terminal else 'blink-agent')
    assert override.exists() == terminal
    if terminal:
        assert override.read_bytes() == (package / 'root-terminal.conf.example').read_bytes()
    subprocess.run(['systemd-analyze', 'verify', '/etc/systemd/system/blink-agent.service'], check=True, timeout=15)
    assert config.stat().st_mode & 0o777 == 0o640
    identity = Path('/var/lib/blink-agent/identity.json')
    data = json.loads(identity.read_text())
    assert data['credential'] == state['credential'] and data['node_id'] == state['id']
    assert identity.stat().st_mode & 0o777 == 0o600
    assert identity.stat().st_uid == pwd.getpwnam('blink-agent').pw_uid != 0
    assert Path('/var/lib/blink-agent').stat().st_mode & 0o777 == 0o700
    calls = Path('/tmp/systemctl-calls').read_text().splitlines()
    if auto_update:
        assert calls[-2:] == ['daemon-reload', 'enable --now blink-agent-update.timer']
        assert Path('/usr/local/libexec/blink-agent-update').stat().st_uid == 0
        assert Path('/var/lib/blink-agent-update').stat().st_mode & 0o777 == 0o700
        subprocess.run(['systemd-analyze', 'verify', '/etc/systemd/system/blink-agent-update.service', '/etc/systemd/system/blink-agent-update.timer'], check=True, timeout=15)
    else:
        assert calls[-2:] == ['enable --now blink-agent', 'is-active --quiet blink-agent']
        assert not Path('/usr/local/libexec/blink-agent-update').exists()
    assert Path('/usr/local/libexec/blink-proxy/manager.py').stat().st_uid == 0
    assert Path('/var/lib/blink-proxy/manager').stat().st_mode & 0o777 == 0o700
    assert 'enable --now blink-proxy-manager' in calls
    subprocess.run(['systemd-analyze', 'verify', '/etc/systemd/system/blink-proxy-manager.service'], check=True, timeout=15)
    assert 'Existing' in run(ok=False).stderr
    assert json.loads(identity.read_text()) == data, 'repeat install must preserve identity'
    sample = json.loads(subprocess.check_output(['runuser', '-u', 'blink-agent', '--', '/usr/local/bin/blink-agent', 'inspect']))
    assert sample['memoryTotal'] > 0 and sample['cores']
    # Migrate existing agents without re-enrollment, preserving local settings,
    # config ownership and the first backup across repeated invocations.
    original = config.read_text() + '\nsample_seconds = 10\n# local settings\n'
    if not terminal:
        original = original.replace('terminal_user =', '"terminal_user" =').replace('allow_root_terminal =', "'allow_root_terminal' =")
    config.write_text(original)
    owner = (config.stat().st_uid, config.stat().st_gid)
    for _ in range(2):
        subprocess.run(['bash', str(package / 'enable-root-terminal.sh')], check=True, timeout=15)
        migrated = tomllib.loads(config.read_text())
        assert migrated == {**tomllib.loads(original), 'terminal_enabled': True, 'terminal_user': 'root', 'allow_root_terminal': True}
        assert '# local settings' in config.read_text()
        assert config.with_name('config.toml.before-root-terminal').read_text() == original
        assert config.stat().st_mode & 0o777 == 0o640
        assert (config.stat().st_uid, config.stat().st_gid) == owner
        assert json.loads(identity.read_text()) == data
        assert override.read_bytes() == (package / 'root-terminal.conf.example').read_bytes()
        assert override.stat().st_mode & 0o777 == 0o644
        assert Path('/tmp/systemctl-calls').read_text().splitlines()[-3:] == ['daemon-reload', 'restart blink-agent', 'is-active --quiet blink-agent']
        assert not list(config.parent.glob('config.toml.root.*'))
    subprocess.run(['systemd-analyze', 'verify', '/etc/systemd/system/blink-agent.service'], check=True, timeout=15)
    shutil.rmtree(override.parent)
    if not auto_update:
        before = config.read_bytes()
        calls_before = len(Path('/tmp/systemctl-calls').read_text().splitlines())
        subprocess.run(['bash', str(package / 'enable-auto-update.sh')], check=True, timeout=15)
        assert config.read_bytes() == before and json.loads(identity.read_text()) == data
        calls = Path('/tmp/systemctl-calls').read_text().splitlines()[calls_before:]
        assert 'restart blink-agent' not in calls
        assert calls[-1] == 'enable --now blink-agent-update.timer'
        auto_update = True
    if auto_update:
        shutil.rmtree('/var/lib/blink-agent-update')
        for file in ['/usr/local/libexec/blink-agent-update', '/etc/systemd/system/blink-agent-update.service', '/etc/systemd/system/blink-agent-update.timer']:
            Path(file).unlink()
    for directory in ['/etc/blink-agent', '/var/lib/blink-agent']:
        shutil.rmtree(directory)
    for file in ['/usr/local/bin/blink-agent', '/etc/systemd/system/blink-agent.service']:
        Path(file).unlink()
bad_origin = subprocess.run(['bash', str(installer), '--server', 'http://example.com', '--allow-insecure-localhost'], capture_output=True, text=True)
assert bad_origin.returncode != 0 and 'HTTPS' in bad_origin.stderr
server.shutdown()
subprocess.run(['python3', '/updater/test-updater.py'], check=True, timeout=60)
print('PASS release installer: checksum rejection, enrollment rollback, private identity, non-root metrics, root terminal, auto-update opt-out and migration, duplicate protection, temp cleanup (systemctl stubbed)')
