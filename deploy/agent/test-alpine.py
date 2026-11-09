"""Alpine release installation with real OpenRC supervision and musl cores."""
import base64
import copy
import functools
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import pwd
import secrets
import signal
import socket
import subprocess
import tarfile
import threading
import time
import uuid
from unittest.mock import patch

release = Path('/releases/downloads/agent') / ('v' + os.environ['AGENT_VERSION'])
arch = 'arm64' if os.uname().machine == 'aarch64' else 'amd64'
state = {'token': secrets.token_urlsafe(32), 'deny': True, 'welcome': True}


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path == '/agent/enroll'
        if state['deny'] or data['token'] != state['token']:
            self.send_error(401)
            return
        state['credential'] = data['credential']
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({'id': str(uuid.uuid4())}).encode())

    def do_GET(self):
        if self.path != '/ws/agent':
            return super().do_GET()
        accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.protocol_version = 'HTTP/1.1'
        self.send_response(101)
        self.send_header('Upgrade', 'websocket'); self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept); self.end_headers()
        if state['welcome']:
            data = b'{"v":1,"type":"welcome"}'
            self.wfile.write(bytes([0x81, len(data)]) + data); self.wfile.flush()
        self.connection.settimeout(45)
        try:
            while self.rfile.read(1):
                pass
        except (OSError, TimeoutError):
            pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory='/releases'))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
Path('/run/openrc').mkdir(parents=True, exist_ok=True)
Path('/run/openrc/softlevel').write_text('default')
with Path('/etc/rc.conf').open('a') as file:
    file.write('\nrc_sys="docker"\nrc_provide="loopback net"\nrc_cgroup_cleanup="no"\n')


def run(args, **kwargs):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=90, **kwargs)
    except subprocess.TimeoutExpired as error:
        output = (error.stdout or b'') + (error.stderr or b'')
        raise AssertionError('Command timed out: ' + output.decode(errors='replace').replace(state['token'], '[redacted]')[-8000:]) from None
    assert state['token'] not in result.stdout + result.stderr
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def wait(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.2)
    raise AssertionError('Service did not become ready')


command = ['bash', str(release / 'install.sh'), '--server', origin, '--allow-insecure-localhost']
failed = subprocess.run(command, input=state['token'] + '\n', capture_output=True, text=True, timeout=90)
assert failed.returncode and 'Enrollment failed' in failed.stderr, failed.stderr
assert not Path('/etc/blink-agent').exists() and not Path('/etc/init.d/blink-agent').exists()
state['deny'] = False
run(command, input=state['token'] + '\n')
identity = Path('/var/lib/blink-agent/identity.json')
before = identity.read_bytes()
assert identity.stat().st_uid == pwd.getpwnam('blink-agent').pw_uid != 0
assert identity.stat().st_mode & 0o777 == 0o600
assert Path('/etc/blink-agent/config.toml').stat().st_mode & 0o777 == 0o640
assert Path('/etc/runlevels/default/blink-agent').is_symlink()
assert Path('/etc/runlevels/default/blink-proxy-manager').is_symlink()
assert Path('/etc/periodic/15min/blink-agent-update').stat().st_mode & 0o777 == 0o755
# Extensionless installed helper needs an explicit Python loader.
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader('updater', '/usr/local/libexec/blink-agent-update')
spec = importlib.util.spec_from_loader(loader.name, loader)
updater = importlib.util.module_from_spec(spec); loader.exec_module(updater)
service = updater.OpenRCService()
wait(service.active)
assert service.healthy(timeout=20), 'OpenRC updater must observe a real welcome'
pid = service.properties()['MainPID']
assert Path('/proc', pid).stat().st_uid == pwd.getpwnam('blink-agent').pw_uid
assert json.loads(run(['su', 'blink-agent', '-s', '/bin/sh', '-c', '/usr/local/bin/blink-agent inspect']))['memoryTotal'] > 0
state['welcome'] = False
os.kill(int(pid), signal.SIGKILL)
wait(lambda: service.active() and service.properties()['MainPID'] != pid)
assert not service.healthy(timeout=12), 'Automatic respawn must not reuse an earlier welcome'
state['welcome'] = True
service.restart(); wait(service.active)
assert service.healthy(timeout=20)
assert not list(Path('/var/tmp').glob('blink-install.*'))
duplicate = subprocess.run(command, input=state['token'] + '\n', capture_output=True, text=True, timeout=90)
assert duplicate.returncode and 'Existing' in duplicate.stderr
assert identity.read_bytes() == before
package = Path('/var/tmp/package'); package.mkdir()
with tarfile.open(release / f'blink-agent-linux-{arch}.tar.gz') as archive:
    for name in ('enable-root-terminal.sh', 'root-terminal.conf.example', 'service-platform.sh'):
        (package / name).write_bytes(archive.extractfile(name).read())
