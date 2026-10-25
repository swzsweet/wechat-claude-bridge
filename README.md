# 微信、Telegram 与 Claude Code 本机桥接

一份网关连接微信和可选的 Telegram Bot，两台 Windows 电脑分别运行 worker。网关只接收绑定账号的消息；任务回复和一次性审批请求同时送达两个聊天，任一端都可发送任务或处理审批，第一条有效审批决定生效。Telegram 还可收发文件和图片。每台电脑可管理多个项目，每个项目保存独立的会话 ID，使用该电脑的 CC Switch 配置。

## 前提

- 两台电脑均安装 Node.js 20+、Claude Code、CC Switch；在**启动 worker 的同一 Windows 用户**下验证 `claude -p "只回复 OK"` 可通过第三方 API 返回结果。
- 两台电脑需要能通过私有 IP 互相访问：同一局域网可直接使用 A 的局域网 IP；若已有 Tailscale 子网路由或站点到站点路由，也可使用路由可达的 IP。电脑本身不必重复安装 Tailscale。不要把网关端口映射到公网。
- 本项目目录复制到两台电脑，在各自目录运行 `npm ci`。

## 启动（PowerShell）

如果网关部署在 PVE 宿主机上，两台 Windows 电脑只需运行 worker。PVE 的一行安装与更新命令、数据迁移和回退步骤见 `deploy/pve/README.md`。以下步骤适用于网关仍运行在电脑 A 的情况。

在 A 上查看可用的局域网 IP（例如 `192.168.1.20`）；若通过已有 VPN 子网路由连接，则使用 B 可以访问到的 A 的 IP：

```powershell
ipconfig
```

在 A 的第一个 PowerShell 窗口启动网关（替换示例 IP）：

```powershell
$env:BRIDGE_HOST = '192.168.1.20'
npm run gateway
```

首次启动会自动生成 32 字节密钥，保存在 `data/bridge-token.txt`；终端还会打印微信二维码。用微信扫码后，终端会打印 `/绑定` 命令；向 ClawBot 发送该命令以绑定你的微信账号。登录凭证存入 `data/wechat.json`。这两个文件都是秘密，不要分享整个 `data` 目录。微信文字收发直接实现腾讯公开的 iLink 协议字段，无额外微信 SDK 依赖。

微信中显示的电脑名称可在本机 `data/computer-names.json` 中配置，例如 `{"a":"家电脑","b":"电脑 B"}`。修改后重启网关；内部 `/a`、`/b` 命令保持不变。此文件在忽略的 `data/` 目录中，不会上传到 GitHub。

在 A 的第二个 PowerShell 窗口启动 worker A：

```powershell
$env:WORKER_ID = 'a'
$env:GATEWAY_URL = 'http://192.168.1.20:8765'
npm run worker
```

在 B 上启动 worker B，使用 B 可访问到的 A 的 IP，并将 A 上 `data/bridge-token.txt` 的内容安全地设置为环境变量：

```powershell
$env:BRIDGE_TOKEN = '<A 上 data/bridge-token.txt 的内容>'
$env:WORKER_ID = 'b'
$env:GATEWAY_URL = 'http://192.168.1.20:8765'
npm run worker
```

网关启动后，在 B 上运行 `Test-NetConnection 192.168.1.20 -Port 8765`（替换为 A 的实际 IP）。`TcpTestSucceeded: True` 才表示网络可用。若失败，检查两台电脑是否在同一局域网或已有双向子网路由、A 的 `BRIDGE_HOST` 是否绑定正确 IP，以及 Windows 防火墙是否允许 TCP 8765 入站。仅在 A 所在局域网有一台 Tailscale 子网路由器，并不能让完全不在 tailnet 的远端 B 自动连入；这种情况还需要 B 侧的站点路由或客户端。网关、worker 所在电脑都必须保持开机运行。

worker 默认使用 `C:\Users\<用户名>\Documents\ClaudeProjects` 作为项目根目录，首次启动自动创建 `default` 项目。若要改变位置，在启动 worker 前设置 `$env:PROJECTS_ROOT = 'D:\MyProjects'`。项目根目录选定后应保持不变，否则已登记项目的相对路径可能失效。新建或登记项目时无需重启 worker。

## 聊天命令

以下命令在微信和已绑定的 Telegram 私聊中通用。两边共用当前电脑、项目、任务队列和审批状态；任一端发出的命令及其结果都会同步到两边。

