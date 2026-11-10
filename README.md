# Blink Node

面向个人管理的服务器探针与运维控制台。两个子项目：**Next.js Web / 控制端** 和 **Rust Agent**。

## 已实现

- Linux x86_64 / ARM64 Agent：CPU、内存、Swap、负载、磁盘容量 / inode、磁盘 I/O、网卡速率 / 流量、可用温度传感器。
- 服务器分组、标签、备注、在线状态、历史图表、UTC 账期与网卡流量配额。
- xterm.js 网页终端、PTY 尺寸同步、Ctrl+C、多会话、退出清理。
- 按需进程 Top、systemd 服务与最近系统日志。
- Agent 或 Master 发起 TCP / HTTP / ICMP / TLS 检查；延迟、丢包与证书有效期。
- 持续时间、恢复阈值、静默、恢复通知；Telegram 和签名 HTTPS Webhook；失败重试与投递记录。
- 管理员密码 + TOTP，近期高权限验证、会话撤销、接入凭证轮换与操作审计。
- PostgreSQL 分区、分钟 / 小时聚合、有界离线缓存、重连补传与去重。
- Agent 定时自动更新、双重 SHA256 校验、同版本构建识别、连接健康检查与失败回滚。

- 代理管理：Xray REALITY/Vision、sing-box AnyTLS / SS2022、服务端两跳分流、Cloudflare A/AAAA、节点 HTTP-01 证书、UFW 与已有配置扫描。

## 结构

```text
web/        Next.js 16 + shadcn/ui + PostgreSQL + Drizzle
            realtime/ 独立常驻 WebSocket 网关和定时任务
agent/      Rust / Tokio / rustls / sysinfo / portable-pty
protocol/   通信协议、扩展约束
deploy/     Caddy、Compose、systemd、初始化工具
```

## 公网 Master 部署

要求：Linux x86_64 / ARM64、Docker Compose v2、一个已指向服务器的域名，开放 TCP 80 / 443。
建议起步 2 核 / 4 GiB，300 台时优先配置 4 核 / 8 GiB 并观察数据库磁盘增长。

在项目根目录执行：

```bash
python3 deploy/bootstrap.py --domain monitor.example.com
docker compose --env-file .env -f deploy/compose.yml --profile setup pull
docker compose --env-file .env -f deploy/compose.yml up -d postgres
docker compose --env-file .env -f deploy/compose.yml run --rm migrate
docker compose --env-file .env -f deploy/compose.yml --profile setup run --rm admin
docker compose --env-file .env -f deploy/compose.yml up -d web gateway caddy
```

生产 Compose 使用 `registry.windgyre.com/library/blink-node-web:0.1.0`，同一个双架构镜像分别运行
Web、网关、迁移与管理员初始化进程。可通过 `.env` 的 `BLINK_IMAGE` 固定其他版本或镜像 digest。
如果仓库要求认证，先在服务器执行 `docker login registry.windgyre.com`。

初始化工具只在本机 `.secrets/` 生成随机秘密，不会打印、上传或覆盖现有文件。
`.secrets/` 目录权限为 0700，其他本机用户无法进入；Compose 挂载的秘密文件为 0444，
使容器内非 root 用户可读取已授权的文件（本地 Compose bind mount 保留宿主 UID / 权限）。不要放宽目录权限或将秘密文件移到公开目录。
在你自己的终端查看 `.secrets/admin_password`，将 `.secrets/admin_totp_uri` 或
`.secrets/admin_totp` 导入身份验证器。默认账号 `admin`。不要把这些内容贴进聊天、工单或版本库。
密码和身份验证器分开保管，生产部署后将初始化用管理员秘密移入加密离线保管库；日常服务只挂载数据库连接串和加密密钥。

**只有 Caddy 发布公网端口**。Web、网关和数据库没有宿主机端口映射。
Caddy 自动申请证书并跳转 HTTPS。实际公网域名通过 `PUBLIC_URL` 固定，不能使用请求 Host 动态推断。
不要绕过 Caddy 直接暴露 3000 / 3001 / 5432，也不要将 `TRUST_PROXY=true` 的进程直接暴露到公网。

