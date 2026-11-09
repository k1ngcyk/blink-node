#!/usr/bin/env python3
"""Typed, local-only deployment worker. No remote shell, path, or executable fields.

The Agent talks to a group-restricted Unix socket. A durable task ledger and an
atomic configuration generation make redelivery and interrupted deploys recoverable.
"""
import copy
import datetime
import glob
import grp
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shlex
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

ROOT = Path('/var/lib/blink-proxy')
PRIVATE = ROOT / 'manager'
BIN = Path('/usr/local/libexec/blink-proxy/bin')
UNITS = Path('/etc/systemd/system')
MANIFEST = Path('/usr/local/libexec/blink-proxy/assets.json')
CONTROL = '/run/blink-proxy/control.sock'
ADMIN = 'unix//run/blink-proxy-web/admin.sock'
LIMIT = 220000
LOCK = threading.Lock()
DOMAIN = re.compile(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')


class DeploymentError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise DeploymentError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data, mode=0o600, owner=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.blink-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            os.fchmod(file.fileno(), mode)
            if owner:
                os.fchown(file.fileno(), *owner)
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def run(args, timeout=30, optional=False, input_data=None, as_proxy=False):
    """Never return subprocess output in deployment errors (it may contain keys)."""
    try:
        identity = pwd.getpwnam('blink-proxy') if as_proxy else None
        permissions = {'user': identity.pw_uid, 'group': identity.pw_gid, 'extra_groups': []} if identity else {}
        result = subprocess.run(args, input=input_data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False,
                                env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                                     'LANG': 'C', 'HOME': str(ROOT), 'XDG_DATA_HOME': str(ROOT / 'caddy')},
                                **permissions)
        if result.returncode and not optional:
            raise DeploymentError('命令执行失败：' + Path(args[0]).name + ' ' + str(args[1] if len(args) > 1 else ''))
        return result.stdout.decode(errors='replace')[:1024 * 1024] if result.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        if optional:
            return ''
        raise DeploymentError('命令不可用或超时：' + Path(args[0]).name) from None


def service_name(instance):
    return 'blink-proxy-' + str(uuid.UUID(instance['id'])) + '.service'


def public_ip(value):
    try:
        address = ipaddress.ip_address(value)
        return address.is_global and not address.is_multicast
    except ValueError:
        return False


def validate_payload(data):
    require(isinstance(data, dict) and set(data) == {'instances', 'addresses', 'firewall', 'email'}, '部署参数无效')
    require(isinstance(data['instances'], list) and len(data['instances']) <= 32, '实例数量超限')
    require(data['firewall'] in ('existing', 'enable', 'external'), '防火墙模式无效')
    require(isinstance(data['addresses'], list) and len(data['addresses']) <= 2 and all(public_ip(a) for a in data['addresses']), '公网地址无效')
    require(isinstance(data['email'], str) and len(data['email']) <= 254 and '\n' not in data['email'], 'ACME 邮箱无效')
    ports, ids = {80}, set()
    for item in data['instances']:
        identifier = str(uuid.UUID(item['id']))
        require(identifier not in ids, '重复实例')
        ids.add(identifier)
        kind = item['kind']
        require(kind in ('reality', 'anytls', 'shadowsocks2022'), '协议不受支持')
        port = item['port']
        require(type(port) is int and 1 <= port <= 65535 and port not in ports, '监听端口冲突')
        ports.add(port)
        require(len(item['name']) <= 100 and item['enabled'] is True, '实例参数无效')
        secret = item['credentials']
        if kind != 'shadowsocks2022':
            require(DOMAIN.fullmatch(item['domain']) and '@' in data['email'], '域名或 ACME 邮箱无效')
        if kind == 'reality':
            require(port == 443, 'REALITY 入口必须为 443')
            fallback = item['fallbackPort']
            require(type(fallback) is int and 1024 <= fallback <= 65535 and fallback not in ports, '本地 TLS 端口冲突')
            ports.add(fallback)
            upstream = urllib.parse.urlsplit(item['upstream'])
            require(upstream.scheme == 'https' and DOMAIN.fullmatch(upstream.hostname or '') and not upstream.username and not upstream.password and upstream.path in ('', '/') and not upstream.query and not upstream.fragment, '上游地址无效')
            require(str(uuid.UUID(secret['uuid'])) == secret['uuid'] and re.fullmatch(r'[A-Za-z0-9_-]{43}', secret['privateKey']) and re.fullmatch(r'[a-f0-9]{16}', secret['shortId']), 'REALITY 密钥无效')
        else:
            import base64
            require(len(base64.b64decode(secret['password'], validate=True)) == 32, '代理密钥无效')
            if kind == 'shadowsocks2022':
                require(secret['method'] == '2022-blake3-aes-256-gcm' and item['defaultOutbound'] == 'direct' and not item['rules'], 'SS2022 落地配置无效')
        require(len(item['sources']) <= 1000 and all(public_ip(a) for a in item['sources']), '来源地址无效')
        require(len(item['exits']) <= 100 and len(item['rules']) <= 100, '路由数量超限')
        exit_ids = {'direct'}
        for exit in item['exits']:
            uuid.UUID(exit['id'])
            require(public_ip(exit['address']) and type(exit['port']) is int and 1 <= exit['port'] <= 65535, '出口地址无效')
            require(exit['method'] == '2022-blake3-aes-256-gcm', '出口加密方法无效')
            import base64
            require(len(base64.b64decode(exit['password'], validate=True)) == 32, '出口密钥无效')
            exit_ids.add(exit['id'])
        require(item['defaultOutbound'] in exit_ids, '默认出口不存在')
        for rule in item['rules']:
            require(rule['match'] in ('domain', 'domain_suffix', 'ip_cidr') and rule['outbound'] in exit_ids and 1 <= len(rule['values']) <= 100, '分流规则无效')
            for value in rule['values']:
                if rule['match'] == 'ip_cidr':
                    ipaddress.ip_network(value, strict=False)
                else:
                    require(DOMAIN.fullmatch(value), '分流域名无效')
    return data


