# dsh-ssh-bridge

## Tailscale

`transport: tailscale` 为当前 DSH Web 提供固定的 `127.0.0.1:9301` 反代入口，Tailscale Serve 将该入口发布到同一 tailnet。DSH 自身的监听端口变化时，无须重新配置 Serve。HTTP、流式响应和 WebSocket 通过代理传递，应用登录仍由 DSH 处理。

```yaml
- insert:
    - id: ssh-bridge
      name: dsh-ssh-bridge
      config:
        enabled: true
        transport: tailscale
        tailscale:
          publicUrl: https://computer.example.ts.net
          localPort: 9301
        pairing:
          localHost: 127.0.0.1
          localPort: 9300
- id: connection
  config:
    trustedHosts: !!js "[...(ctx.webStartup?.trustedHosts ?? []), 'computer.example.ts.net']"
```

1. 电脑和手机安装并登录同一 Tailscale 网络，使用本机完整的 `*.ts.net` 域名替换示例域名。
2. 在现有 DSH profile 中加载插件和上述配置。开发时也可把 `name` 写为本地 `lib/index.mjs` 的绝对路径，并先在包目录执行 `npm ci`。
3. 执行 `tailscale serve --bg --https=443 http://127.0.0.1:9301`，按提示启用 HTTPS。先用 `tailscale serve status` 检查现有配置，避免覆盖其他服务；需要共存时使用其他 HTTPS 端口，并同步 `publicUrl` 和 `trustedHosts` 的端口。
4. 在电脑打开 `http://127.0.0.1:9300/`。手机连接 Tailscale，扫描二维码，或将配对链接发送到自己的设备后打开。
5. 登录后收藏 HTTPS 地址。DSH 重启后若登录失效，回到本机配对页重新配对。

Tailscale 模式默认关闭文件浏览与下载接口；只有显式设置 `files.enabled: true` 后才会注册，开启时应同时设置所需的 `files.root`。

本模式不需要 `relay.token` / `relay.accessToken`、SSH 客户端、额外 VPS 或公网监听。配对链接是登录凭据，请只交给自己的设备。`9300` 管理页保持本机可见；Serve 指向 `9301`，不要指向 `9300`。

连接页的“入口已就绪”表示本机反代已启动且 DSH 监听可用，不代表已验证手机、tailnet 权限或 Serve 配置。不能连接时先检查 `tailscale status`、`tailscale serve status` 与手机的 Tailscale 状态。

关闭本入口的 Serve 配置：`tailscale serve --https=443 off`；只在该端口确实用于本插件时执行。插件停用只关闭本机反代，不改动系统 Tailscale 配置。

Tailscale 会自行选择点对点或 DERP 等连接方式。本模式省去 dsh relay，不保证零转发或完全脱离 Tailscale 控制面。参考 [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)。

## 其他连接方式

以下 SSH / relay 模式通过另一台服务器连接，不需要在 DSH 主机上开放公网入站端口：

| | **relay**（推荐给手机用） | **ssh** |
|---|---|---|
| 手机端 | **只要浏览器**，不用装 App、不用 SSH 客户端 | 任意 SSH 客户端 + 本地转发 |
| 公网端口 | 一个 HTTPS 端口（如 8443） | SSH 的 22 |
| 服务器上要装 | 本包的 `dsh-relay` 进程 | 什么都不用装（用现成的 sshd） |
| 手机看到的地址 | `https://relay.example.com:8443/` | `http://127.0.0.1:9100/` |
| DSH 需要放行 | `trustedHosts` 加一条 | 不需要（回环地址天然放行） |
| 加密 | TLS，可用证书指纹固定 | SSH 全程 |

两者都是**出站**连接：DSH 机器主动连出去，所以它在 CGNAT、公司内网、家用宽带后面都一样能用。

---

## 模式一：relay（手机只需要浏览器）

```
   ┌──────────────┐
   │  DSH 机器     │
   │ 127.0.0.1:   │  ① 出站 TLS，保持若干条空闲连接
   │    <dshPort> │ ─────────────────────────┐
   └──────────────┘                          │
                                  ┌──────────▼──────────┐
                                  │  你的服务器 :8443    │
                                  │  TLS + 访问密钥 + 池  │
                                  └──────────▲──────────┘
                                             │ ② HTTPS
                                  ┌──────────┴──────────┐
                                  │ 手机浏览器            │
                                  └─────────────────────┘
```

中继自己不解析 HTTP 正文、WebSocket 帧或 DSH 的协议：它只检查**第一段请求头**用于认证和路由，然后把两个 socket 直接对接，所以 keep-alive、分块传输、WebSocket 升级都原样通过。