### 管理员恢复

在 Master 本机安全更新 `.secrets/admin_password` 和 `.secrets/admin_totp` 后：

```bash
RESET_ADMIN=true docker compose --env-file .env -f deploy/compose.yml --profile setup run --rm admin
```

此操作替换凭证并撤销所有会话。没有公开注册、默认密码或免认证的 Web 初始化入口。
TOTP 有重放保护，同一个验证码只能成功使用一次；需要再次验证时请等待下一周期。

## 安装 Agent

### 面板一键安装（推荐）

1. 点击 **添加服务器**，填写名称和分组，生成接入凭证。
2. 按需勾选 **启用网页终端（root 用户）**（默认关闭）。启用后，Agent 服务和网页 Shell 均以 root 运行。
3. 点击 **复制一键安装命令**，在目标服务器的 root Shell 中粘贴运行（普通用户先执行 `sudo -i`）。
4. 等待几秒，面板将显示在线和监控数据。

安装器自动识别 x86_64 / ARM64，从你的 Master 的 `/downloads/agent/v0.1.0/` 下载静态 musl 二进制，
核对 SHA256、创建服务用户、写入配置、消费单次凭证并启动 systemd 或 OpenRC；启用终端时自动配置 root 服务身份，同时默认启用自动更新。
支持 Alpine / OpenRC（x86_64、ARM64），面板命令从 `/bin/sh` 启动，自动通过 `apk` 安装 Bash、curl、CA 证书、Python、PyYAML 及代理管理依赖。Alpine 主机需要已运行 OpenRC；Debian / Ubuntu 需要运行 systemd，可先安装 `curl ca-certificates python3`。Mihomo 扫描依赖 PyYAML，部署器安装时自动安装发行版对应软件包。
安装不依赖目标服务器访问 GitHub，也无需 Rust 编译环境。手动调用安装器时可传入 `--no-auto-update` 关闭自动更新。

接入凭证有效 15 分钟；它通过 stdin 和临时 0600 文件传递，不进入 curl URL 或安装器的 argv。
复制的命令本身包含凭证，可能被 Shell 历史记录，请勿转发；成功或失败退出都会清理临时文件。
脚本和二进制下载是公开静态资源，注册及管理仍需认证，不会在下载端点暴露凭证。

安装器拒绝覆盖已有配置或身份。注册失败会撤销本次写入的文件，可生成新命令重试；
注册后服务启动失败则保留身份，使用 `journalctl -u blink-agent` 排查后 `systemctl restart blink-agent`。
Alpine 对应使用 `rc-service blink-agent status`、`rc-service blink-agent restart`，日志位于 `/var/log/blink-agent/current.log`；代理部署器日志位于 `/var/log/blink-proxy-manager/current.log`。

### 手动安装

支持主流 systemd Linux 与 Alpine / OpenRC，内核指标来自宿主机。Agent 推荐作为原生服务运行。
在对应 CPU 架构上构建，或从 Master 的 `/downloads/agent/v0.1.0/` 取得对应架构的压缩包，
用同目录的 `SHA256SUMS` 核对后解压：

```bash
cd agent
cargo build --release --locked
```

在目标服务器准备 `config.toml`（参考 `agent/config.example.toml`），将 `server_url` 改成 Master HTTPS 地址。
将二进制、配置及 `deploy/agent/` 安装文件复制到目标服务器后：

```bash
sudo bash deploy/agent/install.sh /path/to/blink-agent /path/to/config.toml
```

面板“接入服务器”生成 15 分钟一次性凭证。使用本机编辑器将其保存到
`/root/blink-enrollment-token`，权限设为 0600，然后：

```bash
sudo chmod 600 /root/blink-enrollment-token
sudo blink-agent enroll --token-file /root/blink-enrollment-token
sudo chown blink-agent:blink-agent /var/lib/blink-agent/identity.json
sudo rm /root/blink-enrollment-token
sudo systemctl enable --now blink-agent
sudo systemctl status blink-agent
```