Claude Code 的任务结果在 Telegram 中按 Markdown 显示，标题行以普通字号加粗；微信仍接收原始文字。若 Telegram 拒绝某条富文本消息，网关会改用纯文本发送，避免丢失回复。

Telegram 私聊的菜单按钮会列出常用 `/` 命令。菜单使用下划线形式的项目命令，原来的连字符形式仍可在聊天中使用。未绑定时菜单只显示 `/bind`。

| 命令 | 作用 |
| --- | --- |
| `/a`、`/b` | 切换默认电脑 |
| `/a 任务内容`、`/b 任务内容` | 发送任务到指定电脑 |
| 普通文字 | 发给当前电脑 |
| `/status` | 查看 worker 是否在线 |
| `/help` | 查看可用命令 |
| `/auto on`、`/auto off`、`/auto` | 为当前项目开启、关闭或查看自动模式 |
| `/new` | 当前电脑下次任务新开会话 |
| `/projects` | 列出当前电脑的项目和选中的项目 |
| `/tasks` | 查看最近任务及取消、重试按钮 |
| `/cancel 编号`、`/retry 编号` | 取消排队或运行中的任务；重新排队已结束的任务 |
| `/plan 需求` | 只生成计划，审阅同意后才执行；Telegram 提供审阅按钮和 Markdown 文件 |
| `/file 相对路径` | 将当前项目内 10 MB 以下的普通文件发到 Telegram |
| `/export 任务编号 docx` | 将计划或已完成任务的结果导出为 Word；也支持 `md`、`txt` |
| `/project 名称`、`切换到名称` | 切换到已登记的项目；单独发送项目名也可以 |
| `/new_project 名称`（也支持 `/new-project`） | 在项目根目录新建并选择项目 |
| `/import_project 名称 路径`（也支持 `/import-project`） | 登记已有项目，可使用完整路径或根目录内相对路径 |
| `登记项目` | 进入批量登记，下一条消息粘贴项目清单 |
| `/import_projects`（也支持 `/import-projects`） | 进入批量登记，或在同一条消息后接多行清单 |
| `批准 ABCD1234`、`拒绝 ABCD1234` | 处理单次权限请求 |
| `答 ABCD1234 1` | 回答单选问题，序号从 1 开始 |

普通工具审批在 Telegram 消息中也可点击“批准”或“拒绝”按钮；单选问题仍需用 `答 编号 选项序号` 回复。

Telegram 私聊可直接发送图片和 10 MB 以下的文件，带说明文字时作为任务输入；图片会交给 Claude 识别，文件保存在 worker 的私有 inbox。Word `.docx`、文字型 PDF `.pdf`、Excel `.xlsx` 及常见文本文件会提取有长度上限的正文交给 Claude，原文件仍会保留。扫描版 PDF 暂不做 OCR；旧版 `.doc`、`.xls` 请先转换为 `.docx`、`.xlsx`。`/projects` 同时显示项目选择按钮。计划审阅的“同意计划”“要求修改”“放弃”与工具权限审批分开，还可点击“下载 Word”；选择“要求修改”后，下一条普通消息作为修改意见。任务进度会更新同一条 Telegram 消息，最终回复另行发送。计划继续自动附带 `.md` 文件，其他结果可用 `/export` 导出。`/file` 可发送当前项目内的 Word、PDF 等普通文件，但只接受相对路径；隐藏目录、常见凭据文件及指向项目外的链接会被拒绝；文件只发往已绑定的 Telegram 账号。暂不支持语音。

在 Telegram 中引用机器人发来的任务结果或 Claude Code“本轮结果”通知并输入新要求，网关会按原消息对应的电脑、项目和会话续接；当前选中的电脑或项目不会影响这条引用。任务进度与最终结果会回复到新要求上。来源记录保存在网关，最多保留最近 1000 条机器人消息；旧消息无法识别时会明确提示。引用内容最多取前 1800 个字符作为背景；引用图片或文件不会重新附带原始媒体。引用普通聊天消息时仍使用当前电脑和项目。

微信审阅计划可发送 `/plan_approve 编号`、`/plan_revise 编号` 或 `/plan_discard 编号`。计划生成阶段只允许读取工具；同意后会作为新任务执行，仍使用该项目原有的手动或自动权限模式。