### 1. 在服务器上跑中继

需要 Node 22+。以 Alibaba Cloud Linux 3 为例：

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs

# 把本包传到服务器（在你本机执行）
scp -r dsh-ssh-bridge root@relay.example.com:/opt/

# 服务器上
cd /opt/dsh-ssh-bridge
npm install --omit=dev
node bin/dsh-relay.mjs --port 8443 --host relay.example.com
```

第一次运行会生成自签证书 `/opt/dsh-ssh-bridge/relay-cert.pem`，并打印：

```
[relay] listening on https://0.0.0.0:8443
[relay] SHA-256 fingerprint: 3F:2A:...:9C
[relay] host token    : <A>
[relay] access token  : <B>
[relay] plugin configuration to paste into the DSH profile:
  transport: relay
  relay:
    host: relay.example.com
    ...
```

**把输出里的 `host token` / `access token` / 指纹记下来**，它们是 `restart` 之后也不变的（除非你删掉证书重新生成，指纹会变——那时插件会拒绝连接，这正是要的行为）。

用 systemd 常驻：

```ini
# /etc/systemd/system/dsh-relay.service
[Unit]
Description=DSH relay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/dsh-ssh-bridge
ExecStart=/usr/bin/node bin/dsh-relay.mjs --port 8443 --host relay.example.com
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now dsh-relay
```

**放通端口**（安全组 + 本机防火墙）：

```bash
# 阿里云安全组（在本地执行）
aliyun ecs AuthorizeSecurityGroup \
  --RegionId cn-heyuan --SecurityGroupId sg-f8z7tfkslp72ar6r6913 \
  --IpProtocol tcp --PortRange 8443/8443 --SourceCidrIp 0.0.0.0/0
```

> 想用真证书、避开浏览器的自签警告？把这个域名解析到服务器，用 `--cert`/`--key` 指向你的 PEM，并把 `--host` 设成该域名。中继不负责签发和续期。

### 2. 配置 DSH 侧

`~/.dsh/profiles/desktop/cordis.patch.yml` 里加两段：

```yaml
- insert:
    - id: ssh-bridge
      name: dsh-ssh-bridge
      config:
        transport: relay
        relay:
          host: relay.example.com
          port: 8443
          token: '<host token>'
          accessToken: '<access token>'
          fingerprint: '<SHA-256 指纹>'

# 手机用的不再是回环地址，必须显式放行这个 authority
- id: connection
  config:
    trustedHosts: !!js "[...(ctx.webStartup?.trustedHosts ?? []), 'relay.example.com:8443']"
```

> 第二条**不能省**。不放行的话页面壳子能打开，但每一条 API / WebSocket 都会被 `403` 挡掉，看起来像"白屏"。
> `!!js` 的值一定要写成**带引号的字符串**，否则 YAML 会把它当流式序列解析而报错。

重启 DSH。

### 3. 手机

打开 `http://127.0.0.1:<dshPort>/ssh-bridge`，页面上有一条 `https://relay.example.com:8443/?rk=...&token=...` 的链接和二维码。

扫一下（或点开）即可：

1. 中继用掉 `rk`，写 Cookie，`303` 到去掉 `rk` 的地址；
2. DSH 用掉 `token`，写自己的登录 Cookie，`303` 到 `./`；
3. 到这就进 DSH 了。

之后直接开 `https://relay.example.com:8443/` 就行，两个 Cookie 都在。建议"添加到主屏幕"。

---

## 模式二：ssh（复用现成的 sshd）

```
DSH 机器 ──出站 SSH──▶ 你的服务器 :22 ──手机 -L──▶ 手机浏览器
                        （remote forward 到 127.0.0.1:9100）
```

### 服务器

用现成的 sshd 即可，无需安装任何东西。建议给 DSH 一个专用账号：

```sshconfig
# /etc/ssh/sshd_config
Match User dsh
    AllowTcpForwarding remote
    PermitTTY no
    AllowAgentForwarding no
```

### DSH 侧

```yaml
- insert:
    - id: ssh-bridge
      name: dsh-ssh-bridge
      config:
        transport: ssh
        ssh:
          host: relay.example.com
          username: dsh
          authMethod: privateKey
          privateKeyPath: ~/.ssh/id_ed25519
        forward:
          bindAddress: 127.0.0.1
          port: 9100
```

### 手机

在 SSH 客户端里加一条 **Local** 转发，然后用带 token 的链接打开一次：

```bash
ssh -N -L 9100:127.0.0.1:9100 dsh@relay.example.com
```