run(['bash', str(package / 'enable-root-terminal.sh')])
wait(service.active)
assert Path('/proc', service.properties()['MainPID']).stat().st_uid == 0
assert identity.read_bytes() == before
state['welcome'] = False
service.restart(); wait(service.active)
assert not service.healthy(timeout=2), 'Prior log connections must not pass a new disconnected invocation'
state['welcome'] = True
service.restart(); wait(service.active)
assert service.healthy(timeout=20)
print('PASS Alpine installer: actual OpenRC start/restart, non-root metrics, root terminal, enrollment rollback, private identity and updater welcome health')

m = load('manager', '/usr/local/libexec/blink-proxy/manager.py')
assert m.OPENRC
manifest = m.read_json(m.MANIFEST)
m.atomic(m.PRIVATE / 'origin.json', m.canonical({'origin': 'https://master.example.test'}))
for engine, spec in manifest.items():
    asset = spec.get('musl', spec)[arch]; archive = Path('/releases/downloads/proxy') / asset['file']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == asset['sha256']
    with patch.object(m.urllib.request, 'build_opener') as opener:
        opener.return_value.open.side_effect = lambda url, timeout: (Path('/releases/downloads/proxy') / url.rsplit('/', 1)[1]).open('rb')
        m.install_binary(engine)
        assert opener.return_value.open.call_args.args[0].endswith('/' + asset['file'])
    assert m.run([str(m.binary(engine)), 'version'], as_proxy=True)
item = {'id': str(uuid.uuid4()), 'serverId': str(uuid.uuid4()), 'name': 'Alpine SS', 'kind': 'shadowsocks2022',
        'port': 443, 'domain': '', 'fallbackPort': 8003, 'upstream': '', 'defaultOutbound': 'direct', 'rules': [],
        'enabled': True, 'manageDns': False, 'udp': True, 'exits': [], 'sources': [],
        'credentials': {'method': '2022-blake3-aes-256-gcm', 'password': base64.b64encode(secrets.token_bytes(32)).decode()}}
data = {'instances': [item], 'addresses': ['8.8.8.8'], 'email': '', 'firewall': 'external'}
result = m.apply(data, 1, time.time() + 90)
assert result['status']['instances'][0]['state'] == 'active'
with socket.create_connection(('127.0.0.1', 443), timeout=3): pass
name = m.service_name(item)
assert (m.UNITS / name).stat().st_mode & 0o777 == 0o755
assert Path('/etc/runlevels/default', name).is_symlink()
matching = [p for p in Path('/proc').glob('[0-9]*') if (p / 'cmdline').exists() and str(m.binary('sing-box')).encode() in (p / 'cmdline').read_bytes() and (p / 'status').stat().st_uid == pwd.getpwnam('blink-proxy').pw_uid]
assert matching, 'Proxy core must run as blink-proxy'
assert all(int(next(line.split()[1] for line in (p / 'status').read_text().splitlines() if line.startswith('CapEff:')), 16) == 0x400 for p in matching), 'Only low-port binding capability is granted'
occupied = socket.socket(); occupied.bind(('0.0.0.0', 18443)); occupied.listen()
failed = copy.deepcopy(data); failed['instances'][0]['port'] = 18443
try:
    m.apply(failed, 2, time.time() + 90)
    raise AssertionError('Port conflict must fail')
except m.DeploymentError:
    pass
assert m.read_json(m.PRIVATE / 'applied.json')['version'] == 1
assert m.status()['instances'][0]['state'] == 'active'
occupied.close()
m.apply({**data, 'instances': []}, 3, time.time() + 90)
assert not (m.UNITS / name).exists() and not Path('/etc/runlevels/default', name).exists()
assert not (m.PRIVATE / 'transaction.json').exists()
print('PASS Alpine musl cores: all three execute unprivileged; real OpenRC low-port proxy deployment, rollback and uninstall')
run(['rc-service', 'blink-agent', 'stop']); run(['rc-service', 'blink-proxy-manager', 'stop'])
server.shutdown()