def core_config(item):
    secret = item['credentials']
    if item['kind'] == 'reality':
        outbound = [{'tag': 'direct', 'protocol': 'freedom', 'settings': {}}]
        for exit in item['exits']:
            outbound.append({'tag': exit['id'], 'protocol': 'shadowsocks', 'settings': {
                'address': exit['address'], 'port': exit['port'], 'method': exit['method'], 'password': exit['password']}})
        rules = []
        for rule in item['rules']:
            field = 'ip' if rule['match'] == 'ip_cidr' else 'domain'
            values = rule['values'] if field == 'ip' else [('full:' if rule['match'] == 'domain' else 'domain:') + value for value in rule['values']]
            rules.append({'type': 'field', field: values, 'outboundTag': rule['outbound']})
        rules.append({'type': 'field', 'network': 'tcp,udp', 'outboundTag': item['defaultOutbound']})
        return {'log': {'loglevel': 'warning'}, 'inbounds': [{
            'tag': item['id'], 'listen': '::', 'port': 443, 'protocol': 'vless',
            'settings': {'clients': [{'id': secret['uuid'], 'flow': 'xtls-rprx-vision'}], 'decryption': 'none'},
            'sniffing': {'enabled': True, 'destOverride': ['http', 'tls', 'quic'], 'routeOnly': True},
            'streamSettings': {'network': 'raw', 'security': 'reality', 'realitySettings': {
                'target': '127.0.0.1:' + str(item['fallbackPort']), 'xver': 2,
                'serverNames': [item['domain']], 'privateKey': secret['privateKey'], 'shortIds': [secret['shortId']]}}}],
            'outbounds': outbound, 'routing': {'domainStrategy': 'IPOnDemand', 'rules': rules}}
    inbound = {'type': 'anytls' if item['kind'] == 'anytls' else 'shadowsocks',
               'tag': item['id'], 'listen': '::', 'listen_port': item['port']}
    if item['kind'] == 'anytls':
        inbound.update({'users': [{'name': 'owner', 'password': secret['password']}], 'tls': {
            'enabled': True, 'server_name': item['domain'],
            'certificate_path': str(ROOT / 'certificates' / item['domain'] / 'fullchain.pem'),
            'key_path': str(ROOT / 'certificates' / item['domain'] / 'key.pem')}})
    else:
        inbound.update({'method': secret['method'], 'password': secret['password']})
        if not item['udp']:
            inbound['network'] = 'tcp'
    outbound = [{'type': 'direct', 'tag': 'direct'}]
    for exit in item['exits']:
        outbound.append({'type': 'shadowsocks', 'tag': exit['id'], 'server': exit['address'],
                         'server_port': exit['port'], 'method': exit['method'], 'password': exit['password']})
    rules = [{'action': 'sniff'}]
    resolved = False
    for rule in item['rules']:
        if rule['match'] == 'ip_cidr' and not resolved:
            rules.append({'action': 'resolve', 'server': 'system'})
            resolved = True
        rules.append({rule['match']: rule['values'], 'action': 'route', 'outbound': rule['outbound']})
    return {'log': {'level': 'warn'}, 'inbounds': [inbound], 'outbounds': outbound,
            'route': {'rules': rules, 'final': item['defaultOutbound'], 'default_domain_resolver': 'system'},
            'dns': {'servers': [{'type': 'local', 'tag': 'system'}]}}


def caddy_config(data):
    instances = [i for i in data['instances'] if i['kind'] != 'shadowsocks2022']
    if not instances:
        return None
    servers = {'http': {'listen': [':80'], 'protocols': ['h1'], 'routes': [{'handle': [{
        'handler': 'static_response', 'headers': {'Location': ['https://{http.request.host}{http.request.uri}']}, 'status_code': 301}]}]}}
    for item in instances:
        if item['kind'] != 'reality':
            continue
        upstream = urllib.parse.urlsplit(item['upstream'])
        host = upstream.hostname
        servers[item['id']] = {'listen': ['127.0.0.1:' + str(item['fallbackPort'])],
            'listener_wrappers': [{'wrapper': 'proxy_protocol', 'allow': ['127.0.0.1/32']}, {'wrapper': 'tls'}],
            'protocols': ['h1', 'h2'],
            'tls_connection_policies': [{'match': {'sni': [item['domain']]}, 'alpn': ['h2', 'http/1.1']}],
            'routes': [{'match': [{'host': [item['domain']]}], 'handle': [{'handler': 'reverse_proxy',
                'transport': {'protocol': 'http', 'tls': {'server_name': host}},
                'upstreams': [{'dial': host + ':' + str(upstream.port or 443)}],
                'headers': {'request': {'set': {'Host': [upstream.netloc]}}, 'response': {'delete': ['Alt-Svc']}}}]}]}
    return {'admin': {'listen': ADMIN}, 'storage': {'module': 'file_system', 'root': str(ROOT / 'caddy')},
            'apps': {'http': {'servers': servers}, 'tls': {
                'certificates': {'automate': sorted({i['domain'] for i in instances})},
                'automation': {'policies': [{'issuers': [{'module': 'acme',
                    'ca': 'https://acme-v02.api.letsencrypt.org/directory', 'email': data['email'],
                    'challenges': {'tls-alpn': {'disabled': True}}}]}]}}}}