Agent 仅主动访问 Master，无需开放入站端口。默认普通系统用户、只读系统视图、独立私有状态目录。
Alpine 手动安装先准备 Bash、Python、curl、CA 证书和 coreutils；服务使用 `rc-update add blink-agent default` 设置开机启动，使用 `rc-service blink-agent start` 启动。
修改配置后 `sudo systemctl restart blink-agent`。
手动升级使用相同用户 / 状态目录，替换二进制后重启；自动升级见下节。

重新接入已有机器时，在面板生成新的接入凭证，将其写入 root 的 0600 文件，
先停止服务，然后按上方 `blink-agent enroll --token-file` 步骤注册、恢复身份文件归属，再启动服务。
不要删除原有身份文件；凭证轮换由面板控制。

### Agent 自动更新

systemd 的一键安装默认启用 `blink-agent-update.timer`：启动后约 3 分钟首次检查，之后每次结束约 15 分钟再检查，
附加最多 2 分钟随机延迟，避免节点同时下载。更新源固定为本机配置 `server_url` 对应 Master 的
`/downloads/agent/latest.json`；发布构建会自动生成该清单并随 Web 镜像部署。
Alpine 使用 OpenRC 的 crond 和 `/etc/periodic/15min/blink-agent-update`，每 15 分钟检查；健康检查同时验证监督进程身份和本次启动日志中的 Master 连接成功记录，失败时同样回滚。删除该 periodic 脚本即可暂停定时更新。

- 更新器由独立的 root systemd 服务或 crond 运行，监控 Agent 仍可保持普通用户身份。
- HTTPS 校验证书，不接受下载重定向；下载有时间和大小上限，校验压缩包及解压后二进制的 SHA256、版本和架构。
- 以二进制 SHA256 识别变化，因此同版本重新构建也可更新；拒绝低于当前版本号的发布。
- 原子替换二进制并重启 Agent；验证新进程至少运行 10 秒且已连接 Master，最长等待 60 秒。
- 启动失败、崩溃或未连接 Master 时恢复旧二进制；失败的二进制不会反复安装，直到发布不同构建或显式重试。
- 更新事务和旧二进制保存在 root 私有的 `/var/lib/blink-agent-update/`；执行中断后，下次定时任务先恢复旧版本。
- 更新只替换 Agent 二进制，保留接入身份、监控配置、systemd 本地覆盖及 root 终端设置。更新时现有终端会断开，完成后重连即可。

Master 尚未部署更新清单时，更新器记录提示并等下一周期，不影响监控。发布新版本后，需先部署 Master Web 镜像，
节点才会从该 Master 获取新版本；仅推送代码或镜像不会直接影响节点。

#### 已安装节点启用自动更新

当前 0.1.0 节点可直接启用，无需重新注册。从已核对 SHA256 的新版 Agent 压缩包解压安装文件到同一目录，保留 `service-platform.sh`、`enable-auto-update.sh`、`update-agent.py`、`blink-agent-update.service`、`blink-agent-update.timer` 和 `blink-agent-update.cron`。
安装 Python 3.9+ 和 CA 证书后执行：

```bash
sudo bash enable-auto-update.sh
sudo systemctl start blink-agent-update.service
sudo journalctl -u blink-agent-update.service --no-pager -n 30
```

检查更新而不安装、查看定时器、暂停更新以及显式重试失败构建：

```bash
sudo /usr/local/libexec/blink-agent-update --check
sudo systemctl list-timers blink-agent-update.timer
sudo systemctl disable --now blink-agent-update.timer
sudo /usr/local/libexec/blink-agent-update --retry-failed
```

手动暂停 Agent 时更新器不会启动它；若存在被中断的更新事务，则优先执行恢复。
更新器本身和 systemd 单元通过再次运行 `enable-auto-update.sh` 升级，下载包中的脚本不会在自动更新时执行。

### 网页终端权限

面板一键安装时勾选 **启用网页终端（root 用户）**，安装器会同时设置本地配置与 systemd override；OpenRC 使用 `/etc/conf.d/blink-agent` 中的 `blink_user=root`。
未勾选时终端关闭，Agent 仍以普通 `blink-agent` 用户运行。

#### 已安装节点切换为 root

