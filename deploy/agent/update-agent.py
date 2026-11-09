#!/usr/bin/env python3
"""Root-owned updater, independent of the monitored agent and its service cgroup."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path('/etc/blink-agent/config.toml')
BINARY = Path('/usr/local/bin/blink-agent')
STATE_DIR = Path('/var/lib/blink-agent-update')
MAX_DOWNLOAD = 64 * 1024 * 1024


class UpdateError(Exception):
    pass


def log(message):
    print(f'Blink Agent update: {message}', flush=True)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(65536), b''):
            value.update(chunk)
    return value.hexdigest()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_copy(source, destination, mode=0o755):
    fd, name = tempfile.mkstemp(prefix='.blink-update-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as target, source.open('rb') as original:
            shutil.copyfileobj(original, target)
            os.fchmod(target.fileno(), mode)
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, destination)
        sync_directory(destination.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def save_state(directory, state):
    fd, name = tempfile.mkstemp(prefix='.state-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as target:
            json.dump(state, target)
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, directory / 'state.json')
        sync_directory(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def load_state(directory):
    path = directory / 'state.json'
    if not path.exists():
        return {}
    state = json.loads(path.read_text())
    if not isinstance(state, dict):
        raise UpdateError('Invalid update state; refusing to discard recovery information')
    return state


def master_origin(path):
    text = path.read_text()
    try:
        import tomllib
    except ImportError:
        # Python 3.9/3.10: read only the two scalar keys needed by the updater.
        # No shell evaluation, and no dependency on a third-party TOML parser.
        config = {}
        for key in ('server_url', 'allow_insecure_localhost'):
            pattern = rf'''^\s*(?:{key}|"{key}"|'{key}')\s*=\s*(.*?)\s*$'''
            values = re.findall(pattern, text, re.MULTILINE)
            if len(values) > 1:
                raise UpdateError(f'Duplicate config key: {key}')
            if not values:
                continue
            value = values[0]
            if key == 'server_url':
                match = re.fullmatch(r'''("[^"\\\r\n]*"|'[^'\r\n]*')\s*(?:#.*)?''', value)
                if not match:
                    raise UpdateError('Use a quoted HTTPS origin for server_url')
                config[key] = match[1][1:-1]
            else:
                match = re.fullmatch(r'(true|false)\s*(?:#.*)?', value)
                if not match:
                    raise UpdateError('Invalid allow_insecure_localhost value')
                config[key] = match[1] == 'true'
    else:
        config = tomllib.loads(text)
    origin = config.get('server_url', '')
    if not isinstance(origin, str) or any(ord(c) <= 32 for c in origin):
        raise UpdateError('Invalid Master origin')
    url = urllib.parse.urlsplit(origin)
    if (not url.hostname or url.username is not None or url.password is not None
            or url.path not in ('', '/') or url.query or url.fragment):
        raise UpdateError('server_url must be an origin without credentials')
    if url.scheme != 'https' and not (
        url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')
        and config.get('allow_insecure_localhost') is True
    ):
        raise UpdateError('HTTPS required for automatic updates')
    return origin.rstrip('/')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise UpdateError('Update downloads must not redirect')


def fetch(url, target, limit):
    # Downloads are public; never attach enrollment or agent credentials.
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'})
    deadline = time.monotonic() + 180
    size = 0
    with opener.open(request, timeout=15) as response:
        if response.status != 200:
            raise UpdateError(f'Unexpected download status: {response.status}')
        length = response.headers.get('Content-Length')
        if length is not None and (not length.isdigit() or int(length) > limit):
            raise UpdateError('Download exceeds size limit')
        while True:
            if time.monotonic() > deadline:
                raise UpdateError('Download timed out')
            chunk = response.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise UpdateError('Download exceeds size limit')
            target.write(chunk)
    return size


def version_tuple(version):
    if not isinstance(version, str) or not re.fullmatch(r'(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})', version):
        raise UpdateError('Invalid release version')
    return tuple(map(int, version.split('.')))


def release_metadata(manifest, arch):
    if not isinstance(manifest, dict) or manifest.get('schema') != 1:
        raise UpdateError('Unsupported release manifest')
    version = manifest.get('version')
    version_tuple(version)
    artifacts = manifest.get('artifacts')
    artifact = artifacts.get(arch) if isinstance(artifacts, dict) else None
    if not isinstance(artifact, dict):
        raise UpdateError('Release does not support this architecture')
    for key in ('sha256', 'binary_sha256'):
        if not isinstance(artifact.get(key), str) or not re.fullmatch('[a-f0-9]{64}', artifact[key]):
            raise UpdateError(f'Invalid release {key}')
    if type(artifact.get('size')) is not int or not 0 < artifact['size'] <= MAX_DOWNLOAD:
        raise UpdateError('Invalid release size')
    return version, artifact


def binary_version(binary):
    result = subprocess.run([str(binary), '--version'], check=True, capture_output=True, text=True, timeout=10)
    match = re.fullmatch(r'blink-agent ([^\s]+)\s*', result.stdout)
    if not match:
        raise UpdateError('Invalid agent binary version')
    version_tuple(match[1])
    return match[1]


def unpack_binary(archive, destination):
    # Stream only the named regular file. Never extract archive paths, links,
    # service units, configuration or scripts over an existing installation.
    total = 0
    with tarfile.open(archive, mode='r|gz') as package:
        for index, member in enumerate(package):
            total += member.size
            if index >= 32 or member.size < 0 or total > MAX_DOWNLOAD * 2:
                raise UpdateError('Invalid release archive size')
            if member.name != 'blink-agent':
                continue
            if not member.isfile() or not 0 < member.size <= MAX_DOWNLOAD:
                raise UpdateError('Release binary must be a regular file')
            with package.extractfile(member) as source, destination.open('xb') as target:
                shutil.copyfileobj(source, target)
                target.flush()
                os.fsync(target.fileno())
            destination.chmod(0o755)
            return
    raise UpdateError('Release binary missing')


class Service:
    def logs(self, invocation):
        return subprocess.run(
            ['journalctl', f'_SYSTEMD_INVOCATION_ID={invocation}', '--no-pager', '-o', 'cat', '-n', '100'],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout

    def properties(self):
        result = subprocess.run(
            ['systemctl', 'show', 'blink-agent', '--property=ActiveState,SubState,InvocationID,MainPID'],
            check=True, capture_output=True, text=True, timeout=10,
        )
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

    def active(self):
        return self.properties().get('ActiveState') == 'active'

    def restart(self):
        subprocess.run(['systemctl', 'restart', 'blink-agent'], check=True, timeout=30)

    def healthy(self, timeout=60):
        started = time.monotonic()
        invocation = None
        while time.monotonic() - started < timeout:
            properties = self.properties()
            current = properties.get('InvocationID')
            if (properties.get('ActiveState') != 'active' or properties.get('SubState') != 'running'
                    or properties.get('MainPID') in (None, '0') or not current):
                return False
            if invocation is not None and current != invocation:
                return False  # A crash/restart is not a successful update.
            invocation = current
            connected = False
            for line in self.logs(current).splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                fields = event.get('fields') if isinstance(event, dict) else None
                if isinstance(fields, dict) and fields.get('message') == 'Connected to master':
                    connected = True
            if connected and time.monotonic() - started >= 10:
                return True
            time.sleep(1)
        return False


class OpenRCService(Service):
    def properties(self):
        status = subprocess.run(['rc-service', 'blink-agent', 'status'], capture_output=True, timeout=10)
        if status.returncode:
            return {'ActiveState': 'inactive'}
        result = subprocess.run(['rc-service', 'blink-agent', 'instance'], check=True, capture_output=True, text=True, timeout=10)
        identity = result.stdout.strip()
        pid, _, started = identity.partition(':')
        if not pid.isdigit() or not started:
            return {'ActiveState': 'inactive'}
        try:
            fields = Path('/proc', pid, 'stat').read_text().rsplit(')', 1)[1].split()
            args = Path('/proc', pid, 'cmdline').read_bytes().split(b'\0')
            if fields[0] == 'Z' or args[0] != os.fsencode(BINARY):
                return {'ActiveState': 'inactive'}
        except (OSError, IndexError):
            return {'ActiveState': 'inactive'}
        return {'ActiveState': 'active', 'SubState': 'running', 'MainPID': pid, 'InvocationID': pid + ':' + fields[19]}

    def restart(self):
        subprocess.run(['rc-service', 'blink-agent', 'restart'], check=True, timeout=40)

    def logs(self, invocation):
        # start_pre truncates on explicit restart. Filter by kernel start time
        # as well, because an automatic supervisor respawn reuses the log.
        ticks = int(invocation.partition(':')[2])
        boot = next(int(line.split()[1]) for line in Path('/proc/stat').read_text().splitlines() if line.startswith('btime '))
        started = boot + ticks / os.sysconf('SC_CLK_TCK')
        with Path('/var/log/blink-agent/current.log').open('rb') as file:
            file.seek(max(0, os.fstat(file.fileno()).st_size - 65536))
            lines = file.read(65536).decode(errors='replace').splitlines()
        result = []
        for line in lines:
            try:
                event = json.loads(line)
                timestamp = datetime.datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00')).timestamp()
                if timestamp >= started:
                    result.append(line)
            except (ValueError, KeyError, TypeError):
                continue
        return '\n'.join(result)


def recover(directory, binary, service, state):
    pending = state['pending']
    backup = directory / 'previous-agent'
    if not backup.is_file() or digest(backup) != pending['backup_sha256']:
        raise UpdateError('Recovery backup missing or corrupt; keeping transaction for manual recovery')
    atomic_copy(backup, binary)
    service.restart()
    save_state(directory, {'failed_sha256': pending['target_sha256']})
    log('Previous binary restored; configuration and identity retained')


def update(config=CONFIG, binary=BINARY, directory=STATE_DIR, service=None, check=False, retry_failed=False):
    service = service or (OpenRCService() if Path('/sbin/openrc-run').exists() and not Path('/run/systemd/system').exists() else Service())
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise UpdateError('Update state directory must not be a symlink')
    directory.chmod(0o700)
    with (directory / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log('Another update is already running')
            return
        state = load_state(directory)
        if state.get('pending'):
            if check:
                raise UpdateError('Interrupted update requires recovery; run without --check')
            recover(directory, binary, service, state)
            return
        if not service.active():
            log('Agent is stopped; leaving it stopped')
            return
        origin = master_origin(config)
        arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
        if arch is None:
            raise UpdateError('Unsupported architecture')
        if binary.is_symlink() or not binary.is_file():
            raise UpdateError('Installed agent must be a regular file')
        with tempfile.TemporaryDirectory(prefix='.blink-update-', dir=binary.parent) as work_name:
            work = Path(work_name)
            manifest_file = work / 'latest.json'
            try:
                with manifest_file.open('wb') as target:
                    fetch(origin + '/downloads/agent/latest.json', target, 16384)
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    log('Master has not published an update manifest yet; will retry next interval')
                    return
                raise
            version, artifact = release_metadata(json.loads(manifest_file.read_bytes()), arch)
            current = binary_version(binary)
            if version_tuple(version) < version_tuple(current):
                log(f'Ignoring older release {version} (installed {current})')
                return
            installed_sha = digest(binary)
            if artifact['binary_sha256'] == installed_sha:
                log(f'Already up to date ({current})')
                return
            if artifact['binary_sha256'] == state.get('failed_sha256') and not retry_failed:
                log('Skipping previously failed release; waiting for a different build')
                return
            if check:
                log(f'Update available: {current} -> {version} ({artifact["binary_sha256"][:12]})')
                return
            archive = work / 'agent.tar.gz'
            url = f'{origin}/downloads/agent/v{version}/blink-agent-linux-{arch}.tar.gz'
            with archive.open('wb') as target:
                size = fetch(url, target, artifact['size'])
            if size != artifact['size'] or digest(archive) != artifact['sha256']:
                raise UpdateError('Release archive SHA256 or size mismatch')
            candidate = work / 'blink-agent'
            unpack_binary(archive, candidate)
            if digest(candidate) != artifact['binary_sha256']:
                raise UpdateError('Release binary SHA256 mismatch')
            if binary_version(candidate) != version:
                raise UpdateError('Release binary version mismatch')
            # Recheck after download so an operator stopping the service wins.
            if not service.active():
                log('Agent was stopped during download; update deferred')
                return
            atomic_copy(binary, directory / 'previous-agent')
            state['pending'] = {'target_sha256': artifact['binary_sha256'], 'backup_sha256': installed_sha}
            save_state(directory, state)
            try:
                os.replace(candidate, binary)
                sync_directory(binary.parent)
                service.restart()
                if not service.healthy():
                    raise UpdateError('New agent failed startup or Master connection health check')
                save_state(directory, {'installed_sha256': artifact['binary_sha256'], 'version': version})
            except Exception:
                recover(directory, binary, service, state)
                raise
            log(f'Updated to {version} ({artifact["binary_sha256"][:12]}); Master connection verified')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=CONFIG)
    parser.add_argument('--check', action='store_true', help='Only check for an available release')
    parser.add_argument('--retry-failed', action='store_true', help='Retry a release previously rolled back')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run as root')
    try:
        update(config=args.config, check=args.check, retry_failed=args.retry_failed)
    except Exception as error:
        log(f'Failed: {error}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