可在命令前加 `/a ` 或 `/b ` 指定电脑，例如 `/b 登记项目`。批量登记时每行写一个目录；目录名默认成为项目名，也可以明确指定名称：

```text
登记项目
网站 = C:\Work\client-site
数据分析 = D:\Projects\analytics
E:\code\notes
```

如果先发送 `登记项目`，下一条消息只需粘贴清单。worker 会检查目录是否存在，逐项报告成功、重复或失败；批量登记不会改变当前项目。之后发送 `切换到网站` 或单独发送 `网站` 即可切换，每个项目保留自己的 Claude 会话。项目名支持中文、字母、数字、空格、点、下划线和连字符；同名项目不会覆盖原登记。完整路径可位于项目根目录之外，但必须是该电脑上已存在且当前 Windows 用户可访问的文件夹。`/new-project` 仍只在预设根目录下新建目录。

审批 5 分钟后超时拒绝。审批消息会显示工具名称和完整输入；输入超过 8000 字符时拒绝远程审批。Bash、Write、Edit、MultiEdit 和 NotebookEdit 工具在执行前固定要求远程确认，包括本地规则原本自动允许的操作；其他工具仍按 Claude Code 权限规则处理。

自动模式默认关闭，按电脑和项目分别保存。发送 `/auto on` 后，下一条任务使用 Claude Code 的 `auto` 权限模式，由模型分类器判断工具调用；无法判断的请求仍发到已绑定的聊天审批。自动模式下桥接不再强制逐项审批 Bash 和文件修改，但不会使用 `bypassPermissions`。发送 `/auto off` 恢复原有逐项审批；`/auto` 查看当前项目状态，`/projects` 会以 `[自动]` 标记开启的项目。若当前 Claude Code 或第三方 API 不支持自动模式，worker 会恢复手动模式并报告失败，任务可重新发送。

### VS Code 中的 Claude Code 审批

家电脑的用户级 `PermissionRequest` 钩子可将 VS Code 会话的工具权限请求发送到已绑定的微信和 Telegram 对话。消息会写明“VS Code”、会话标题（若 Claude Code 已生成）和短编号、工具及输入，并带一次性审批编号；在任一端回复 `批准 编号` 或 `拒绝 编号` 后，决定返回等待中的 VS Code 会话。该钩子是同步的，最多等待 5 分钟；超时会拒绝。网关不可用或输入超过 8000 字符时，仍由本机 Claude Code 权限界面处理。此功能不会自动允许任何工具，也不会赋予永久权限。桥接 worker 的审批保持原有流程。

这只处理 Claude Code 的工具权限。`AskUserQuestion`、`ExitPlanMode`、Windows UAC 和浏览器登录等界面操作仍需在本机完成；对应的微信提醒继续发送。`hooks/` 保存可复用的钩子源码及测试；用户级钩子配置和桥接凭证仅保存在本机，不应复制到公开仓库。Telegram 通知也会显示可用的会话标题，取不到时显示短编号。

## 范围与限制

- A、B 以及各项目有独立的 Claude Code 会话历史。桥接 worker 的项目清单及会话 ID 存在本机 `data/worker-a.json` 或 `data/worker-b.json`。引用 VS Code 的本轮结果会在原电脑和目录通过 SDK 续接原会话；VS Code 当前窗口可能不会立即显示这次远程续接的内容，重新打开该会话后再核对。不要让 VS Code 和 worker 同时操作同一段会话。也可在 worker 首次启动前设置 `$env:INITIAL_SESSION_ID = '<会话 ID>'` 作为 `default` 项目的初始会话。
- 微信仍使用文字消息；图片、文件、内联操作按钮仅通过 Telegram 使用。网页登录按钮、Windows UAC、验证码等系统或网页 UI 授权不在 Claude 工具权限回调中。
- 微信 iLink 协议字段来自腾讯公开的 OpenClaw 微信插件文档。扫码和消息收发要在真实微信环境验证；微信服务端协议变化可能需要更新 `src/wechat.js`。
- 网关将任务状态保存在 `data/tasks.json`，重启后恢复排队任务；正在运行的任务标记为中断，需检查结果后手动重试。待审批请求仅保存在内存，网关重启后会超时拒绝。图片及文件暂存于网关私有 `data/media`，应定期清理已结束任务的旧文件。

## 本地检查

`npm test` 检查绑定账号、电脑路由、审批一次性使用和待审批期间的消息顺序。