将 `deploy/agent/enable-root-terminal.sh`、`deploy/agent/root-terminal.conf.example` 和 `deploy/agent/service-platform.sh` 复制到目标服务器同一目录，
或从新版 Agent 发布压缩包解压这些文件，然后在该目录执行：

```bash
sudo bash enable-root-terminal.sh
```

脚本保留原有接入身份和 Master 地址，备份配置为 `/etc/blink-agent/config.toml.before-root-terminal`，
写入 root 配置与 `/etc/systemd/system/blink-agent.service.d/terminal.conf`，重新加载 systemd 并重启 Agent。
已有终端会断开；待节点重新在线后，新建网页终端，执行 `id -un` 应输出 `root`。
此切换适用于当前已安装的 Agent，无需更新二进制或重新注册。

对应的本地配置为：

```toml
terminal_enabled = true
terminal_user = "root"
allow_root_terminal = true
```

Root override 同时解除普通监控服务的只读文件系统、私有临时目录、内核操作限制及内存 / 进程数限制，
使终端可用于安装软件、修改系统配置和管理服务。终端身份与服务进程身份一起切换。

#### 普通用户终端

手动安装仍可使用普通用户终端，配置为：

```toml
terminal_enabled = true
terminal_user = "blink-agent"
allow_root_terminal = false
```

普通用户服务只能打开自身身份的 Shell。默认 systemd 沙箱允许其在状态目录操作，系统目录只读。
手动配置 root 终端时，须同时安装 `deploy/agent/root-terminal.conf.example` 为 systemd override，
并配置 `terminal_user = "root"`、`allow_root_terminal = true`，随后执行 daemon-reload 和 restart。

系统日志可见范围由服务用户权限决定。需要系统 journal 时，可以把 `blink-agent` 加入 `systemd-journal` 组并重启服务。
ICMP 依赖系统 `ping` 命令与允许的 ping socket 权限；必要时为服务用户所在 GID 配置 `net.ipv4.ping_group_range`。
容器 / 精简发行版没有 systemd 或 journal 时，相应诊断显示不可用。

## 代理服务

在“设置 → 代理节点 · DNS 与证书”保存限定 Zone 的 Cloudflare Token（Zone Read + DNS Edit）与 ACME 邮箱，然后在“代理服务”中选择节点，确认公网 IP 和防火墙策略。

节点通过 `ip -j address` 识别公网 IPv4/IPv6，优先使用路由网卡的稳定地址；缺少对应地址族时使用直连 `curl -4/-6 https://api.ip.sb/ip` 探测出口。首次探测自动填充空地址，后续不会覆盖已保存的地址。地址探测缓存 5 分钟，“刷新节点扫描”立即重新探测。客户端连接地址始终为 IP，证书域名仅用于 TLS / SNI；NAT 节点需核对公网入站映射。

先在落地节点安装 **Shadowsocks 2022**，再在入口节点安装 **AnyTLS** 或 **VLESS · REALITY / Vision**，选择默认出口；规则按列表顺序匹配完整域名、域名后缀或 IP/CIDR，支持指定其他 SS2022 出口或直接出网。出口失效时链路失败，不自动改走直连。入口和落地都需要在面板中管理。

已有 Xray / sing-box 的 Shadowsocks 服务也可复用：刷新落地节点扫描，在“已有服务扫描”点击“添加为出口”，选择监听服务与用户并命名。支持 SS2022 及 AES-GCM / ChaCha20-Poly1305 AEAD，自动读取加密保存的认证配置；多用户 SS2022 保留服务端密钥与用户密钥。添加后可在其他入口节点的“默认出口”和每条分流规则中选择。出口节点需先配置公网 IP，并更新 Agent 与部署器以支持已有出口的 UFW 同步。

已有出口的监听或认证配置变化、服务停止或扫描中消失时，会标为不可用。先调整引用它的入口，再重新添加；被入口引用的出口不能移除。修改出口节点公网 IP 会重新应用关联入口配置。

### REALITY 与证书

