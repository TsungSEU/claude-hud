# GLM → claude-hud 额度桥接

把 GLM（智谱 AI / BigModel）API key 的额度用量**桥接**到 claude-hud 状态栏，渲染成真实的 Usage 进度条 + 已用时长。

> 当你通过 GLM 中转使用 `glm-5.2` 等模型时，Claude Code 不会在 statusline stdin 推送 `rate_limits`，claude-hud 的 Usage 行默认空白。本模块定时查询 GLM 额度 API，把结果写成 claude-hud 的外部 usage 快照，状态栏据此渲染。

**关键性质：**

- poller 是一个**独立进程**，与每 ~300ms 运行的 claude-hud 状态栏进程彼此独立。
- claude-hud 状态栏渲染路径保持 **local-only**——它只读本地快照文件，不新增任何网络调用。
- 本模块**零外部依赖**：仅用 Node 18+ 内置模块（`fs` / `os` / 全局 `fetch`），无需 `npm install`，不 import `claude-hud/src` 或任何外部仓库代码。
- `timeFormat: "elapsed"` 模式下，尾部显示「已用时长 / 窗口总时长」，如 `(1h 30m / 5h)`。

---

## 0. 前置条件

- **Node.js 18+**（直接 `node glm/poller.mjs`，零编译、零 npm 依赖）。
- **claude-hud 已作为状态栏安装**（见下节）。

---

## 1. 安装 claude-hud（从本 fork）

本 fork（`TsungSEU/claude-hud`）在上游基础上额外包含：GLM 桥接（`glm/`）+ elapsed 时间格式。

### 方式 A：Claude Code 插件市场（推荐）

在 Claude Code 里执行：

```
/plugin marketplace add TsungSEU/claude-hud
/plugin install claude-hud@claude-hud
```

安装后，把 claude-hud 设为状态栏（若尚未）：

```
/plugin   # 或按界面提示启用 claude-hud 作为 statusline
```

### 方式 B：手动 git clone

```bash
git clone https://github.com/TsungSEU/claude-hud.git ~/.claude/plugins/marketplaces/claude-hud
cd ~/.claude/plugins/marketplaces/claude-hud
npm install && npm run build     # 生成 dist/
```

然后在 `~/.claude/settings.json` 配 statusLine 指向 `dist/index.js`（详见 claude-hud 主 README）。

> 之后从 fork 更新会自动带上 `glm/` 与 elapsed 改动，**不会被上游覆盖**。

---

## 2. 配置 API key（三选一，优先级从高到低）

| 方式 | 说明 |
|------|------|
| **环境变量** | `export GLM_API_KEY=<你的 BigModel API key>` |
| **配置文件** | 复制 `glm/config.example.json` 为 `glm/config.json`，填 `apiKey` |
| **自动探测** | 若 `~/.claude/settings.json` 的 `env` 里 `ANTHROPIC_BASE_URL` 指向 `bigmodel`，poller 自动复用 `ANTHROPIC_AUTH_TOKEN`（无需另配） |

`config.json` 示例：

```json
{
  "apiKey": "你的真实 BigModel API key",
  "intervalSec": 300,
  "snapshotPath": ""
}
```

- `intervalSec`：轮询间隔（秒），默认 `300`（5 分钟）。
- `snapshotPath`：快照输出路径，留空则默认 `<家目录>/.claude/glm-usage-snapshot.json`（推荐留空，与 claude-hud 默认位置一致）。

> `config.json` 已在 `glm/.gitignore` 中忽略，不会被提交。

---

## 3. 运行 poller

```bash
# 循环模式（默认每 5 min 抓一次，启动即抓第一次）
npm run glm:poll

# 单次模式（验证 key / 看一眼当前百分比）
npm run glm:poll:once
```

或直接用 node（不依赖 npm 脚本）：

```bash
node glm/poller.mjs           # 循环
node glm/poller.mjs --once    # 单次
```

`--once` 会在 stdout 打印 `GLM usage: N% (resets at ...)`，并把快照写到 `snapshotPath`。

---

## 4. 接线 claude-hud 状态栏

编辑 `~/.claude/plugins/claude-hud/config.json`（不存在则新建），在 `display` 里合并加入：

```json
{
  "display": {
    "externalUsagePath": "<绝对路径>/glm-usage-snapshot.json",
    "timeFormat": "elapsed"
  }
}
```

- **`externalUsagePath`**：快照绝对路径。
  - Linux / macOS：`/home/<你>/.claude/glm-usage-snapshot.json`
  - Windows：`C:\\Users\\<你>\\.claude\\glm-usage-snapshot.json`（反斜杠需转义）
- **`timeFormat: "elapsed"`**：尾部显示「已用 / 窗口」，如 `(1h 30m / 5h)`。设为 `"relative"` 则回到「剩余」，如 `(resets in 3h 5m)`。

> claude-hud 在某次会话的 stdin **没有** `rate_limits` 时（GLM 中转正是此场景）才回退读 `externalUsagePath`；若同时挂了 Anthropic 订阅，原生 `rate_limits` 优先。

配置正确且 poller 在跑后，状态栏会出现：

```
Usage ████░░░░░░ 42% (2h 30m / 5h)
```

---

## 5. 常驻部署（系统服务 + 异常自动重启）

loop 模式是常驻进程，重启电脑后需重新拉起。下面按平台给出**开机自启 + 崩溃自动重启**的方案。

