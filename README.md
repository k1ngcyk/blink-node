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

后续代理服务实例与资源授权已预留边界；AnyTLS、Shadowsocks 2022、VLESS + REALITY 的安装管理属于后续版本。

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
2. 按需勾选 **启用网页终端**（仅普通 `blink-agent` 用户，默认关闭）。
3. 点击 **复制一键安装命令**，在目标服务器的 root Shell 中粘贴运行（普通用户先执行 `sudo -i`）。
4. 等待几秒，面板将显示在线和监控数据。

安装器自动识别 x86_64 / ARM64，从你的 Master 的 `/downloads/agent/v0.1.0/` 下载静态 musl 二进制，
核对 SHA256、创建低权限用户、写入配置、消费单次凭证并启动 systemd。需要 `curl`、CA 证书和正在运行的 systemd；
例如 Debian / Ubuntu 可先安装 `curl ca-certificates`。安装不依赖目标服务器访问 GitHub，也无需 Rust 编译环境。

接入凭证有效 15 分钟；它通过 stdin 和临时 0600 文件传递，不进入 curl URL 或安装器的 argv。
复制的命令本身包含凭证，可能被 Shell 历史记录，请勿转发；成功或失败退出都会清理临时文件。
脚本和二进制下载是公开静态资源，注册及管理仍需认证，不会在下载端点暴露凭证。

安装器拒绝覆盖已有配置或身份。注册失败会撤销本次写入的文件，可生成新命令重试；
注册后服务启动失败则保留身份，使用 `journalctl -u blink-agent` 排查后 `systemctl restart blink-agent`。

### 手动安装

主流 systemd Linux，内核指标来自宿主机。Agent 推荐作为原生服务运行。
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
修改配置后 `sudo systemctl restart blink-agent`。
升级使用相同用户 / 状态目录，替换二进制后重启；不会自动拉取并执行远端更新。

重新接入已有机器时，在面板生成新的接入凭证，将其写入 root 的 0600 文件，
先停止服务，然后按上方 `blink-agent enroll --token-file` 步骤注册、恢复身份文件归属，再启动服务。
不要删除原有身份文件；凭证轮换由面板控制。

### 网页终端权限

默认关闭，必须在 Agent 的本地配置中显式开启：

```toml
terminal_enabled = true
terminal_user = "blink-agent"
allow_root_terminal = false
```

普通用户服务只能打开自身身份的 Shell。默认 systemd 沙箱允许其在状态目录操作，系统目录只读。
如果确实需要 root 终端，可参考 `deploy/agent/root-terminal.conf.example` 创建 systemd override，
并同时配置 `terminal_user = "root"`、`allow_root_terminal = true`。随后执行 daemon-reload 和 restart。
此模式赋予 Master 所有者该机器的 root 运维能力。生产优先使用专用低权限运维用户。

系统日志可见范围由服务用户权限决定。需要系统 journal 时，可以把 `blink-agent` 加入 `systemd-journal` 组并重启服务。
ICMP 依赖系统 `ping` 命令与允许的 ping socket 权限；必要时为服务用户所在 GID 配置 `net.ipv4.ping_group_range`。
容器 / 精简发行版没有 systemd 或 journal 时，相应诊断显示不可用。

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

`.gitlab-ci.yml` 使用与 eduhub-web 相同的 **`build`** 标签（当前对应 runner #12），
复用 runner 已有的 Docker 和镜像仓库登录。推送 `main` 后自动执行：

- Web 类型检查、lint、安全单测；
- 构建两种架构的 musl Agent，测试安装、权限和失败回滚；
- 构建统一运行镜像并验证真实 Compose、HTTPS/WSS、静态下载和 Linux PTY；
- 全部成功后推送 `:0.1.0`、`:latest` 及完整 Git commit SHA 标签。

runner 需要 Docker、Buildx、Compose 和访问镜像仓库的权限，不需要预装 Node 或 Rust。
构建使用该项目独立且持久的 BuildKit builder；缺少 ARM64 支持时会注册 QEMU binfmt。
`resource_group` 串行发布，避免同一项目并发更新标签。流水线不部署 Master。
GitLab 产物只保存安装包与验证结果，不上传测试秘密或容器日志。

### 本机手动构建

本机用 Docker Buildx 构建双架构静态 Agent，产物会放入 `web/public/downloads/agent/v<version>/`：

```bash
bash deploy/build-agent.sh
```

`bash deploy/test-installer.sh` 会在隔离双架构 Linux 容器中验证安装、校验失败拒绝、注册失败回滚、
权限、重复安装保护及临时凭证清理；其中 systemctl 为测试替身，不修改宿主机服务。

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
