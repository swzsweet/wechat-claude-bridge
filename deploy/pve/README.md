# PVE 宿主机网关部署

网关直接作为 PVE 宿主机上的 systemd 服务运行；Windows 电脑只运行 worker。PVE 需要能访问 GitHub、nodejs.org 和 npm registry。端口 8765 只向两台 worker 所在的私有网络开放，不要映射到公网。

## 可选：接入 Telegram Bot

先在 Telegram 的 BotFather 创建 Bot。不要把 Bot Token 发到聊天或提交到 GitHub。完成下方首次安装或更新后，在 PVE Web Shell 中以 root **单独运行**以下命令。脚本会等待你输入 Token（输入不会回显），验证格式后才保存并重启服务：

```sh
bash /opt/wechat-claude-bridge/current/deploy/pve/set-telegram-token.sh
journalctl -u wechat-claude-gateway.service -n 30 --no-pager
```

日志会显示 `/bind` 加一次性绑定码。在 Telegram 中与该 Bot **私聊**并发送这条命令。绑定成功后，微信和 Telegram 会同时收到任务回复和审批请求；任一端都能发任务、切换项目或批准/拒绝，先提交的审批决定生效。Bot Token、Telegram 绑定 ID 和轮询位置保存在 `/var/lib/wechat-claude-bridge/`，不会上传到 GitHub。Telegram Bot 不应同时被其他程序以 `getUpdates` 轮询；如果此前配置过 webhook，需先从旧系统移除 webhook。格式无效的 Token 会禁用 Telegram 通道，但微信仍保持运行。

## 首次安装

在 PVE Web Shell 中以 root 执行。命令从本仓库的 `main` 拉取代码，在 `/opt/wechat-claude-bridge/releases/` 建立版本目录，在 `/var/lib/wechat-claude-bridge/` 保留数据。首次没有微信状态文件时只安装服务，不启动网关。

```sh
curl -fsSL https://raw.githubusercontent.com/swzsweet/wechat-claude-bridge/main/deploy/pve/install.sh | sh -s -- 192.168.31.120
```

切换时先停止旧 Windows 网关，保持它的 worker 状态和项目清单。然后把旧网关 `data/` 中的以下文件通过 SFTP 上传到 PVE 的 `/var/lib/wechat-claude-bridge/`：

```text
bridge-token.txt
wechat.json
gateway.json
sync.txt
wechat-context.json
computer-names.json
```

其中前五个文件可能含凭证、绑定身份或微信会话上下文，不能提交到 GitHub，也不要粘贴到聊天里。`sync.txt` 可以不存在，但复制它能接续上次微信消息位置。

上传后在 PVE Web Shell 执行：

```sh
chown -R wechatbridge:wechatbridge /var/lib/wechat-claude-bridge
chmod 700 /var/lib/wechat-claude-bridge
find /var/lib/wechat-claude-bridge -maxdepth 1 -type f -exec chmod 600 {} +
systemctl enable --now wechat-claude-gateway.service
systemctl status wechat-claude-gateway.service --no-pager
```

家电脑随后创建 `data/worker-gateway.json`，内容为 `{"gatewayUrl":"http://192.168.31.120:8765"}`，重启 `WechatClaudeBridge` 计划任务后只会运行 worker A。家电脑的 `~/.claude/notifications/wechat-config.json` 同样加入 `"gatewayUrl":"http://192.168.31.120:8765"`，让 VS Code 通知与审批发往 PVE。电脑 B 运行 worker B，并使用同一个网关地址和桥接密钥；每台电脑仍使用自己的 Claude Code、CC Switch 和项目目录。

## 更新与回退

在 PVE Web Shell 中再次执行与首次安装完全相同的一行命令即可更新。脚本下载 GitHub `main` 和官方 Node.js 24 Linux 包，校验 Node.js 包的 SHA-256，安装依赖后切换到新版本并重启服务。`/var/lib/wechat-claude-bridge/` 不会被覆盖。更新前一个版本保存在 `/opt/wechat-claude-bridge/previous`。

若新版本有问题，在 PVE Web Shell 执行：

```sh
sh /opt/wechat-claude-bridge/current/deploy/pve/rollback.sh
```

检查日志：

```sh
journalctl -u wechat-claude-gateway.service -n 80 --no-pager
```

更新网关代码只需执行 PVE 的更新命令；更改 worker 执行逻辑时，两台 Windows 电脑也需要更新。网关负责微信登录、消息路由和审批编号；worker 负责本机项目、Claude 会话和工具执行。VS Code 会话的审批钩子运行在 Windows 本机，通过网关等待微信决定。