def binary(engine):
    manifest = read_json(MANIFEST)
    return BIN / (engine + '-' + manifest[engine]['version'])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DeploymentError('Master 下载不允许重定向')


def install_binary(engine):
    manifest = read_json(MANIFEST)
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    require(arch is not None, '仅支持 Linux AMD64 / ARM64')
    target = binary(engine)
    marker = PRIVATE / (target.name + '.sha256')
    if target.exists() and marker.exists() and digest(target.read_bytes()) == marker.read_text():
        return
    asset = manifest[engine][arch]
    origin = read_json(PRIVATE / 'origin.json')['origin']
    parsed = urllib.parse.urlsplit(origin)
    require(parsed.scheme == 'https' and parsed.path in ('', '/') and not parsed.username and not parsed.query, '代理资源需要 HTTPS Master')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(origin.rstrip('/') + '/downloads/proxy/' + asset['file'], timeout=180) as response:
            archive = response.read(100 * 1024 * 1024 + 1)
    except Exception:
        raise DeploymentError('无法从 Master 下载 ' + engine + '，请确认已发布代理内核资源') from None
    require(len(archive) <= 100 * 1024 * 1024 and digest(archive) == asset['sha256'], '代理内核 SHA256 校验失败')
    import io
    if asset['file'].endswith('.zip'):
        with zipfile.ZipFile(io.BytesIO(archive)) as package:
            member = package.getinfo(asset['member'])
            require(member.file_size < 200 * 1024 * 1024, '内核文件超限')
            content = package.read(member)
    else:
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
            member = package.getmember(asset['member'])
            require(member.isfile() and member.size < 200 * 1024 * 1024, '内核文件无效')
            content = package.extractfile(member).read()
    atomic(target, content, 0o755)
    atomic(marker, digest(content).encode())


def unit(engine, config_path):
    command = str(binary(engine)) + (' run --config ' if engine == 'caddy' else ' run -c ') + str(config_path)
    extra = 'RuntimeDirectory=blink-proxy-web\nRuntimeDirectoryMode=0700\n' if engine == 'caddy' else ''
    return ('[Unit]\nDescription=Blink managed ' + engine + '\nAfter=network-online.target\nWants=network-online.target\n'
            '[Service]\nUser=blink-proxy\nGroup=blink-proxy\nExecStart=' + command + '\n'
            'Restart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\nProtectSystem=strict\n'
            'ProtectHome=true\nPrivateTmp=true\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n'
            'AmbientCapabilities=CAP_NET_BIND_SERVICE\nReadWritePaths=/var/lib/blink-proxy/caddy\n'
            + extra + '[Install]\nWantedBy=multi-user.target\n').encode()


def check_core(item, config):
    if item['kind'] == 'reality':
        run([str(binary('xray')), 'run', '-test', '-c', str(config)], as_proxy=True)
    else:
        run([str(binary('sing-box')), 'check', '-c', str(config)], as_proxy=True)


def ufw_rules(data):
    rules = set()
    for item in data['instances']:
        if item['kind'] != 'shadowsocks2022':
            rules.add(('any', 80, 'tcp'))
            rules.add(('any', item['port'], 'tcp'))
        else:
            for address in item['sources']:
                rules.add((address, item['port'], 'tcp'))
                if item['udp']:
                    rules.add((address, item['port'], 'udp'))
    return [list(rule) for rule in sorted(rules)]


def ufw_tag(rule):
    return 'blink-proxy-' + digest(canonical(rule))[:12]


def ufw_existing(rule):
    """Recognize equivalent pre-existing rules without changing their comments."""
    source, port, protocol = rule
    for line in run(['ufw', 'show', 'added']).splitlines():
        try:
            args = shlex.split(line)
        except ValueError:
            continue
        if args[:2] != ['ufw', 'allow']:
            continue
        tag = args[args.index('comment') + 1] if 'comment' in args else ''
        if tag == ufw_tag(rule):
            return 'owned'
        def after(name, default):
            return args[args.index(name) + 1] if name in args else default
        old_source = after('from', 'any')
        old_destination = after('to', 'any')
        old_port = after('port', args[2] if len(args) > 2 else '')
        old_port, _, suffix = old_port.partition('/')
        old_protocol = after('proto', suffix or 'any')
        if old_port == str(port) and old_source in ('any', source) and old_destination == 'any' and old_protocol in ('any', protocol):
            return 'external'
    return None


def ufw_change(rule, delete=False):
    source, port, protocol = rule
    existing = ufw_existing(rule)
    if (delete and existing != 'owned') or (not delete and existing == 'external'):
        return False
    tag = ufw_tag(rule)
    args = ['ufw'] + (['--force', 'delete'] if delete else []) + ['allow', 'proto', protocol, 'from', source, 'to', 'any', 'port', str(port), 'comment', tag]
    run(args)
    return True