- REALITY 固定 Xray / TCP 443，默认目标为 `127.0.0.1:8003`，使用 PROXY v2；本地 Caddy 先解析 PROXY，再处理 TLS，按域名反代指定 HTTPS 源站。
- Cloudflare 仅维护 DNS-only A/AAAA。Caddy 使用 Let's Encrypt **HTTP-01** 自动签发、续期，禁用 TLS-ALPN-01；需域名正确解析且公网 TCP 80 可达。不会将 Cloudflare Token 下发到节点。
- Caddy 仅在回环地址开放本地 TLS 端口；模板使用 HTTP/1.1、HTTP/2，移除上游 Alt-Svc。AnyTLS 读取由部署器同步的 Caddy 证书，证书变化后重启对应服务。
- 当前固定内核：Xray `26.11.9`、sing-box `1.14.4`、Caddy `2.11.9`；构建时校验 SHA256 并镜像到 Master，节点从 Master 下载。
- 构建下载遇到临时网络错误会重试；CI 可回退到现有 Master 的发布镜像，仍须匹配仓库固定的 SHA256。可通过 `BLINK_PROXY_ASSET_MIRROR` 指定 HTTPS 镜像目录。
- REALITY 客户端已验证 **Xray 26.11.9 + chrome 指纹**。该版服务端要求带 X25519MLKEM768 的较新握手；sing-box 1.14.4 的 REALITY 客户端握手未通过，不能把所有旧客户端视为兼容。AnyTLS 使用 sing-box 客户端验证。

### 节点权限与升级

新安装包自动配置 `blink-proxy-manager.service`。部署器以 root 运行，仅通过受限 Unix socket 接受类型化配置任务；代理内核以独立 `blink-proxy` 用户运行，监控 Agent 可继续使用普通用户。

存量节点先更新 Agent，再从同版本、已核对 SHA256 的发布包解压 `enable-proxy.sh`、`service-platform.sh`、`proxy-manager.py`、`proxy-assets.json`、`blink-proxy-manager.service` 和 `blink-proxy-manager.openrc`，以 root 运行 `bash enable-proxy.sh`。无需重新注册。Agent 自动更新器只更新 Agent 二进制，部署器后续升级仍需重新执行该脚本。

存量 Master 升级时同步更新 `deploy/compose.yml`，让 Web 服务接入 `egress` 网络，以访问 Cloudflare API 和解析伪装上游域名。

默认仅管理已启用的 UFW；选择安装启用时会保留配置及实际监听的 SSH 端口。SS2022 仅为已关联入口的公网地址添加规则。已有管理员规则不接管；云安全组需同步配置。外部防火墙模式由管理员维护访问规则。

已有服务出口也会按同一防火墙策略同步来源规则：默认出口、分流引用及入口公网 IPv4/IPv6 变化时，先为出口监听端口放行新来源，再应用入口，成功后清理过期的面板规则。停用、删除或切换出口会清理对应来源；共享出口保留其他入口的规则。同步使用独立版本和可回滚任务，原服务配置及进程保持原有管理方式。任务列表显示“同步出口 UFW”；仅有已有出口的节点也可点击“重新应用配置”重新同步。

面板展示 UFW 实际状态（已启用、未启用、未安装、读取失败）和 `ufw status verbose` 规则详情，每分钟更新并标明采集时间；该状态与所选择的防火墙策略分别展示。

### 扫描、部署与恢复

首次接入自动扫描 Xray、sing-box、Caddy、Nginx 的运行参数、常见配置目录、多文件 JSON/JSONC 及普通 Web include；本地目标按端口关联 Web 候选。扫描快照加密保存，查看时隐藏结构化密钥。外部服务以只读方式导入；不自动接管。容器命名空间、自定义启动器、动态配置和复杂变量/include 需要人工核对，合并视图不替代内核实际配置。

Mihomo / Clash Meta 也可扫描：读取运行进程的 `-f`、`-d`、`CLASH_CONFIG_FILE`、`CLASH_HOME_DIR` 与常见 YAML/YML 配置路径，支持 YAML 锚点及合并。面板展示监听项、代理数量、策略组数量和规则数量。配置中的 `listeners` 若为兼容的 Shadowsocks 服务，可添加为已有出口；`proxies` 中的远端节点不作为本机监听服务导入。内联配置、标准输入或加密配置会提示人工核对；扫描不会调用外部控制 API 或更新原服务。