之后开 `http://127.0.0.1:9100/`。这个地址是手机自己的回环，DSH 的信任边界天然放行，不需要 `trustedHosts`。

> 端口号必须和 `pairing.phonePort` 一致——DSH 的 Cookie 是绑定 authority 的。

---

## 配置

```yaml
transport: tailscale | relay | ssh  # 默认 ssh
enabled: true
```

**通用**

| 字段 | 默认 | 说明 |
|---|---|---|
| `transport` | `ssh` | `tailscale` / `relay` / `ssh` |
| `enabled` | `true` | 关掉后插件照常装载但不连接 |
| `pairing.qr` | `true` | 装了可选依赖 `qrcode` 才显示二维码 |
| `pairing.localPort` | `9300` | 固定的本地配对页端口，`0` 关闭。见下 |
| `pairing.localHost` | `127.0.0.1` | 配对页绑定地址，别改 |
| `statusPage` | `true` | 注册 `/ssh-bridge` 与 `/ssh-bridge/status` |

### 配对页（建议收藏）

DSH 的 Web 端口每次启动都可能变，而 Desktop 界面是 Electron 用 `file://` 渲染的、不持有浏览器
Cookie——所以 `/ssh-bridge` 在浏览器里通常打不开（`403`）。插件因此在**固定端口**上另起一个只监听
回环的配对页：

```
http://127.0.0.1:9300/?rk=<accessToken>     # 第一次带上密钥，之后它会记住
http://127.0.0.1:9300/                       # 之后直接开，可加入书签
```

这页每次都渲染**当前**的二维码和配对链接，所以 DSH 重启、token 轮换之后它自动是新的——不需要再去
找端口或重新配。它只展示配对信息，且用中继的访问密钥把关（`pairing.localPort: 0` 可以关掉）。

**relay**

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `''` | 中继地址；留空则用 `ssh.host` |
| `port` | `8443` | 中继端口 |
| `protocol` | `https` | `http` 用明文连接中继。访问密钥和 DSH 启动令牌会明文过网，只在可信链路里选 |
| `publicHost` / `publicPort` | 空 / 同 `port` | 手机实际访问的地址，NAT 后面才需要 |
| `token` | — | 中继校验 DSH 用的共享密钥 |
| `accessToken` | — | 手机首次访问要出示的访问密钥（会写进配对链接） |
| `hostId` | `default` | 多机共用一个端口时，每台 DSH 用不同的 `hostId` + `token` + `accessToken` |
| `fingerprint` | — | **强烈建议填**：固定自签证书的 SHA-256 指纹 |
| `insecure` | `false` | 跳过证书校验，仅用于第一次试验 |
| `poolSize` | `32` | 常驻的空闲连接数，手机连上不用等 |
| `refreshMs` | `300` | 补池周期 |
| `idleTtlMs` | `40000` | 空闲连接回收时间，避免被 NAT 掐死 |
| `timeoutMs` | `15000` | 单次握手超时 |

> **`poolSize` 必须大于浏览器对同一 host 的并发连接数。** 浏览器加载一个页面会同时开 6~12 条连接
> （脚本、样式、WebSocket），池子小了就会用光。中继现在的行为是：**没空闲连接就排队等最多 6 秒**
> （`waitMs`），等补池，而不是立刻回 `503`——这正是之前白屏的成因。中继侧的 `--pool` 上限也要跟着放大
> （默认 16，建议 64）。

### 一个端口接多台 DSH

中继按**访问密钥**选主机：浏览器在配对时用 `?rk=<accessToken>`，之后用 `dsh_relay` Cookie，
两者都是路由键，所以不需要改路径、不需要重写 HTML。

服务器端把主机表写成 JSON：

```json
[
  { "hostId": "alpha", "hostToken": "…", "accessToken": "…" },
  { "hostId": "beta",  "hostToken": "…", "accessToken": "…" }
]
```

```bash
node bin/dsh-relay.mjs --port 8443 --host <公网地址> --hosts-file ./hosts.json --pool 64
```

每台 DSH 的插件配置用**自己的**三项，`hostId` 必须和表里一致：

```yaml
relay:
  host: <公网地址>
  port: 8443
  hostId: beta              # 与 hosts.json 对应
  token: '<beta 的 hostToken>'
  accessToken: '<beta 的 accessToken>'
```

`/__relay/health` 会列出每台的 `idle` / `open` / `served`，用它确认哪台掉线了。
访问密钥重复会被中继在启动时直接拒绝。