> 以下示例中 `POLLER` 代指 poller.mjs 的绝对路径，例如：
> - clone 方式：`/home/<你>/.claude/plugins/marketplaces/claude-hud/glm/poller.mjs`
> - 插件安装方式：在 `~/.claude/plugins/cache/claude-hud/claude-hud/<版本>/glm/poller.mjs`
> - `NODE` 代指 node 可执行文件路径（`which node` 查，如 `/usr/bin/node`、`/opt/homebrew/bin/node`）。

### Linux（systemd user service，推荐）

新建 `~/.config/systemd/user/glm-poller.service`：

```ini
[Unit]
Description=GLM quota -> claude-hud bridge poller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.claude/plugins/marketplaces/claude-hud/glm/poller.mjs
Restart=always
RestartSec=10
StartLimitIntervalSec=60
StartLimitBurst=5

[Install]
WantedBy=default.target
```

启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now glm-poller
systemctl --user status glm-poller          # 应为 active (running)
journalctl --user -u glm-poller -f           # 看日志
loginctl enable-linger $USER                 # 注销 / 未登录也常驻
```

- `Restart=always` + `RestartSec=10`：进程**任何原因退出（崩溃/被杀）都 10 秒后自动重启**。
- `StartLimitIntervalSec` / `StartLimitBurst`：60 秒内重启超过 5 次才放弃，防止崩溃死循环。

### macOS（launchd）

新建 `~/Library/LaunchAgents/com.glm.poller.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.glm.poller</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/USER/.claude/plugins/marketplaces/claude-hud/glm/poller.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/glm-poller.err.log</string>
</dict>
</plist>
```

启用：

```bash
launchctl load ~/Library/LaunchAgents/com.glm.poller.plist
launchctl list | grep glm.poller          # 看是否加载
tail -f /tmp/glm-poller.err.log           # 看日志
```

- `RunAtLoad`：登录即启动。
- `KeepAlive=true`：进程**退出/崩溃后自动拉起**。
- 卸载：`launchctl unload ~/Library/LaunchAgents/com.glm.poller.plist`。

### Windows

**方式 A（推荐）：NSSM —— 服务化 + 崩溃自动重启**

下载 [NSSM](https://nssm.cc/)，以管理员身份在 cmd/PowerShell：

```cmd
nssm install glm-poller "C:\Program Files\nodejs\node.exe" "C:\Users\YOU\.claude\plugins\marketplaces\claude-hud\glm\poller.mjs"
nssm set glm-poller AppDirectory "C:\Users\YOU\.claude\plugins\marketplaces\claude-hud"
nssm set glm-poller AppStdout "C:\Users\YOU\glm-poller.log"
nssm set glm-poller AppStderr "C:\Users\YOU\glm-poller.log"
nssm start glm-poller
```

NSSM 注册为 Windows 服务，**开机自启 + 崩溃自动重启**（默认 `AppExit` 动作即重启）。管理：`nssm restart glm-poller` / `nssm remove glm-poller`。

**方式 B：shell:startup + .vbs（开机自启，但不自动重启）**

`Win + R` → `shell:startup` → 新建 `glm-poller.vbs`：

```vbs
' GLM poller 后台自启（无窗口）
CreateObject("Wscript.Shell").Run "node ""C:\Users\YOU\.claude\plugins\marketplaces\claude-hud\glm\poller.mjs""", 0, False
```

登录后后台运行；崩溃不会自动恢复（要自动重启请用方式 A）。

**方式 C：计划任务（失败重启）**

任务计划程序 → 创建任务 → 触发器「登录时」→ 操作「启动程序 = node ...poller.mjs」→ 「设置」页勾选「如果任务失败，按以下频率重启」。兼具开机自启与失败重启。

---

## 6. 故障排查

状态栏**没有显示** Usage 行时，按顺序排查：

1. **poller 是否在跑？**
   - Linux：`systemctl --user status glm-poller`
   - macOS：`launchctl list | grep glm.poller`
   - Windows：`sc query glm-poller`（NSSM）或任务管理器找 `node.exe`
   - 或临时跑 `npm run glm:poll:once`，看 stdout 是否打印百分比。
2. **快照是否新鲜？** 看 `~/.claude/glm-usage-snapshot.json` 的 `updated_at` 是否在 **5 分钟以内**。claude-hud 默认新鲜度 300000 ms（5 min），过期会自动隐藏 Usage 行（不显示脏数据）。
3. **`externalUsagePath` 是否绝对路径？** 必须绝对路径；Windows 反斜杠需转义（`\\`）。
4. **是否同时挂了 Anthropic 订阅？** 若 stdin 有原生 `rate_limits`，它会优先，外部快照不显示——属预期。

其它：

- poller stderr 报错但**旧快照未被覆盖**：设计如此（失败容错），修正 key 后下一周期自动恢复。
- 缺 API key：poller 启动即退出并打印配置提示。

---

## 7. 安全说明

- `config.json` 已被 `glm/.gitignore` 忽略，**不会**进版本库。请勿把 key 写进 `config.example.json` 或本 README。
- poller 调用 GLM 额度 API 时，`Authorization` 头**直接放完整 key**（无 `Bearer` 前缀，BigModel 约定）。请求只发往 `https://open.bigmodel.cn`，不经任何第三方。
- 快照以 `0o600` 权限原子写入（tmp + rename），仅含百分比与重置时间戳，不含 key。

---

## 设计参考

完整设计与隔离边界见 `docs/superpowers/specs/2026-06-30-glm-hud-bridge-design.md`。