Alpine 的管理服务由 OpenRC 监督，代理内核仍以 `blink-proxy` 用户运行，仅授予绑定低端口的能力；配置应用、故障回滚和已有出口 UFW 同步沿用同一任务协议。
Alpine 自动选择官方静态 musl 版 sing-box，和其他内核一样从 Master 下载并校验固定 SHA256。

AnyTLS 的公网端口同时支持代理和普通 HTTPS 网页访问，新增实例默认使用 443。HAProxy 负责 TLS 与认证前缀分流：有效 AnyTLS 流量交给仅监听回环地址的 sing-box，普通浏览器请求交给 Caddy，支持 HTTP/1.1 和 HTTP/2。面板的「伪装网站上游」可留空显示默认欢迎页，也可填写 HTTPS 源站以反向代理网站；「本机 AnyTLS 内部端口」仅用于节点内部通信，需要避免与其他实例重复。

首次部署 AnyTLS 时自动安装发行版的 HAProxy，独立服务名为 `blink-proxy-tls`，和代理内核一样以 `blink-proxy` 用户运行。证书由 Caddy 续期，部署器同步后重启 TLS 前端加载新证书；配置失败会回滚网站、TLS 前端与代理服务。已存在的 AnyTLS 实例更新部署器后重新应用即可启用网页回落，原有密码和出口规则继续使用。

部署执行内核配置校验，写入独立配置代次，启用服务后检查状态。失败恢复原配置、服务与所管理的防火墙规则；断线按同一任务 ID 重投，节点持久化结果避免重复执行。依赖出口先应用，入口随后启动；跨节点不是分布式原子事务，任务失败后使用“重新应用配置”协调重试。运行状态和证书信息约每分钟回报。

状态目录：`/var/lib/blink-proxy/`；当前配置：`current/`；私有事务与任务记录：`manager/`。本地手工修改已管理配置会触发漂移检查，应先核对变更。卸载停止并移除托管服务，保留配置代次、证书和 DNS 记录便于恢复。

验证命令：`bash deploy/test-proxy.sh`（隔离容器真实内核）、`cd web && npm run test:proxy`（PostgreSQL/API）。公开 Cloudflare DNS 与 Let's Encrypt 签发仍需在实际域名、节点上验收。

## 安全设计

完整边界见 [SECURITY.md](SECURITY.md)。主要默认值：

- HTTPS/WSS + 受信任公共 CA 校验，不提供跳过证书验证选项；明文连接仅限显式配置的 localhost 开发。
- scrypt 64 MiB 密码派生、强制 TOTP、验证码原子重放保护；密码不可通过 HTTP 重设。
- 随机会话，数据库仅保存摘要；生产 `__Host-` / Secure / HttpOnly / SameSite=Strict Cookie。
- 所有服务器 API、实时流与终端入口均验证 owner，预留成员角色不具有服务器权限。
- 变更请求精确 Origin 校验，nonce CSP、禁止嵌入、no-store、无跨域开放。
- 终端有 30 秒单次会话绑定 ticket，Agent 有独立单次 stream token，令牌不放 URL。
- 注册令牌单次使用，节点凭证可轮换 / 吊销；存量连接每 10 秒重新校验权限。
- 探测和 Webhook 校验所有 DNS 结果，拒绝私有 / 特殊地址、禁用重定向、固定目标 IP，避免 DNS rebinding / SSRF。
- JSON、WebSocket、终端、日志和离线缓存均有大小限制；登录限流、任务并发限制、输出背压。
- 通知凭证使用 AES-256-GCM；Webhook 使用时间戳 + HMAC-SHA256 签名。
- 审计只记录事件与会话元信息，不默认录制终端输入、输出或完整进程参数。

## 数据与运行说明