**ssh**

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` / `username` | — / `22` / `dsh` | SSH 服务器 |
| `authMethod` | `auto` | `agent` → `~/.ssh` 里的私钥 → 密码 |
| `privateKeyPath` / `privateKeyPassphrase` / `password` / `agentPath` | — | 凭据 |
| `knownHostsPath` | `~/.ssh/known_hosts` | 主机密钥校验 |
| `hostKeyPolicy` | `accept-new` | `strict` / `accept-new` / `insecure` |
| `readyTimeoutMs` / `keepaliveIntervalMs` | `20000` / `15000` | 握手超时 / 保活 |
| `forward.bindAddress` / `forward.port` | `127.0.0.1` / `9100` | 在服务器上发布的位置 |
| `reconnect.*` | `true` / `1000` / `30000` / `2` | 指数退避重连 |
| `pairing.phonePort` | 同 `forward.port` | 手机本地转发端口 |

---

## 安全模型

**relay 模式有三道锁：**

1. **TLS + 证书指纹固定**：插件默认会校验证书；自签场景请填 `fingerprint`（中继启动时打印）。指纹不匹配时插件直接拒绝——中间人插不进来。
2. **host token**：只有出示正确 token 的连接才能进空闲池，陌生人无法让中继代他连 DSH。
3. **access key**：浏览器先过中继自己的门（Cookie），再过 DSH 自己的门（launch token → Cookie）。没配对的浏览器只能看到一个登录框，碰不到 DSH 的任何东西。

再加上 DSH 的 `trustedHosts` 只放行你写的那个 authority——别人拿 IP 直连也不行。

**仍然要注意：**

- 8443 对公网开放。中继本身代码量小、只做透传，但它是唯一暴露面；请保持更新。
- 你写在配对链接里的 `accessToken` 等同于"这台 DSH 的手机钥匙"，别贴到公开地方。丢了就改配置重启中继。
- `trustedHosts` 是**按 authority 字符串**匹配的，别图省事写通配。
- 能登服务器的人能看到中继的 token 和证书私钥，所以要像对待 root 一样对待那台机器。
- 自签证书意味着首次访问会有警告（浏览器只认域名/IP 的 CA 签发）。要彻底消除就用域名 + 真证书。

**ssh 模式**的安全边界更简单：你能 SSH 进那台服务器，就能碰到这台 DSH。用 `AllowTcpForwarding remote` + `PermitTTY no` 限制那个账号即可。

---

## 状态与排障

| 入口 | 用途 |
|---|---|
| `GET /ssh-bridge` | 移动端友好的状态页：配对链接、二维码、连接细节 |
| `GET /ssh-bridge/status` | 同样信息的 JSON |
| `POST /ssh-bridge/reconnect` | 强制重连（仅同源 POST） |

两个读接口接受两种凭据：一个已认证的 DSH 浏览器会话，或中继的访问密钥 `?rk=<accessToken>`。
后者是必要的——Desktop 的界面由 Electron 用 `file://` 渲染，从不持有浏览器 Cookie，
所以在应用里根本拿不到会话；而访问密钥本来就在配对链接里，这个页面也只展示那条链接。

```
http://127.0.0.1:<dshPort>/ssh-bridge?rk=<accessToken>
```

relay 模式下中继自己还有一个 `GET /__relay/health`（无需认证，只返回池状态），适合做拨测。

| 现象 / 日志 | 处理 |
|---|---|
| 手机白屏、控制台一堆 `403` | 忘了加 `trustedHosts`，见上文 |
| **手机白屏、且没有任何报错** | **不只是** `403` 的话先查连接池：中继 `refused` 计数在涨、或 `/__relay/health` 的 `idle` 长期为 0，说明 `poolSize` 太小，浏览器并发拿资源时被打回 `503`，脚本没加载、`#root` 为空。把 `poolSize` 提到 32 以上、`--pool` 提到 64 |
| 页面显示 "No free relay connection" | 同上：池空了且 6 秒内没补上。看 `refreshMs` 和到中继的网络延迟 |
| `relay rejected this host: unauthorized` | `relay.token` 和中继的 host token 不一致 |
| `fingerprint mismatch` | 中继证书变了。确认没被劫持后更新 `relay.fingerprint` |
| `DEPTH_ZERO_SELF_SIGNED_CERT` | 自签但没填 `fingerprint`，也没开 `insecure` |
| 浏览器一直停在登录框 | `accessToken` 输错，或配对链接里的 `rk` 已失效 |
| 白屏但 `curl` 拿到的首页正常 | 用 `tools/probe-browser.mjs <配对链接>` 跑一遍真实 Chromium，看 `#root` 子节点数和 `failed requests` |
| `no known_hosts entry`（ssh 模式） | `strict` 模式下先加 key，或改 `accept-new` |
| `host key ... does not match` | 服务器密钥变了。**先确认不是中间人**再删 `known_hosts` 那行 |
| `remote forward ... was refused`（ssh 模式） | sshd 不允许转发，或端口被占 |

