"""Unit regressions and real Linux Xray/Caddy/sing-box interoperability tests."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import zipfile

module = importlib.util.spec_from_file_location('manager', Path(__file__).with_name('proxy-manager.py'))
m = importlib.util.module_from_spec(module)
module.loader.exec_module(m)


def fixture():
    private = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
    return {'id': str(uuid.uuid4()), 'serverId': str(uuid.uuid4()), 'name': 'test', 'kind': 'reality',
            'port': 443, 'domain': 'entry.example.test', 'fallbackPort': 8003, 'upstream': 'https://upstream.example.test',
            'defaultOutbound': 'direct', 'rules': [], 'enabled': True, 'manageDns': False, 'udp': True,
            'credentials': {'uuid': str(uuid.uuid4()), 'privateKey': private, 'shortId': secrets.token_hex(8)},
            'exits': [], 'sources': []}


class ProxyTests(unittest.TestCase):
    def test_public_addresses_prefer_routed_stable_interfaces(self):
        interfaces = [
            {'ifname': 'eth1', 'addr_info': [{'local': '1.1.1.1', 'scope': 'global'}]},
            {'ifname': 'eth0', 'addr_info': [
                {'local': '8.8.8.8', 'scope': 'global'},
                {'local': '8.8.4.4', 'scope': 'global'},
                {'local': '10.0.0.1', 'scope': 'global'},
                {'local': '2606:4700::1001', 'scope': 'global', 'temporary': True},
                {'local': '2606:4700::1002', 'scope': 'global', 'flags': ['tentative']},
                {'local': '2606:4700::1003', 'scope': 'global', 'preferred_life_time': 0},
                {'local': '2606:4700::1111', 'scope': 'global'},
                {'local': 'fe80::1', 'scope': 'link'},
            ]},
        ]
        def command(args, **kwargs):
            self.assertEqual(args[0], 'ip', 'public interfaces do not need external lookup')
            if 'address' in args:
                return json.dumps(interfaces)
            return json.dumps([{'dev': 'eth0', 'prefsrc': '8.8.4.4' if '-4' in args else '2606:4700::1001'}])
        with patch.object(m, 'ADDRESS_CACHE', None), patch.object(m, 'run', side_effect=command) as run:
            result = m.public_addresses()
            self.assertEqual(result['addresses'], [
                {'address': '8.8.4.4', 'source': 'interface', 'interface': 'eth0'},
                {'address': '2606:4700::1111', 'source': 'interface', 'interface': 'eth0'},
            ])
            self.assertEqual(m.public_addresses(), result)
            self.assertEqual(run.call_count, 3, 'periodic reporting reuses address discovery')
            m.public_addresses(refresh=True)
            self.assertEqual(run.call_count, 6, 'manual scan refreshes discovery')

    def test_public_addresses_use_direct_family_specific_lookup_for_nat(self):
        def command(args, **kwargs):
            if args[0] == 'ip':
                return json.dumps([{'ifname': 'eth0', 'addr_info': [{'local': '192.168.1.2', 'scope': 'global'}]}]) if 'address' in args else '[]'
            self.assertEqual(args[0:2], ['curl', '--disable'])
            self.assertEqual(args[args.index('--noproxy') + 1], '*')
            self.assertEqual(args[-1], 'https://api.ip.sb/ip')
            self.assertLessEqual(kwargs['timeout'], 6)
            return '9.9.9.9\n' if '-4' in args else '2606:4700::1111\n'
        with patch.object(m, 'ADDRESS_CACHE', None), patch.object(m, 'run', side_effect=command):
            self.assertEqual(m.public_addresses()['addresses'], [
                {'address': '9.9.9.9', 'source': 'ip.sb'},
                {'address': '2606:4700::1111', 'source': 'ip.sb'},
            ])

    def test_public_address_lookup_failures_never_fill_invalid_addresses(self):
        for ipv4, ipv6 in [('', ''), ('<html>error</html>', '127.0.0.1'), ('2606:4700::1111', '8.8.8.8'), ('100.64.0.1', 'fd00::1')]:
            def command(args, **kwargs):
                return '' if args[0] == 'ip' else ipv4 if '-4' in args else ipv6
            with self.subTest(ipv4=ipv4, ipv6=ipv6), patch.object(m, 'ADDRESS_CACHE', None), patch.object(m, 'run', side_effect=command):
                self.assertEqual(m.public_addresses()['addresses'], [])

    def test_ufw_status_distinguishes_missing_disabled_active_and_failed(self):
        with patch.object(m.shutil, 'which', return_value=None), patch.object(m, 'run') as run:
            self.assertEqual(m.ufw_status(), {'ufwState': 'not_installed', 'ufw': ''})
            run.assert_not_called()
        for text, state in [('Status: active\nDefault: deny (incoming)\n443/tcp ALLOW Anywhere\n', 'active'), ('Status: inactive\n', 'inactive'), ('', 'error')]:
            with patch.object(m.shutil, 'which', return_value='/usr/sbin/ufw'), patch.object(m, 'run', return_value=text) as run:
                self.assertEqual(m.ufw_status(), {'ufwState': state, 'ufw': text})
                self.assertEqual(run.call_args.args[0], ['ufw', 'status', 'verbose'])

    def test_reality_local_tls_and_proxy_v2(self):
        item = fixture()
        data = {'instances': [item], 'addresses': ['8.8.8.8'], 'firewall': 'existing', 'email': 'test@example.test'}
        m.validate_payload(data)
        core = m.core_config(item)
        reality = core['inbounds'][0]['streamSettings']['realitySettings']
        self.assertEqual(reality['target'], '127.0.0.1:8003')
        self.assertEqual(reality['xver'], 2)
        web = m.caddy_config(data)
        server = web['apps']['http']['servers'][item['id']]
        self.assertEqual(server['listen'], ['127.0.0.1:8003'])
        self.assertEqual([v['wrapper'] for v in server['listener_wrappers']], ['proxy_protocol', 'tls'])
        self.assertNotIn('h3', server['protocols'])
        issuer = web['apps']['tls']['automation']['policies'][0]['issuers'][0]
        self.assertTrue(issuer['challenges']['tls-alpn']['disabled'])
        self.assertNotIn('dns', issuer['challenges'])

    def test_port_collision_and_invalid_keys_rejected(self):
        item = fixture()
        data = {'instances': [item, copy.deepcopy(item)], 'addresses': ['8.8.8.8'], 'firewall': 'existing', 'email': 'a@b.test'}
        data['instances'][1]['id'] = str(uuid.uuid4())
        with self.assertRaises(m.DeploymentError):
            m.validate_payload(data)
        data['instances'] = [item]
        item['domain'] = '../../root'
        with self.assertRaises(m.DeploymentError):
            m.validate_payload(data)

    def test_imported_ss2022_multi_user_exit_preserves_both_keys(self):
        item = fixture()
        password = ':'.join(base64.b64encode(secrets.token_bytes(16)).decode() for _ in range(2))
        exit = {'id': str(uuid.uuid4()), 'address': '1.1.1.1', 'port': 17501, 'udp': True, 'method': '2022-blake3-aes-128-gcm', 'password': password}
        item.update(exits=[exit], defaultOutbound=exit['id'])
        data = {'instances': [item], 'addresses': ['8.8.8.8'], 'firewall': 'external', 'email': 'a@b.test'}
        m.validate_payload(data)
        self.assertEqual(m.core_config(item)['outbounds'][1]['settings']['password'], password)
        item.update(kind='anytls', credentials={'password': base64.b64encode(secrets.token_bytes(32)).decode()})
        m.validate_payload(data)
        self.assertEqual(m.core_config(item)['outbounds'][1]['password'], password)
        exit['password'] = base64.b64encode(secrets.token_bytes(32)).decode()
        with self.assertRaises(m.DeploymentError):
            m.validate_payload(data)

    def test_route_order_and_final_are_explicit(self):
        item = fixture()
        item['rules'] = [{'match': 'domain', 'values': ['direct.test'], 'outbound': 'direct'}, {'match': 'ip_cidr', 'values': ['1.1.1.0/24'], 'outbound': 'direct'}]
        item['defaultOutbound'] = 'exit'
        config = m.core_config(item)
        self.assertEqual(config['routing']['rules'][0]['domain'], ['full:direct.test'])
        self.assertEqual(config['routing']['rules'][-1]['outboundTag'], 'exit')

    def test_scanner_preserves_json_comments_and_multifile_order(self):
        config = json.loads(m.strip_json_comments('{"url":"https://host/", /*a*/ "inbounds":[] // hi\n}'))
        self.assertEqual(config['url'], 'https://host/')
        merged = m.merge_configs('xray', [
            {'path': '01.json', 'config': {'inbounds': [{'tag': 'in', 'port': 1}], 'outbounds': [{'tag': 'direct'}]}},
            {'path': '02.json', 'config': {'inbounds': [{'tag': 'in', 'port': 2}], 'outbounds': [{'tag': 'exit'}]}},
            {'path': '03_tail.json', 'config': {'outbounds': [{'tag': 'last'}]}}])
        self.assertEqual(merged['inbounds'][0]['port'], 2)
        self.assertEqual([o['tag'] for o in merged['outbounds']], ['exit', 'direct', 'last'])
        paths = m.config_files(['xray', 'run', '-config=/etc/xray/a.json', '-c', 'b.json'], '/opt/xray')
        self.assertEqual(paths, [Path('/etc/xray/a.json'), Path('/opt/xray/b.json')])

    def test_ss_firewall_restricted_sources_and_no_internal_port(self):
        entrance = fixture()
        exit = fixture()
        exit.update(kind='shadowsocks2022', port=8388, sources=['8.8.8.8'], credentials={'method': '2022-blake3-aes-256-gcm', 'password': base64.b64encode(secrets.token_bytes(32)).decode()})
        rules = m.ufw_rules({'instances': [entrance, exit]})
        self.assertIn(['8.8.8.8', 8388, 'udp'], rules)
        self.assertNotIn(['any', 8388, 'tcp'], rules)
        self.assertFalse(any(rule[1] == 8003 for rule in rules))

    def test_task_redelivery_does_not_rescan(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(m, 'PRIVATE', Path(temp)), patch.object(m, 'recover'), patch.object(m, 'scan', return_value={'discoveries': []}) as scan:
            message = {'v': 1, 'type': 'proxy.run', 'taskId': str(uuid.uuid4()), 'resourceId': str(uuid.uuid4()), 'operation': 'scan', 'desiredVersion': 0,
                       'deadline': '2099-01-01T00:00:00Z', 'payload': {}}
            self.assertEqual(m.handle(message), m.handle(message))
            self.assertEqual(scan.call_count, 1)
            message['operation'] = 'apply'
            with self.assertRaises(m.DeploymentError):
                m.handle(message)

    def test_renewal_restarts_all_shared_domain_instances_and_retries(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cert = root / 'source.crt'; cert.write_text('renewed certificate')
            key = root / 'source.key'; key.write_text('renewed key')
            one, two = fixture(), fixture()
            one['kind'] = two['kind'] = 'anytls'
            private = root / 'manager'
            with patch.object(m, 'ROOT', root), patch.object(m, 'PRIVATE', private), patch.object(m, 'certificate_source', return_value=(cert, key)), \
                 patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_gid=os.getgid())), \
                 patch.object(m.os, 'chown'), patch.object(m.os, 'fchown'), \
                 patch.object(m, 'run', side_effect=[None, m.DeploymentError('restart interrupted')]) as run:
                with self.assertRaises(m.DeploymentError):
                    m.sync_certificates({'instances': [one, two]})
                self.assertEqual(run.call_count, 2)
                self.assertTrue((private / 'certificate-restarts' / two['id']).exists())
                run.side_effect = None
                m.sync_certificates({'instances': [one, two]})
                self.assertEqual(run.call_count, 3)
                self.assertFalse((private / 'certificate-restarts' / two['id']).exists())

    def test_firewall_preserves_existing_rules_and_checks_ownership(self):
        rule = ['any', 443, 'tcp']
        with patch.object(m, 'run', return_value="ufw allow 443/tcp comment 'administrator'\n") as command:
            self.assertFalse(m.ufw_change(rule))
            self.assertFalse(m.ufw_change(rule, delete=True))
            self.assertTrue(all(call.args[0] == ['ufw', 'show', 'added'] for call in command.call_args_list))
        with patch.object(m, 'run', side_effect=["ufw allow 443/tcp comment '" + m.ufw_tag(rule) + "'\n", '']) as command:
            self.assertTrue(m.ufw_change(rule, delete=True))
            self.assertEqual(command.call_args_list[-1].args[0][:3], ['ufw', '--force', 'delete'])

    def test_scanner_follows_web_includes_and_associates_listeners(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'Caddyfile').write_text('import sites/*\n')
            (root / 'sites').mkdir()
            (root / 'sites' / 'local').write_text('https://entry.test:8003 {\n respond ok\n}\n')
            result = m.discovery('caddy', 'caddy.service', [root / 'Caddyfile'])
            self.assertEqual(len(result['configuration']['files']), 2)
            self.assertEqual(result['summary']['listenPorts'], [8003])

    def test_interrupted_deployment_restores_old_generation_and_units(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); private = root / 'manager'; private.mkdir(); units = root / 'units'; units.mkdir()
            old = root / 'old'; old.mkdir(); new = root / 'new'; new.mkdir()
            (old / 'desired.json').write_text(json.dumps({'instances': []}))
            (root / 'current').symlink_to(new)
            (units / 'blink-proxy-test.service').write_text('new')
            transaction = {'previous': str(old), 'newUnits': ['blink-proxy-test.service'], 'unitBackups': {'old.service': 'old'},
                           'firewallBefore': [], 'firewallAfter': [], 'appliedBefore': {'version': 3}}
            (private / 'transaction.json').write_text(json.dumps(transaction))
            with patch.object(m, 'ROOT', root), patch.object(m, 'PRIVATE', private), patch.object(m, 'UNITS', units), patch.object(m, 'run', return_value=''):
                m.recover()
                self.assertEqual((root / 'current').resolve(), old.resolve())
                self.assertFalse((units / 'blink-proxy-test.service').exists())
                self.assertEqual((units / 'old.service').read_text(), 'old')
                self.assertEqual(json.loads((private / 'applied.json').read_text())['version'], 3)


def integration():
    """Local CA is test-only; production generator always uses Let's Encrypt."""
    import http.server
    from concurrent.futures import ThreadPoolExecutor
    work = Path(tempfile.mkdtemp(prefix='blink-proxy-test-'))
    processes = []
    servers = []
    try:
        manifest = json.loads(Path(__file__).with_name('proxy-assets.json').read_text())
        arch = 'arm64' if os.uname().machine == 'aarch64' else 'amd64'
        bins = {}
        for engine in manifest:
            asset = manifest[engine][arch]
            archive = Path('/releases/downloads/proxy') / asset['file']
            assert m.digest(archive.read_bytes()) == asset['sha256']
            if archive.suffix == '.zip':
                with zipfile.ZipFile(archive) as package:
                    data = package.read(asset['member'])
            else:
                with tarfile.open(archive) as package:
                    data = package.extractfile(asset['member']).read()
            bins[engine] = work / engine
            bins[engine].write_bytes(data); bins[engine].chmod(0o755)
        def command(args):
            subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        ca = work / 'ca.crt'; ca_key = work / 'ca.key'; cert = work / 'server.crt'; key = work / 'server.key'
        command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ca_key), '-out', str(ca), '-days', '1', '-subj', '/CN=Blink test CA'])
        command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(work / 'server.csr'), '-subj', '/CN=entry.example.test'])
        (work / 'extensions').write_text('subjectAltName=DNS:entry.example.test,DNS:any.example.test,DNS:upstream.example.test\nextendedKeyUsage=serverAuth\n')
        command(['openssl', 'x509', '-req', '-in', str(work / 'server.csr'), '-CA', str(ca), '-CAkey', str(ca_key), '-CAcreateserial', '-out', str(cert), '-days', '1', '-extfile', str(work / 'extensions')])
        with open('/etc/hosts', 'a') as hosts:
            hosts.write('\n127.0.0.1 entry.example.test any.example.test upstream.example.test direct.test chain.test imported.test\n127.0.0.2 ipdirect.test\n')
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b'blink-proxy-ok')
            def log_message(self, *_):
                pass
        plain = http.server.ThreadingHTTPServer(('0.0.0.0', 18080), Handler); servers.append(plain)
        tls = http.server.ThreadingHTTPServer(('127.0.0.1', 18443), Handler); servers.append(tls)
        context = m.ssl.SSLContext(m.ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
        tls.socket = context.wrap_socket(tls.socket, server_side=True)
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        def launch(engine, config, name):
            path = work / (name + '.json'); path.write_text(json.dumps(config))
            log = open(work / (name + '.log'), 'wb')
            args = [str(bins[engine]), 'run', '--config' if engine == 'caddy' else '-c', str(path)]
            env = {**os.environ, 'SSL_CERT_FILE': str(ca)}
            p = subprocess.Popen(args, stdout=log, stderr=log, env=env)
            processes.append((p, log, name))
            return p
        def ready(port):
            until = time.time() + 10
            while time.time() < until:
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                        return
                except OSError:
                    time.sleep(0.1)
            raise AssertionError('Listener not ready: ' + str(port))
        reality = fixture()
        reality['upstream'] = 'https://upstream.example.test:18443'
        # Obtain the public key from the actual pinned Xray implementation.
        output = subprocess.check_output([str(bins['xray']), 'x25519', '-i', reality['credentials']['privateKey']], text=True)
        import re
        public = re.search(r'(?:Password|Public key|PublicKey)[^:\n]*:\s*([A-Za-z0-9_-]{43})', output)[1]
        ss = fixture(); ss.update(kind='shadowsocks2022', port=18388, domain='', credentials={'method': '2022-blake3-aes-256-gcm', 'password': base64.b64encode(secrets.token_bytes(32)).decode()})
        exit = {'id': ss['id'], 'address': '127.0.0.1', 'port': ss['port'], 'udp': True, **ss['credentials']}
        server_key, user_key = (base64.b64encode(secrets.token_bytes(16)).decode() for _ in range(2))
        imported_exit = {'id': str(uuid.uuid4()), 'address': '127.0.0.1', 'port': 18389, 'udp': True, 'method': '2022-blake3-aes-128-gcm', 'password': server_key + ':' + user_key}
        reality.update(exits=[exit, imported_exit], defaultOutbound=ss['id'], rules=[{'match': 'domain', 'values': ['imported.test'], 'outbound': imported_exit['id']}, {'match': 'domain', 'values': ['direct.test'], 'outbound': 'direct'}, {'match': 'ip_cidr', 'values': ['127.0.0.2/32'], 'outbound': 'direct'}])
        anytls = copy.deepcopy(reality); anytls.update(id=str(uuid.uuid4()), kind='anytls', port=18444, domain='any.example.test', credentials={'password': base64.b64encode(secrets.token_bytes(32)).decode()})
        data = {'instances': [reality, anytls], 'addresses': ['8.8.8.8'], 'email': 'test@example.test', 'firewall': 'external'}
        web = m.caddy_config(data)
        web['admin'] = {'disabled': True}
        web['storage']['root'] = str(work / 'caddy-storage')
        web['apps']['tls'] = {'certificates': {'load_files': [{'certificate': str(cert), 'key': str(key)}]}}
        for server in web['apps']['http']['servers'].values():
            server['automatic_https'] = {'disable': True}
        launch('caddy', web, 'caddy'); ready(8003)
        ss_process = launch('sing-box', m.core_config(ss), 'ss'); ready(18388)
        launch('sing-box', {'inbounds': [{'type': 'shadowsocks', 'listen': '127.0.0.1', 'listen_port': 18389, 'method': imported_exit['method'], 'password': server_key, 'users': [{'name': 'existing', 'password': user_key}]}], 'outbounds': [{'type': 'direct'}]}, 'existing-multi-user-ss'); ready(18389)
        reality_config = m.core_config(reality)
        # Xray 26.11 blocks loopback in freedom by default. This exception is
        # limited to the isolated test target; production retains core defaults.
        reality_config['outbounds'][0]['settings']['finalRules'] = [{'action': 'allow', 'ip': ['127.0.0.0/8']}]
        launch('xray', reality_config, 'reality'); ready(443)
        any_config = m.core_config(anytls)
        any_config['inbounds'][0]['tls'].update(certificate_path=str(cert), key_path=str(key))
        launch('sing-box', any_config, 'anytls'); ready(18444)
        for protocol, port, server_port in [('vless', 19080, 443), ('anytls', 19081, 18444)]:
            if protocol == 'vless':
                launch('xray', {'log': {'loglevel': 'warning'},
                    'inbounds': [{'listen': '127.0.0.1', 'port': port, 'protocol': 'socks', 'settings': {'udp': True}}],
                    'outbounds': [{'protocol': 'vless', 'settings': {'address': '127.0.0.1', 'port': 443,
                        'id': reality['credentials']['uuid'], 'encryption': 'none', 'flow': 'xtls-rprx-vision'},
                        'streamSettings': {'network': 'raw', 'security': 'reality', 'realitySettings': {
                            'serverName': reality['domain'], 'fingerprint': 'chrome', 'password': public,
                            'shortId': reality['credentials']['shortId']}}}]}, 'client-vless')
                ready(port)
                continue
            outbound = {'type': protocol, 'tag': 'proxy', 'server': '127.0.0.1', 'server_port': server_port,
                        'tls': {'enabled': True, 'server_name': 'entry.example.test' if protocol == 'vless' else 'any.example.test'}}
            if protocol == 'vless':
                outbound.update(uuid=reality['credentials']['uuid'], flow='xtls-rprx-vision')
                outbound['tls'].update(utls={'enabled': True, 'fingerprint': 'chrome'}, reality={'enabled': True, 'public_key': public, 'short_id': reality['credentials']['shortId']})
            else:
                outbound.update(password=anytls['credentials']['password'])
            launch('sing-box', {'inbounds': [{'type': 'mixed', 'listen': '127.0.0.1', 'listen_port': port}], 'outbounds': [outbound]}, 'client-' + protocol)
            ready(port)
        def get(port, host):
            return subprocess.run(['curl', '-fsS', '--max-time', '15', '--noproxy', '', '--socks5-hostname', '127.0.0.1:' + str(port), 'http://' + host + ':18080/'], capture_output=True, timeout=18)
        for port in (19080, 19081):
            for host in ('chain.test', 'direct.test', 'ipdirect.test', 'imported.test'):
                result = get(port, host)
                assert result.returncode == 0 and result.stdout == b'blink-proxy-ok', (port, host, result.stderr)
        fallback = subprocess.run(['curl', '-fsS', '--max-time', '10', '--noproxy', '*', '--cacert', str(ca), 'https://entry.example.test/'], capture_output=True)
        assert fallback.returncode == 0 and fallback.stdout == b'blink-proxy-ok', fallback.stderr
        import socketserver
        class Echo(socketserver.BaseRequestHandler):
            def handle(self):
                data, sock = self.request
                sock.sendto(data, self.client_address)
        udp = socketserver.UDPServer(('127.0.0.1', 18081), Echo)
        servers.append(udp)
        threading.Thread(target=udp.serve_forever, daemon=True).start()
        def receive(sock, size):
            data = b''
            while len(data) < size:
                chunk = sock.recv(size - len(data))
                assert chunk, 'SOCKS closed early'
                data += chunk
            return data
        for port in (19080, 19081):
            with socket.create_connection(('127.0.0.1', port), timeout=15) as control, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                client.bind(('127.0.0.1', 0)); client.settimeout(15)
                control.sendall(b'\x05\x01\x00'); assert receive(control, 2) == b'\x05\x00'
                control.sendall(b'\x05\x03\x00\x01\x7f\x00\x00\x01' + m.struct.pack('!H', client.getsockname()[1]))
                header = receive(control, 4); assert header[:2] == b'\x05\x00'
                address = receive(control, 4 if header[3] == 1 else 16)
                relay_port = m.struct.unpack('!H', receive(control, 2))[0]
                message = b'\x00\x00\x00\x01\x7f\x00\x00\x01' + m.struct.pack('!H', 18081) + b'blink-udp-ok'
                client.sendto(message, ('127.0.0.1', relay_port))
                assert client.recv(4096).endswith(b'blink-udp-ok'), port
        # Kill the SS hop: direct rules still work, chain traffic must not fail open.
        ss_process.terminate(); ss_process.wait(timeout=5)
        for port in (19080, 19081):
            assert get(port, 'chain.test').returncode != 0
            assert get(port, 'direct.test').stdout == b'blink-proxy-ok'
            assert get(port, 'ipdirect.test').stdout == b'blink-proxy-ok'
        # Exercise apply -> failure/rollback -> uninstall with real sing-box
        # processes under the production service UID, substituting only systemd.
        command(['useradd', '--system', '--user-group', '--no-create-home', 'blink-proxy'])
        user = m.pwd.getpwnam('blink-proxy')
        work.chmod(0o755)
        managed = work / 'managed'; managed.mkdir(mode=0o750); os.chown(managed, 0, user.pw_gid)
        private = managed / 'manager'; private.mkdir(mode=0o700)
        units = work / 'units'; units.mkdir()
        running = {}
        real_run = m.run
        def stop(name):
            if name in running and running[name].poll() is None:
                running[name].terminate(); running[name].wait(timeout=5)
        def service_run(args, **kwargs):
            if args[0] == 'ufw':
                return ''
            if args[0] != 'systemctl':
                return real_run(args, **kwargs)
            action, name = args[1], args[-1]
            if action in ('restart', 'try-restart') or (action == 'enable' and '--now' in args):
                stop(name)
                content = (units / name).read_text()
                argv = m.shlex.split(next(line[10:] for line in content.splitlines() if line.startswith('ExecStart=')))
                log = open(work / ('managed-' + str(len(processes)) + '.log'), 'wb')
                process = subprocess.Popen(argv, stdout=log, stderr=log, user=user.pw_uid, group=user.pw_gid)
                running[name] = process
                processes.append((process, log, Path(log.name).stem))
                time.sleep(0.2)
            elif action == 'disable':
                stop(name)
            elif action == 'is-active':
                return 'active' if name in running and running[name].poll() is None else ''
            return ''
        def service_ready(name):
            time.sleep(0.2)
            m.require(service_run(['systemctl', 'is-active', name]) == 'active', 'test service failed')
        managed_ss = copy.deepcopy(ss); managed_ss['port'] = 19388
        desired = {'instances': [managed_ss], 'addresses': ['8.8.8.8'], 'email': '', 'firewall': 'external'}
        with patch.object(m, 'ROOT', managed), patch.object(m, 'PRIVATE', private), patch.object(m, 'UNITS', units), \
             patch.object(m, 'binary', side_effect=lambda e: bins[e]), patch.object(m, 'install_binary'), \
             patch.object(m, 'run', side_effect=service_run), patch.object(m, 'wait_service', side_effect=service_ready):
            result = m.apply(desired, 1, time.time() + 60)
            assert result['status']['instances'][0]['state'] == 'active'
            assert m.apply(desired, 1, time.time() + 60)['message'] == '配置版本已应用'
            failed = copy.deepcopy(desired); failed['instances'][0]['port'] = 18080
            try:
                m.apply(failed, 2, time.time() + 60)
                raise AssertionError('Occupied port must fail deployment')
            except m.DeploymentError:
                pass
            assert m.read_json(private / 'applied.json')['version'] == 1
            assert m.status()['instances'][0]['state'] == 'active'
            ready(19388)
            m.apply({**desired, 'instances': []}, 3, time.time() + 60)
            assert not list(units.glob('*.service'))
            assert not (private / 'transaction.json').exists()
        print('PASS real cores: REALITY/Vision + AnyTLS → SS2022 TCP/UDP, domain/IP routing, fail-closed exit, PROXY-v2 TLS fallback; unprivileged deployment, idempotency, rollback and uninstall')
    except Exception:
        for p, log, name in processes:
            log.flush()
            # Logs stay in this disposable container; generated credentials are
            # never copied into CI artifacts or printed into the chat.
            print(name + ': exit=' + str(p.poll()), file=sys.stderr)
            text = (work / (name + '.log')).read_text(errors='replace')
            for secret in (reality['credentials'].values() if 'reality' in locals() else []):
                text = text.replace(secret, '[redacted]')
            print(text[-6000:], file=sys.stderr)
        raise
    finally:
        for p, log, _ in processes:
            if p.poll() is None:
                p.terminate()
                try: p.wait(timeout=5)
                except subprocess.TimeoutExpired: p.kill(); p.wait()
            log.close()
        for server in servers:
            server.shutdown()
        shutil.rmtree(work)


if __name__ == '__main__':
    if '--integration' in sys.argv:
        integration()
    else:
        unittest.main()