原始 5 秒数据按 UTC 日分区，保留至少 24 小时、最多约 48 小时；分钟聚合 30 天、小时聚合 365 天。
聚合保存平均、最小、最大及样本数，迟到样本标记对应分钟重新聚合。网络检查记录 7 天，审计 180 天。
流量按网络计数器差值累计，重放样本不会重复计费；累计值不是服务商账单。
默认账期为 UTC 每月 1 日，允许 1–28 日。默认排除常见虚拟网卡，建议显式选择计费网卡。

Agent 每 5 秒采样，默认最多缓存 720 个样本（约 1 小时），每 30 秒落盘。
离线超过缓存窗口会丢弃最旧样本；突然掉电最多损失尚未落盘的约 30 秒样本。
Agent 不运行期间无法采样，重启时速率基线重建，避免计数器重置产生巨额负流量。
服务端接受最近 24 小时内的样本，Agent / Master 应开启 NTP。

网关与 worker 首版作为**单实例**部署；数据库是持久化事实来源。
指标、探测结果、告警和投递记录可由面板观察；服务日志使用
`docker compose --env-file .env -f deploy/compose.yml logs --tail=100 gateway web`。
Master 自身整体不可达需要外部监控，内部离线规则无法在 Master 停机时发送通知。

备份至少包括 PostgreSQL 数据、`.secrets/encryption_key`、`.env` 及身份验证器恢复材料。
加密密钥丢失会导致通知凭证与 TOTP 无法解密。使用 `pg_dump` 做加密离线备份并定期验证恢复。
生产凭证不放构建参数、镜像层或 Git。升级前先备份，运行 migrate 后再重建服务。

## 开发与验证

要求 Node.js 24、Rust 1.92+、Docker（集成测试使用独立的临时 PostgreSQL 容器）。

```bash
cd web
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:integration
npm run test:load
bash ../deploy/build-agent.sh
npm run test:docker
```

```bash
cd agent
cargo fmt --check
cargo test --locked
cargo clippy --all-targets -- -D warnings
```

集成测试自动生成隔离测试凭证，验证真实 Rust Agent、PTY、权限、补传、浏览器保存流程与双端截图。
测试完成自动停止自己启动的服务和临时数据库；结果写入忽略版本控制的 `.local/`。
300 节点测试模拟每 5 秒上报，检查 ACK 延迟、持久化样本数和流量一致性。
Docker 验证会构建真实镜像，使用临时 CA 和回环 HTTPS 端口，检查安全 Cookie、WSS 路由、
数据库最小权限、非 root Linux Agent、PTY 和子进程清理；结束后删除测试项目自身的容器与卷。
本地测试的 HTTP / localhost 模式只用于开发，不应用于公网。

可在本地或 GitLab runner 上构建和验证；仓库不包含 GitHub Actions 工作流。

## 构建和发布

主仓库：`git@git.magipop.xyz:blink/blink-node.git`。
GitHub 镜像：`git@github.com:k1ngcyk/blink-node.git`。

### GitLab Runner 自动构建

`.gitlab-ci.yml` 的构建阶段使用 **`build`** 标签（当前对应 runner #12），
复用 runner 已有的 Docker 和镜像仓库登录。部署阶段使用 Master 上的项目专用 **`blink-master-deploy`** Runner。
推送 `main` 后自动执行：

- 构建 AMD64 / ARM64 的 musl Agent 安装包；
- 构建两种架构的统一运行镜像，推送 `:0.1.0`、`:latest` 及完整 Git commit SHA 标签；
- Master Runner 拉取该次提交的 SHA 标签，解析并固定镜像 digest，执行迁移，更新 Web / 网关并等待健康检查。
- 验证 Agent 更新清单可用；部署失败时恢复旧镜像及 `.env`，节点随后通过定时任务获取成功发布的 Agent。

类型检查、lint、单元测试、安装矩阵、代理集成和 Docker 冒烟测试在本地开发时执行，生产 CI 不重复运行。发布日志分别记录 Agent 打包与 Web 镜像构建/推送的耗时。