def firewall_prepare(data, transaction):
    warnings = []
    previous = read_json(PRIVATE / 'firewall.json', [])
    if data['firewall'] == 'external':
        warnings.append('防火墙由外部管理；请同步云安全组与主机规则')
        return previous, warnings
    executable = shutil.which('ufw')
    if not executable:
        if data['firewall'] == 'enable':
            require(shutil.which('apt-get'), '自动安装 UFW 需要 Debian/Ubuntu；其他系统请先安装 ufw')
            run(['apt-get', 'update'], timeout=180)
            run(['apt-get', 'install', '-y', 'ufw'], timeout=180)
        else:
            return previous, ['未安装 UFW；请在主机防火墙与云安全组开放服务端口']
    status = run(['ufw', 'status'])
    active = 'Status: active' in status
    if not active and data['firewall'] != 'enable':
        return previous, ['UFW 未启用；已保留其状态，请检查云安全组']
    desired = ufw_rules(data)
    # Never take ownership of an administrator's equivalent allow rule. UFW may
    # otherwise replace its comment, making a subsequent delete destructive.
    desired = [rule for rule in desired if ufw_existing(rule) != 'external']
    transaction['firewallBefore'] = previous
    transaction['firewallAfter'] = desired
    transaction['ufwWasActive'] = active
    atomic(PRIVATE / 'transaction.json', canonical(transaction))
    if not active:
        ssh_config = run(['/usr/sbin/sshd', '-T'], optional=True)
        ssh_ports = re.findall(r'^port (\d+)$', ssh_config, re.M)
        listeners = run(['ss', '-H', '-ltnp'], optional=True)
        for line in listeners.splitlines():
            if 'sshd' in line:
                fields = line.split()
                if len(fields) > 3 and fields[3].rsplit(':', 1)[-1].isdigit():
                    ssh_ports.append(fields[3].rsplit(':', 1)[-1])
        socket_units = run(['systemctl', 'show', 'ssh.socket', 'sshd.socket', '--property=Listen', '--value'], optional=True)
        ssh_ports.extend(re.findall(r'(?:^|:)(\d+)\s+\(Stream\)', socket_units, re.M))
        require(ssh_ports, '无法识别 SSH 监听端口，请先手动配置 UFW 后选择“管理已有 UFW”')
        ssh_rules = [['any', int(port), 'tcp'] for port in sorted(set(ssh_ports))]
        transaction['sshAdded'] = [rule for rule in ssh_rules if not ufw_existing(rule)]
        atomic(PRIVATE / 'transaction.json', canonical(transaction))
        for rule in ssh_rules:
            ufw_change(rule)
    for rule in desired:
        if rule not in previous:
            ufw_change(rule)
    if not active:
        run(['ufw', '--force', 'enable'])
    warnings.append('UFW 规则已维护；云厂商安全组仍需开放相应端口')
    return desired, warnings


def replace_current(path):
    temporary = ROOT / '.current-next'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(path)
    os.replace(temporary, ROOT / 'current')


def wait_service(name):
    for _ in range(20):
        if run(['systemctl', 'is-active', name], optional=True).strip() == 'active':
            time.sleep(1)
            if run(['systemctl', 'is-active', name], optional=True).strip() == 'active':
                return
        time.sleep(0.5)
    raise DeploymentError('服务启动失败：' + name)


def certificate_source(domain):
    candidates = list((ROOT / 'caddy' / 'certificates').glob('*/' + domain + '/' + domain + '.crt'))
    for path in sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True):
        key = path.with_suffix('.key')
        if key.is_file():
            return path, key
    return None


def certificate_info(path):
    output = run(['openssl', 'x509', '-in', str(path), '-noout', '-enddate', '-issuer', '-subject'], optional=True)
    result = {'path': str(path)}
    for line in output.splitlines():
        name, _, value = line.partition('=')
        if name in ('notAfter', 'issuer', 'subject'):
            result[name] = value[:300]
    return result


def sync_certificates(data, restart=True):
    user = pwd.getpwnam('blink-proxy')
    domains = {}
    for item in data.get('instances', []):
        if item['kind'] == 'anytls':
            domains.setdefault(item['domain'], []).append(item)
    for domain, instances in domains.items():
        source = certificate_source(domain)
        if not source:
            continue
        directory = ROOT / 'certificates' / domain
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory.parent, 0o750)
        os.chown(directory.parent, 0, user.pw_gid)
        os.chmod(directory, 0o750)
        os.chown(directory, 0, user.pw_gid)
        certificate, key = source[0].read_bytes(), source[1].read_bytes()
        current = directory / 'fullchain.pem'
        changed = not current.exists() or current.read_bytes() != certificate
        if changed:
            for item in instances:
                atomic(PRIVATE / 'certificate-restarts' / item['id'], b'pending')
            atomic(directory / 'key.pem', key, 0o640, (0, user.pw_gid))
            atomic(current, certificate, 0o640, (0, user.pw_gid))
        if restart:
            for item in instances:
                pending = PRIVATE / 'certificate-restarts' / item['id']
                if not pending.exists():
                    continue
                run(['systemctl', 'try-restart', service_name(item)])
                pending.unlink()


def wait_certificates(data, deadline):
    names = {i['domain'] for i in data['instances'] if i['kind'] != 'shadowsocks2022'}
    until = min(deadline, time.time() + 300)
    while time.time() < until:
        if all(certificate_source(name) for name in names):
            sync_certificates(data, restart=False)
            return
        time.sleep(2)
    raise DeploymentError('HTTP-01 证书签发未完成：检查域名 A/AAAA、TCP 80、云安全组及 Caddy 日志')


def check_dns(data):
    for domain in {i['domain'] for i in data['instances'] if i['kind'] != 'shadowsocks2022'}:
        until = time.time() + 120
        while True:
            try:
                found = {row[4][0] for row in socket.getaddrinfo(domain, 80, type=socket.SOCK_STREAM)}
            except socket.gaierror:
                found = set()
            expected = {str(ipaddress.ip_address(a)) for a in data['addresses']}
            found = {str(ipaddress.ip_address(a)) for a in found}
            if found == expected and found:
                break
            if time.time() >= until:
                raise DeploymentError('DNS 尚未指向节点全部地址：' + domain)
            time.sleep(3)