本地不连 DSH 也能自检传输：`node scripts/probe.mjs`（ssh 模式）、`npm test`（两种模式都有端到端用例）。

---

## 与 dsh-mobile 的区别

[dsh-mobile](https://github.com/saya-ch/dsh-mobile) 做的是「手机端的 DSH」：专属触屏布局、Android 原生 App、二维码配对，远程通道走 Tailscale Funnel / cpolar / cloudflared / 自建 FRP。

本项目提供远程入口、配对与连接管理；会话界面继续使用 DSH 自带 UI：

| | dsh-ssh-bridge | dsh-mobile |
|---|---|---|
| 远程通道 | Tailscale Serve、自建 SSH 或本仓库的 relay | 第三方隧道 / FRP |
| 手机端 | 浏览器（relay）/ SSH 客户端（ssh） | 专用 Android App / 浏览器 |
| 触屏布局 | 用 DSH 自带界面 | 重新设计 |
| 依赖 | `ssh2`、`selfsigned` | `ws`、`selfsigned`、CA、App |

两者不冲突。Tailscale 模式依赖 Tailscale 服务；原有 SSH / relay 模式仍可自行部署。

---

## 开发

```bash
npm install
npm test        # 84 个测试
npm run relay   # 本地起一个中继
npm run probe   # ssh 模式的传输自检
```

测试里用的是真的 SSH 服务器（`ssh2.Server` 实现了 `tcpip-forward` / `forwarded-tcpip`）、真的 TLS 中继、真的 HTTP 目标，所以走的是真实协议路径，不是 mock。

### 已验证

- `npm test`：84/84 通过，覆盖主机密钥校验、两种传输的端到端、配对链接、认证拒绝、证书指纹固定、
  重连、以及「连接池排空时排队等待而不是回 503」。
- 真实 `dsh web`（隔离 `DSH_HOME`）：
  - ssh 模式：插件激活后发布 `127.0.0.1:9393`，模拟手机 `-L` 换 Cookie 后拿到真实 DSH SPA（37 KB, 200）；杀掉 SSH 服务器再以相同密钥重启，转发自动恢复；换密钥则按设计拒绝。
  - 信任边界：`trustedHosts` 里的 authority 在 `/api` 上返回 `401`（放行但未认证），未登记的是 `403`（拒绝）。
- 真实 Chromium（`tools/probe-browser.mjs`，390×844 手机视口）经公网中继加载：`#root` 挂载
  34,766 字节、无未捕获异常、无失败请求；接口齐备时页面文本为 DSH 主界面。
- 真机：Android 10+ 通过 App 经中继连入，界面可用。

---

## 运维备忘（这套部署的现状）

| 部分 | 位置 |
|---|---|
| 中继进程 | `relay.example.com:8443`，systemd 单元 `dsh-relay`，代码在 `/opt/dsh-relay/app` |
| 中继密钥 | `/opt/dsh-relay/data/secrets.env`（`HOST_TOKEN` / `ACCESS_TOKEN`） |
| 中继证书 | `/opt/dsh-relay/data/cert.pem`、`key.pem`（自签，10 年） |
| 插件 | `~/.dsh/profiles/desktop/cordis.patch.yml`，包用 junction 链到工作区目录 |
| App | `android-app/dsh-bridge-release.apk`，签名 keystore `android-app/dsh-release.keystore` |

常用操作：

```bash
journalctl -u dsh-relay -f          # 看中继日志
curl -sk https://127.0.0.1:8443/__relay/health   # 池状态
systemctl restart dsh-relay                     # 改完配置重启
```

**换证书**（必须一起改，否则 App 会拒绝连接）：

```bash
openssl x509 -in /opt/dsh-relay/data/cert.pem -noout -fingerprint -sha256
openssl x509 -in /opt/dsh-relay/data/cert.pem -outform PEM > relay_cert.pem
```

然后把 `relay_cert.pem` 放进 `app/src/main/res/raw/`、更新 `RELAY_CERT_SHA256` 和插件里的
`relay.fingerprint`，重新打包 App。

**撤销访问**：改 `/opt/dsh-relay/data/secrets.env` 里的 `ACCESS_TOKEN` → `systemctl restart dsh-relay`
→ 手机上的旧 Cookie 失效，重新配对。

**安全边界**：8443 对公网开放，中继只做透传；拿到 `accessToken` 或那个 APK 就等于能进 DSH。

---

## License

MIT