构建 runner 需要 Docker、Buildx、Python 3 和访问镜像仓库的权限，不需要预装 Node 或 Rust。
构建使用该项目独立且持久的 BuildKit builder；缺少 ARM64 支持时会注册 QEMU binfmt。
Rust 编译器始终原生运行，通过 Zig 交叉编译生成两种架构的 musl 二进制，避免在 QEMU 中编译 Rust；
Web 的依赖安装和 Next.js 编译固定在构建机原生架构执行；编译产物由两种运行镜像共享，生产依赖按目标 CPU 选择 sharp / SWC / esbuild 的预编译包，避免混入构建机架构的原生模块。QEMU 仅用于异构运行镜像安装 Debian 系统包（CA 证书、ping），不参与 Rust / Node / Next.js 编译。Cargo 编译产物按架构缓存，新提交会取消过时的构建。
构建和生产部署各自通过 `resource_group` 串行执行；部署前验证提交仍是 `main` 最新提交，跳过过时流水线。
生产部署不可被新提交自动取消，防止服务切换途中中断。镜像回滚不撤销已成功的数据库迁移，迁移须保持前向兼容。
GitLab 产物只保存安装包与镜像发布元数据。

#### Master 部署 Runner

Master 安装官方 GitLab Runner 软件包，注册为 `blink/blink-node` 的项目专用 shell Runner：
标签 `blink-master-deploy`、关闭无标签任务、锁定当前项目、并发数 1。构建仍由原有 `build` Runner 执行。
注册令牌保存在 root 私有的 `/etc/gitlab-runner/config.toml`，不进入仓库。

将 `deploy/setup-master-runner.sh` 和 `deploy/master-deploy.py` 放到 Master 同一目录，以 root 运行安装脚本。
它安装 `/usr/local/sbin/blink-node-deploy` 和专用 sudo 规则；Runner 用户只传入完整提交 SHA，
由 root 部署器管理 `/opt/blink-node/.env` 和 Compose，无需把生产秘密目录开放给 Runner。
部署器固定拉取 `registry.windgyre.com/library/blink-node-web` 的公开镜像。

旧 `.env` 和部署记录存放于 `/opt/blink-node/.deploy/`（0700）；中断的部署在下一次执行时先恢复旧版本。
部署器及 Compose 配置变更需在 Master 更新安装；普通应用版本由流水线自动发布。

### 本机手动构建

本机用 Docker Buildx 构建双架构静态 Agent，产物会放入 `web/public/downloads/agent/v<version>/`：

```bash
bash deploy/build-agent.sh
```

`bash deploy/test-installer.sh` 会在隔离双架构 Linux 容器中验证安装、校验失败拒绝、注册失败回滚、
权限、重复安装保护、临时凭证清理、自动更新安装 / 禁用及旧节点启用；其中 systemctl 为测试替身，不修改宿主机服务。
同时运行更新器回归，覆盖真实 HTTP 下载、包 / 二进制校验、同版本更新、失败回滚、崩溃恢复和连接健康判定。
更新器测试也可单独执行 `python3 deploy/agent/test-updater.py`。

随后可通过源码覆盖配置在本机构建统一运行镜像：

```bash
docker compose --env-file .env -f deploy/compose.yml -f deploy/compose.build.yml --profile setup build
```

本机登录镜像仓库后，运行以下脚本可重新构建 Agent，并构建 / 推送 ARM64、AMD64 面板镜像：

```bash
bash deploy/publish.sh
```

该脚本推送 `registry.windgyre.com/library/blink-node-web:<version>` 和 `:latest`；
静态安装资源已包含在镜像里，Web / 网关仍由 Compose 作为独立进程运行。
构建脚本支持从环境传入 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，使用 Docker 的预定义代理参数，
不会将构建代理写入运行镜像。代理地址需要能从 Docker 构建容器访问。
若宿主机和容器的代理地址不同，可单独设置 `BLINK_BUILD_PROXY`，仅覆盖构建容器的 HTTP / HTTPS 代理。
发布前统一更新 `web/package.json`、`agent/Cargo.toml` 与锁文件中的版本号，以及 Compose 默认镜像标签。

Agent 构建、镜像发布和服务器安装均不依赖 GitHub Actions。
GitLab runner 自动运行构建发布，也可在本机执行相同脚本。GitHub 仅作为代码镜像。
发布产物与本机测试秘密均被 Git 忽略，服务器只需访问你的 Master 下载地址。