def tls_probe(item):
    # Test the exact fallback wire path, including PROXY v2 before the TLS ClientHello.
    with socket.create_connection(('127.0.0.1', item['fallbackPort']), timeout=8) as raw:
        address = socket.inet_aton('127.0.0.1') * 2 + struct.pack('!HH', 12345, 443)
        raw.sendall(b'\r\n\r\n\x00\r\nQUIT\n' + bytes([0x21, 0x11]) + struct.pack('!H', len(address)) + address)
        with ssl.create_default_context().wrap_socket(raw, server_hostname=item['domain']) as secure:
            require(secure.version() == 'TLSv1.3', '本地 REALITY 目标需要 TLS 1.3')


def recover():
    transaction = read_json(PRIVATE / 'transaction.json')
    if not transaction:
        return
    previous = transaction.get('previous')
    for name in transaction.get('newUnits', []):
        run(['systemctl', 'disable', '--now', name], optional=True)
        (UNITS / name).unlink(missing_ok=True)
    if previous:
        replace_current(previous)
    else:
        (ROOT / 'current').unlink(missing_ok=True)
    for name, content in transaction.get('unitBackups', {}).items():
        atomic(UNITS / name, content.encode(), 0o644)
    run(['systemctl', 'daemon-reload'], optional=True)
    if previous:
        previous_data = read_json(Path(previous) / 'desired.json', {'instances': []})
        if caddy_config(previous_data):
            run(['systemctl', 'enable', 'blink-proxy-web.service'], optional=True)
            run(['systemctl', 'restart', 'blink-proxy-web.service'], optional=True)
        for item in previous_data['instances']:
            run(['systemctl', 'enable', '--now', service_name(item)], optional=True)
            run(['systemctl', 'restart', service_name(item)], optional=True)
    if transaction.get('ufwWasActive') is False:
        run(['ufw', '--force', 'disable'])
    for rule in transaction.get('firewallAfter', []) + transaction.get('sshAdded', []):
        if rule not in transaction.get('firewallBefore', []):
            ufw_change(rule, delete=True)
    for rule in transaction.get('firewallBefore', []):
        ufw_change(rule)
    atomic(PRIVATE / 'firewall.json', canonical(transaction.get('firewallBefore', [])))
    atomic(PRIVATE / 'applied.json', canonical(transaction.get('appliedBefore', {'version': 0})))
    (PRIVATE / 'transaction.json').unlink()


def apply(data, version, deadline):
    validate_payload(data)
    applied = read_json(PRIVATE / 'applied.json', {'version': 0})
    for name, expected in applied.get('files', {}).items():
        path = ROOT / 'current' / name
        require(path.is_file() and digest(path.read_bytes()) == expected,
                '检测到外部配置修改，请先扫描并核对：' + name)
    fingerprint = digest(canonical(data))
    if version <= applied['version']:
        require(version == applied['version'] and fingerprint == applied.get('fingerprint'), '拒绝过期配置版本')
        return {'status': status(data), 'warnings': [], 'message': '配置版本已应用'}
    check_dns(data)
    engines = {'xray' if i['kind'] == 'reality' else 'sing-box' for i in data['instances']}
    web = caddy_config(data)
    if web:
        engines.add('caddy')
    for engine in engines:
        install_binary(engine)
    user = pwd.getpwnam('blink-proxy')
    generation = ROOT / 'generations' / str(version)
    require(not generation.exists(), '配置代次已存在，请重新应用生成新版本')
    generation.mkdir(parents=True)
    os.chmod(generation.parent, 0o750)
    os.chown(generation.parent, 0, user.pw_gid)
    os.chmod(generation, 0o750)
    os.chown(generation, 0, user.pw_gid)
    atomic(generation / 'desired.json', canonical(data))
    previous = str((ROOT / 'current').resolve()) if (ROOT / 'current').exists() else None
    old = read_json(Path(previous) / 'desired.json', {'instances': []}) if previous else {'instances': []}
    desired_units = {}
    for item in data['instances']:
        filename = item['id'] + '.json'
        atomic(generation / filename, canonical(core_config(item)), 0o640, (0, user.pw_gid))
        desired_units[service_name(item)] = unit('xray' if item['kind'] == 'reality' else 'sing-box', ROOT / 'current' / filename)
        if item['kind'] != 'anytls':
            check_core(item, generation / filename)
    if web:
        atomic(generation / 'caddy.json', canonical(web), 0o640, (0, user.pw_gid))
        run([str(binary('caddy')), 'validate', '--config', str(generation / 'caddy.json')], as_proxy=True)
        desired_units['blink-proxy-web.service'] = unit('caddy', ROOT / 'current' / 'caddy.json')
    old_units = [service_name(i) for i in old['instances']]
    if caddy_config(old):
        old_units.append('blink-proxy-web.service')
    transaction = {'previous': previous, 'generation': str(generation), 'appliedBefore': applied,
                   'unitBackups': {name: (UNITS / name).read_text() for name in set(old_units) | set(desired_units) if (UNITS / name).exists()},
                   'newUnits': [name for name in desired_units if not (UNITS / name).exists()],
                   'firewallBefore': read_json(PRIVATE / 'firewall.json', [])}
    atomic(PRIVATE / 'transaction.json', canonical(transaction))
    try:
        firewall, warnings = firewall_prepare(data, transaction)
        replace_current(generation)
        for name, content in desired_units.items():
            atomic(UNITS / name, content, 0o644)
        run(['systemctl', 'daemon-reload'])
        if web:
            if run(['systemctl', 'is-active', 'blink-proxy-web.service'], optional=True).strip() == 'active':
                run([str(binary('caddy')), 'reload', '--address', ADMIN, '--config', str(ROOT / 'current' / 'caddy.json')])
            else:
                run(['systemctl', 'enable', '--now', 'blink-proxy-web.service'])
            wait_service('blink-proxy-web.service')
            wait_certificates(data, deadline)
        for item in data['instances']:
            check_core(item, generation / (item['id'] + '.json'))
            if item['kind'] == 'reality':
                tls_probe(item)
            run(['systemctl', 'enable', service_name(item)])
            run(['systemctl', 'restart', service_name(item)])
            wait_service(service_name(item))
        for name in old_units:
            if name not in desired_units:
                run(['systemctl', 'disable', '--now', name])
                (UNITS / name).unlink(missing_ok=True)
        for rule in transaction['firewallBefore']:
            if rule not in firewall:
                ufw_change(rule, delete=True)
        atomic(PRIVATE / 'firewall.json', canonical(firewall))
        atomic(PRIVATE / 'applied.json', canonical({'version': version, 'fingerprint': fingerprint,
            'files': {path.name: digest(path.read_bytes()) for path in generation.glob('*.json')}}))
        (PRIVATE / 'transaction.json').unlink()
        return {'status': status(data), 'warnings': warnings}
    except Exception:
        recover()
        raise


