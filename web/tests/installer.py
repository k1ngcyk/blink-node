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
import threading
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
assert 'Enrollment failed' in run(ok=False).stderr
assert not Path('/etc/blink-agent').exists(), 'failed enrollment should permit retry'
assert not Path('/var/lib/blink-agent').exists()
state['deny'] = False
for terminal in (False, True):
    state['token'] = secrets.token_urlsafe(32)
    run(*(['--enable-terminal'] if terminal else []))
    config = Path('/etc/blink-agent/config.toml')
    assert f'terminal_enabled = {str(terminal).lower()}' in config.read_text()
    assert 'allow_root_terminal = false' in config.read_text()
    assert config.stat().st_mode & 0o777 == 0o640
    identity = Path('/var/lib/blink-agent/identity.json')
    data = json.loads(identity.read_text())
    assert data['credential'] == state['credential'] and data['node_id'] == state['id']
    assert identity.stat().st_mode & 0o777 == 0o600
    assert identity.stat().st_uid == pwd.getpwnam('blink-agent').pw_uid != 0
    assert Path('/var/lib/blink-agent').stat().st_mode & 0o777 == 0o700
    assert Path('/tmp/systemctl-calls').read_text().splitlines()[-3:] == ['daemon-reload', 'enable --now blink-agent', 'is-active --quiet blink-agent']
    assert 'Existing' in run(ok=False).stderr
    assert json.loads(identity.read_text()) == data, 'repeat install must preserve identity'
    sample = json.loads(subprocess.check_output(['runuser', '-u', 'blink-agent', '--', '/usr/local/bin/blink-agent', 'inspect']))
    assert sample['memoryTotal'] > 0 and sample['cores']
    for directory in ['/etc/blink-agent', '/var/lib/blink-agent']:
        shutil.rmtree(directory)
    for file in ['/usr/local/bin/blink-agent', '/etc/systemd/system/blink-agent.service']:
        Path(file).unlink()
bad_origin = subprocess.run(['bash', str(installer), '--server', 'http://example.com', '--allow-insecure-localhost'], capture_output=True, text=True)
assert bad_origin.returncode != 0 and 'HTTPS' in bad_origin.stderr
server.shutdown()
print('PASS release installer: checksum rejection, enrollment rollback, private identity, non-root metrics, terminal opt-in, duplicate protection, temp cleanup (systemctl stubbed)')