def status(data=None):
    if data is None:
        data = read_json(ROOT / 'current' / 'desired.json', {'instances': []})
    items = []
    for item in data['instances']:
        row = {'id': item['id'], 'kind': item['kind'], 'port': item['port'],
               'state': run(['systemctl', 'is-active', service_name(item)], optional=True).strip() or 'inactive'}
        source = certificate_source(item['domain']) if item['kind'] != 'shadowsocks2022' else None
        if source:
            row['certificate'] = certificate_info(source[0])
        items.append(row)
    return {'instances': items, 'ufw': run(['ufw', 'status'], optional=True)[:12000],
            'version': read_json(PRIVATE / 'applied.json', {'version': 0})['version']}


def strip_json_comments(text):
    pattern = r'("(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/)'
    return re.sub(pattern, lambda m: m.group(0) if m.group(0).startswith('"') else '', text)


def config_files(args, cwd='/'):
    result = []
    index = 0
    while index < len(args):
        arg = args[index]
        name, separator, value = arg.partition('=')
        if name in ('-c', '--config', '-config', '-confdir', '--config-directory', '-C'):
            if not separator and index + 1 < len(args):
                index += 1
                value = args[index]
            if value:
                path = Path(value)
                if not path.is_absolute():
                    path = Path(cwd) / path
                if name in ('-confdir', '--config-directory', '-C'):
                    result.extend(sorted(path.glob('*.json')))
                    result.extend(sorted(path.glob('*.jsonc')))
                else:
                    result.append(path)
        index += 1
    return result


def merge_configs(engine, files):
    """Preserve source documents, plus the effective JSON for ordinary file setups."""
    merged = {}
    for file in files:
        config = file.get('config')
        if not isinstance(config, dict):
            continue
        for key, value in config.items():
            if engine == 'xray' and key in ('inbounds', 'outbounds') and isinstance(value, list):
                existing = merged.setdefault(key, [])
                new = []
                for inbound in value:
                    match = next((i for i, old in enumerate(existing) if old.get('tag') and old.get('tag') == inbound.get('tag')), None)
                    if match is None:
                        new.append(copy.deepcopy(inbound))
                    else:
                        existing[match] = copy.deepcopy(inbound)
                if key == 'outbounds' and 'tail' not in Path(file['path']).name.lower():
                    merged[key] = new + existing
                else:
                    existing.extend(new)
            elif isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key].update(copy.deepcopy(value))
            elif engine == 'sing-box' and isinstance(value, list) and isinstance(merged.get(key), list):
                merged[key].extend(copy.deepcopy(value))
            else:
                merged[key] = copy.deepcopy(value)
    return merged


def web_includes(engine, paths):
    """Bounded include traversal for ordinary Caddyfile/nginx file layouts."""
    result, seen = [], set()
    pending = list(paths)
    while pending and len(result) < 100:
        path = pending.pop(0)
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        result.append(path)
        if path.suffix in ('.json', '.jsonc') or resolved.stat().st_size > 100000:
            continue
        try:
            text = resolved.read_text()
            directive = 'import' if engine == 'caddy' else 'include'
            for match in re.finditer(r'(?m)^\s*' + directive + r'\s+([^;\n]+)', text):
                args = shlex.split(match[1], comments=True)
                if not args or any(v in args[0] for v in ('$','{','}')):
                    continue
                pattern = Path(args[0])
                if not pattern.is_absolute():
                    pattern = (path.parent if engine == 'caddy' else Path('/etc/nginx')) / pattern
                pending.extend(Path(p) for p in sorted(glob.glob(str(pattern))))
        except (OSError, ValueError):
            continue
    return result


def discovery(engine, key, paths, unit_name='', active=False):
    files, warnings = [], []
    if engine in ('caddy', 'nginx'):
        paths = web_includes(engine, paths)
    for path in dict.fromkeys(paths):
        try:
            resolved = path.resolve()
            if str(resolved).startswith(('/proc/', '/dev/', '/sys/')) or not resolved.is_file():
                continue
            if resolved.stat().st_size > 100000:
                warnings.append(str(path) + ': 配置超过扫描上限')
                continue
            text = resolved.read_text()
            record = {'path': str(path), 'sha256': digest(text.encode())}
            if path.suffix in ('.json', '.jsonc'):
                record['config'] = json.loads(strip_json_comments(text))
            elif engine in ('caddy', 'nginx'):
                # Store readable directives, never inline key material or generic
                # environment files. Certificates are inspected separately below.
                record['directives'] = '\n'.join(line for line in text.splitlines() if not re.search(r'password|secret|token|BEGIN .*PRIVATE KEY', line, re.I))
            else:
                warnings.append(str(path) + ': 非 JSON 配置，需要手动检查')
            files.append(record)
        except (OSError, ValueError):
            warnings.append(str(path) + ': 配置无法读取或解析')
    effective = merge_configs(engine, files)
    inbounds = []
    for inbound in effective.get('inbounds', []):
        protocol = inbound.get('type', inbound.get('protocol', 'unknown'))
        stream = inbound.get('streamSettings', {})
        tls = inbound.get('tls', {})
        reality = stream.get('realitySettings', tls.get('reality', {}))
        inbounds.append({'tag': inbound.get('tag', ''), 'protocol': protocol,
            'port': inbound.get('listen_port', inbound.get('port')),
            'listen': inbound.get('listen', ''), 'reality': bool(reality),
            'target': reality.get('target', reality.get('dest', reality.get('handshake', {}))),
            'domains': reality.get('serverNames', [tls.get('server_name', '')]),
            'proxyProtocol': reality.get('xver', 0)})
    certificates, listen_ports = [], set()
    if engine == 'caddy':
        for server in effective.get('apps', {}).get('http', {}).get('servers', {}).values():
            for address in server.get('listen', []):
                match = re.search(r':(\d+)$', address)
                if match:
                    listen_ports.add(int(match[1]))
    for file in files:
        text = file.get('directives', '')
        if engine == 'nginx':
            for match in re.finditer(r'\blisten\s+(?:[^\s;]*:)?(\d+)\b', text):
                listen_ports.add(int(match[1]))
            for match in re.finditer(r'\bssl_certificate\s+["\']?(/[^\s;"\']+)', text):
                if Path(match[1]).is_file():
                    certificates.append(certificate_info(match[1]))
        elif engine == 'caddy':
            listen_ports.update(int(v) for v in re.findall(r':(\d+)\s*(?:\{|,|$)', text, re.M))
    def walk(value):
        if isinstance(value, dict):
            for name, child in value.items():
                if name in ('certificate_path', 'certificateFile', 'certificate') and isinstance(child, str) and child.startswith('/'):
                    if Path(child).is_file():
                        certificates.append(certificate_info(child))
                else:
                    walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(effective)
    fingerprint = digest(canonical([(f['path'], f['sha256']) for f in files]))
    return {'key': key, 'summary': {'engine': engine, 'unit': unit_name, 'active': active,
        'paths': [f['path'] for f in files], 'fingerprint': fingerprint, 'inbounds': inbounds,
        'certificates': certificates, 'listenPorts': sorted(listen_ports), 'warnings': warnings, 'managed': unit_name.startswith('blink-proxy-')},
        'configuration': {'files': files, 'effective': effective}}


def scan():
    discoveries, seen, warnings = [], set(), []
    units = run(['systemctl', 'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend'], optional=True)
    pid_units = {}
    for line in units.splitlines():
        unit_name = line.split()[0] if line.split() else ''
        if not re.fullmatch(r'[a-zA-Z0-9_.@:-]+\.service', unit_name):
            continue
        if not any(name in line.lower() for name in ('xray', 'sing-box', 'caddy', 'nginx', 'x-ui', 'blink-proxy')):
            continue
        info = run(['systemctl', 'show', unit_name, '--property=MainPID,ExecStart,WorkingDirectory,Environment'], optional=True)
        pid = re.search(r'^MainPID=(\d+)', info, re.M)
        if pid and pid[1] != '0':
            pid_units[pid[1]] = unit_name
        # Inactive services are still discoverable from their saved ExecStart.
        argv = re.search(r'argv\[\]=(.*?)(?: ;|\})', info)
        if argv and (not pid or pid[1] == '0'):
            try:
                args = shlex.split(argv[1])
                engine = next((e for e in ('xray', 'sing-box', 'caddy', 'nginx') if e in Path(args[0]).name), None)
                cwd = re.search(r'^WorkingDirectory=(.*)$', info, re.M)
                paths = config_files(args, cwd[1] if cwd and cwd[1] else '/')
                if engine and paths:
                    discoveries.append(discovery(engine, unit_name, paths, unit_name))
                    seen.update(str(p.resolve()) for p in paths)
            except (ValueError, IndexError):
                warnings.append(unit_name + ': 启动参数需要手动检查')
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            args = (proc / 'cmdline').read_bytes().decode(errors='replace').strip('\0').split('\0')
            executable = Path(os.readlink(proc / 'exe')).name
            engine = next((e for e in ('xray', 'sing-box', 'caddy', 'nginx') if executable == e or executable.startswith(e + '-')), None)
            if not engine:
                continue
            paths = config_files(args, os.readlink(proc / 'cwd'))
            if engine == 'xray':
                environment = (proc / 'environ').read_bytes().decode(errors='replace').split('\0')
                if not any(a.startswith('-confdir') for a in args):
                    for value in environment:
                        if value.startswith(('Xray_LOCATION_CONFDIR=', 'Xray.location.confdir=')):
                            paths.extend(sorted(Path(value.split('=', 1)[1]).glob('*.json')))
            if not paths:
                defaults = {'xray': ['/usr/local/etc/xray/config.json', '/etc/xray/config.json'],
                    'sing-box': ['/etc/sing-box/config.json'], 'caddy': ['/etc/caddy/Caddyfile'], 'nginx': ['/etc/nginx/nginx.conf']}
                paths = [Path(p) for p in defaults[engine] if Path(p).is_file()]
            paths = [p for p in paths if str(p.resolve()) not in seen]
            if not paths:
                continue
            unit_name = pid_units.get(proc.name, '')
            discoveries.append(discovery(engine, unit_name or engine + ':' + str(paths[0]), paths, unit_name, True))
            seen.update(str(p.resolve()) for p in paths)
        except (OSError, ValueError):
            continue
    for engine, patterns in {
        'xray': ['/etc/xray/*.json', '/usr/local/etc/xray/*.json', '/etc/xray/conf.d/*.json'],
        'sing-box': ['/etc/sing-box/*.json', '/usr/local/etc/sing-box/*.json'],
        'caddy': ['/etc/caddy/Caddyfile', '/etc/caddy/*.json'],
        'nginx': ['/etc/nginx/nginx.conf', '/etc/nginx/conf.d/*.conf', '/etc/nginx/sites-enabled/*'],
    }.items():
        paths = [Path(p) for pattern in patterns for p in glob.glob(pattern) if str(Path(p).resolve()) not in seen]
        if paths:
            discoveries.append(discovery(engine, engine + ':files', paths))
    # Record local-target associations without guessing credential-based links.
    for item in discoveries:
        targets = set()
        for inbound in item['summary']['inbounds']:
            if inbound['reality']:
                match = re.fullmatch(r'(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)', str(inbound['target']))
                if match:
                    targets.add(int(match[1]))
        if targets:
            item['summary']['localWebCandidates'] = [d['key'] for d in discoveries
                if targets.intersection(d['summary'].get('listenPorts', []))]
    result = {'discoveries': [], 'warnings': warnings, 'status': status()}
    for item in discoveries[:100]:
        result['discoveries'].append(item)
        if len(canonical(result)) > 200000:
            result['discoveries'].pop()
            result['warnings'].append('扫描输出达到上限，部分配置未导入')
            break
    return result


def handle(message):
    require(isinstance(message, dict) and message.get('v') == 1 and message.get('type') == 'proxy.run', '任务协议无效')
    task_id = str(uuid.UUID(message['taskId']))
    uuid.UUID(message['resourceId'])
    operation = message['operation']
    require(operation in ('scan', 'apply'), '操作不受支持')
    version = message['desiredVersion']
    require(type(version) is int and 0 <= version < 2**31, '配置版本无效')
    deadline = datetime.datetime.fromisoformat(message['deadline'].replace('Z', '+00:00')).timestamp()
    ledger = PRIVATE / 'tasks' / (task_id + '.json')
    request_hash = digest(canonical(message))
    previous = read_json(ledger)
    if previous:
        require(previous['requestHash'] == request_hash, '任务 ID 被用于不同请求')
        return previous['outcome']
    require(deadline > time.time(), '任务已过期')
    recover()
    try:
        result = scan() if operation == 'scan' else apply(message['payload'], version, deadline)
        outcome = {'ok': True, 'result': result}
    except DeploymentError as error:
        outcome = {'ok': False, 'result': {'error': str(error)[:500]}}
    except Exception:
        outcome = {'ok': False, 'result': {'error': '代理任务失败，请检查节点部署器日志和配置格式'}}
    atomic(ledger, canonical({'requestHash': request_hash, 'outcome': outcome}))
    return outcome


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(15)
        data = bytearray()
        while True:
            chunk = self.request.recv(16384)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > LIMIT:
                return
        with LOCK:
            try:
                outcome = handle(json.loads(data))
            except Exception:
                outcome = {'ok': False, 'result': {'error': '代理任务校验失败'}}
            encoded = canonical(outcome)
            if len(encoded) > LIMIT:
                encoded = canonical({'ok': False, 'result': {'error': '代理扫描结果超过大小上限'}})
        try:
            self.request.sendall(encoded)
        except OSError:
            pass  # Durable ledger returns the result on reconnect/redelivery.


def maintain():
    while True:
        time.sleep(60)
        if LOCK.acquire(blocking=False):
            try:
                data = read_json(ROOT / 'current' / 'desired.json', {'instances': []})
                sync_certificates(data)
                atomic(Path(CONTROL).with_name('status.json'), canonical(status(data)), 0o640,
                       (0, grp.getgrnam('blink-agent').gr_gid))
                for task in (PRIVATE / 'tasks').glob('*.json'):
                    if time.time() - task.stat().st_mtime > 7 * 86400:
                        task.unlink()
            except Exception:
                print('Proxy certificate synchronization failed', file=sys.stderr, flush=True)
            finally:
                LOCK.release()


def main():
    require(os.geteuid() == 0 and sys.platform == 'linux', 'Linux root service required')
    require(sys.argv[1:] == ['serve'], 'Usage: manager.py serve')
    recover()
    Path(CONTROL).unlink(missing_ok=True)
    with socketserver.UnixStreamServer(CONTROL, Handler) as server:
        os.chmod(CONTROL, 0o660)
        os.chown(CONTROL, 0, grp.getgrnam('blink-agent').gr_gid)
        threading.Thread(target=maintain, daemon=True).start()
        server.serve_forever()


if __name__ == '__main__':
    main()
