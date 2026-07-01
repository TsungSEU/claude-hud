# Claude HUD

一个 Claude Code 插件，实时显示正在发生的事情——上下文使用率、活跃工具、运行中的 Agent 和待办进度。始终在你的输入下方可见。

[![License](https://img.shields.io/github/license/tsungseu/claude-hud?v=2)](LICENSE)
[![Stars](https://img.shields.io/github/stars/tsungseu/claude-hud)](https://github.com/tsungseu/claude-hud/stargazers)

![Claude HUD in action](claude-hud-preview-5-2.png)

> 🌐 [English README](README.md) | 中文文档

## 安装

在 Claude Code 实例中，运行以下命令：

**步骤 1：添加市场**
```
/plugin marketplace add tsungseu/claude-hud
```

**步骤 2：安装插件**

<details>
<summary><strong>⚠️ Linux 用户：请先点击此处</strong></summary>

在 Linux 上，`/tmp` 通常是独立的文件系统（tmpfs），这会导致插件安装失败并报错：
```
EXDEV: cross-device link not permitted
```

**修复方法**：在安装前设置 TMPDIR：
```bash
mkdir -p ~/.cache/tmp && TMPDIR=~/.cache/tmp claude
```

然后在该会话中运行下面的安装命令。这是 [Claude Code 平台的限制](https://github.com/anthropics/claude-code/issues/14799)。

</details>

```
/plugin install claude-hud
```

安装完成后，重新加载插件：

```
/reload-plugins
```

**步骤 3：配置状态栏**
```
/claude-hud:setup
```

<details>
<summary><strong>⚠️ Windows 用户：如果 setup 提示未找到 JavaScript 运行时，请点击此处</strong></summary>

在 Windows 上，Claude HUD setup 支持的运行时是 Node.js LTS。如果 setup 提示未找到 JavaScript 运行时，请先为你的 shell 安装 Node.js：
```powershell
winget install OpenJS.NodeJS.LTS
```
然后重启 shell 并再次运行 `/claude-hud:setup`。

</details>

完成！重启 Claude Code 以加载新的 statusLine 配置，HUD 将会出现。

在 Windows 上，setup 写入新的 `statusLine` 配置后，请完整重启 Claude Code。

---

## 什么是 Claude HUD？

Claude HUD 让你在 Claude Code 会话中获得更清晰的洞察。

| 你看到的内容 | 为什么重要 |
|--------------|------------|
| **项目路径** | 知道你当前在哪个项目中（可配置 1-3 级目录深度） |
| **上下文健康度** | 在上下文窗口满之前准确了解还剩多少 |
| **工具活动** | 实时观察 Claude 读取、编辑和搜索文件 |
| **Agent 追踪** | 查看哪些子 Agent 正在运行以及它们在做什么 |
| **待办进度** | 实时跟踪任务完成情况 |

## 显示效果

### 默认（2 行）
```
[Opus] │ my-project git:(main*)
上下文 █████░░░░░ 45% │ 使用率 ██░░░░░░░░ 25%（1小时30分 / 5小时）
```
- **第 1 行** — 模型、提供商标签（如能正面识别，例如 `Bedrock`、`Vertex`）、项目路径、git 分支
- **第 2 行** — 上下文进度条（绿 → 黄 → 红）和使用率限制

### 可选行（通过 `/claude-hud:configure` 启用）
```
◐ Edit: auth.ts | ✓ Read ×3 | ✓ Grep ×2        ← 工具活动
◐ explore [haiku]: 查找认证代码（2分15秒）       ← Agent 状态
▸ 修复认证漏洞（2/5）                             ← 待办进度
```

---

## 工作原理

Claude HUD 使用 Claude Code 原生的 **statusline API**——无需独立窗口，不需要 tmux，在任何终端都能工作。

```
Claude Code → stdin JSON → claude-hud → stdout → 在终端中显示
           ↘ transcript JSONL（工具、Agent、待办）
```

**核心特性：**
- 来自 Claude Code 的原生 Token 数据（非估算）
- 适配 Claude Code 报告的上下文窗口大小，包括最新的 1M 上下文会话
- 解析转录文件以获取工具/Agent 活动
- 约每 300ms 更新一次

---

## 配置

随时自定义你的 HUD：

```
/claude-hud:configure
```

引导式配置涵盖布局、语言和常用显示开关。高级选项如自定义颜色和阈值仍然保留，但你需要直接编辑配置文件来设置它们：

- **首次设置**：选择预设（完整/核心/极简），选择标签语言，然后微调各个元素
- **随时自定义**：开关各项、调整 Git 显示样式、切换布局或更改标签语言
- **保存前预览**：在提交更改前精确预览 HUD 的效果

### 预设

| 预设 | 显示内容 |
|------|----------|
| **完整（Full）** | 全部启用——工具、Agent、待办、Git、使用率、时长 |
| **核心（Essential）** | 活动行 + Git 状态，减少信息冗余 |
| **极简（Minimal）** | 仅核心——只有模型名称和上下文进度条 |

选择预设后，你可以单独开启或关闭各个元素。

### 手动配置

直接编辑 `~/.claude/plugins/claude-hud/config.json` 来配置高级选项，如 `colors.*`、`pathLevels`、`maxWidth`、阈值覆盖、`display.timeFormat` 以及 `display.promptCacheTtlSeconds`。运行 `/claude-hud:configure` 时会保留这些手动设置，同时你仍可更改 `language`、布局和常用引导式开关。

中文 HUD 标签作为显式 opt-in 选项提供。除非你在 `/claude-hud:configure` 中选择 `中文` 或在配置中设置 `language`，否则默认使用英文。短别名 `zh` 仍然有效，新的引导式配置会写入规范值 `zh-Hans`。

### 选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `language` | `en` \| `zh` \| `zh-Hans` | `en` | HUD 标签语言。默认为英文；设为 `zh` 或 `zh-Hans` 启用简体中文标签 |
| `lineLayout` | string | `expanded` | 布局：`expanded`（多行）或 `compact`（单行） |
| `pathLevels` | 1-3 | 1 | 项目路径显示的目录层级数 |
| `maxWidth` | number \| `null` | `null` | 可选的回退宽度，仅在终端宽度检测完全失败时使用 |
| `forceMaxWidth` | boolean | false | 当设置了 `maxWidth` 时始终使用它，即使终端宽度检测返回更小的值 |
| `elementOrder` | string[] | `["project","context","usage","promptCache","memory","environment","tools","agents","todos","sessionTime"]` | 展开模式下元素的顺序。省略的条目在展开模式下隐藏。现有配置会保留其显式顺序直到更新 |
| `display.mergeGroups` | string[][] | `[["context","usage"]]` | 展开模式下相邻时应共享一行的元素分组。设为 `[]` 可禁用合并行 |
| `gitStatus.enabled` | boolean | true | 在 HUD 中显示 git 分支 |
| `gitStatus.showDirty` | boolean | true | 显示 `*` 表示未提交的更改 |
| `gitStatus.showAheadBehind` | boolean | false | 显示 `↑N ↓N` 表示领先/落后远程的提交数 |
| `gitStatus.pushWarningThreshold` | number | 0 | 当未推送提交数达到此值时，用警告色显示 ahead 计数（`0` 表示禁用） |
| `gitStatus.pushCriticalThreshold` | number | 0 | 当未推送提交数达到此值时，用严重色显示 ahead 计数（`0` 表示禁用） |
| `gitStatus.showFileStats` | boolean | false | 显示文件变更数量 `!M +A ✘D ?U` |
| `gitStatus.branchOverflow` | `truncate` \| `wrap` | `truncate` | 保持当前截断行为，或在可能时让 git 块以自己的换行边界单独换到下一行 |
| `display.showModel` | boolean | true | 显示模型名称 `[Opus]` |
| `display.showAddedDirs` | boolean | true | 显示来自 `/add-dir` 的额外工作区目录（如 `+sparkle +lib-foo`）；空数组不显示任何内容。在两种布局中最多渲染 5 个目录（溢出显示为 `+N more`），基名截断为 24 个字符并加 `…` |
| `display.addedDirsLayout` | `inline` \| `line` | `inline` | `inline` 将目录放在项目名称旁边，每个目录带 `+name` 前缀；`line` 在单独的 `Added dirs: name1, name2` 行渲染（无 `+` 前缀，逗号分隔） |
| `display.showContextBar` | boolean | true | 显示可视化上下文进度条 `████░░░░░░` |
| `display.contextValue` | `percent` \| `tokens` \| `remaining` \| `both` | `percent` | 上下文显示格式（`45%`、`45k/200k`、剩余 `55%` 或 `45% (45k/200k)`） |
| `display.showConfigCounts` | boolean | false | 显示 CLAUDE.md、rules、MCPs、hooks 数量 |
| `display.showCost` | boolean | false | 使用 Claude Code 原生提供的 `cost.total_cost_usd` 显示会话费用（可用时），并附带本地估算回退方案 |
| `display.showOutputStyle` | boolean | false | 从配置文件显示当前 Claude Code `outputStyle`，格式为 `style: <名称>` |
| `display.showDuration` | boolean | false | 显示会话时长 `⏱️ 5m` |
| `display.showSpeed` | boolean | false | 显示输出 Token 速度 `out: 42.1 tok/s` |
| `display.showUsage` | boolean | true | 显示 Claude 订阅用户的使用率限制（可用时） |
| `display.usageValue` | `percent` \| `remaining` | `percent` | 使用率显示格式（已使用 `25%`，或剩余 `75%`） |
| `display.usageBarEnabled` | boolean | true | 将使用率显示为可视化进度条而非文本 |
| `display.usageCompact` | boolean | false | 以较短的文本形式显示使用率，如 `5h: 25% (1h 30m)`；优先于 `display.usageBarEnabled` |
| `display.showResetLabel` | boolean | true | 在使用率倒计时前显示 `resets in` 前缀 |
| `display.timeFormat` | `relative` \| `absolute` \| `both` \| `elapsed` \| `elapsedAndAbsolute` | `relative` | 控制使用率窗口时间的显示方式：仅倒计时（`resets in 2h 30m`）、墙钟重置时间（`resets at 14:30`）、两者同时显示、窗口已用时长（`1h 30m / 5h`），或已用时长加墙钟重置时间 |
| `display.sevenDayThreshold` | 0-100 | 80 | 当 7 天使用率 ≥ 阈值时显示（0 = 始终显示） |
| `display.externalUsagePath` | string | `""` | 可选的本地使用率快照文件路径，仅在 stdin `rate_limits` 缺失时使用 |
| `display.externalUsageWritePath` | string | `""` | 可选的绝对 `.json` 路径，父目录必须已存在。当 stdin `rate_limits` 存在时，ClaudeHUD 会写入私有权限快照供其他本地工具读取。相对路径、非 json 文件和缺失父目录会被忽略 |
| `display.externalUsageFreshnessMs` | number | `300000` | 外部使用率快照允许的最长存活时间，超时后会被忽略 |
| `display.showTokenBreakdown` | boolean | true | 在高上下文时（85%+）显示 Token 详情 |
| `display.showTools` | boolean | false | 显示工具活动行 |
| `display.toolNameMaxLength` | number | `0` | 工具名称最大显示长度。`0` 保留完整名称；截断 MCP 名称时可能缩短为最后一段 |
| `display.toolsMaxVisible` | number | `4` | 工具行最多显示的已完成工具数。`0` 表示不限制 |
| `display.showAgents` | boolean | false | 显示 Agent 活动行 |
| `display.showTodos` | boolean | false | 显示待办进度行 |
| `display.showSessionName` | boolean | false | 显示会话 slug 或 `/rename` 设置的自定义标题 |
| `display.showAdvisor` | boolean | false | 在 project 行内联显示 Claude Code `/advisor` 配置的顾问模型，例如 `Advisor: Opus 4.7`。来自 Claude Code 写入每条 assistant transcript 记录的 `advisorModel` 字段；渲染前会做控制字符/双向标记/ANSI 过滤并截断到 64 字符 |
| `display.advisorOverride` | string | `""` | 手动覆盖顾问显示文本。非空时优先于 transcript 检测，同样会做过滤和截断 |
| `display.showSessionStartDate` | boolean | false | 显示 transcript 会话开始时间戳 |
| `display.showLastResponseAt` | boolean | false | 显示最后一次 assistant 响应写入的时间距现在多久 |
| `display.showCompactions` | boolean | false | 显示本会话已发生的上下文压缩次数（手动 `/compact` 或自动压缩），从 transcript 的 `compact_boundary` 记录计数，例如 `压缩次数: 2`。第一次压缩前不显示 |
| `display.showClaudeCodeVersion` | boolean | false | 显示已安装的 Claude Code 版本，如 `CC v2.1.81` |
| `display.showMemoryUsage` | boolean | false | 在展开布局中显示近似系统 RAM 使用行 |
| `display.showPromptCache` | boolean | false | 根据 transcript 中最后一次 assistant 响应时间显示 prompt cache 倒计时 |
| `display.promptCacheTtlSeconds` | number | `300` | Prompt cache TTL 秒数。Pro 保持默认值，Max 可设为 `3600` |
| `colors.context` | 颜色值 | `green` | 上下文进度条和百分比的基础颜色 |
| `colors.usage` | 颜色值 | `brightBlue` | 使用率进度条和低于警告阈值时百分比的颜色 |
| `colors.warning` | 颜色值 | `yellow` | 上下文阈值和使用率警告文本的警告颜色 |
| `colors.usageWarning` | 颜色值 | `brightMagenta` | 使用率进度条和接近阈值时百分比的警告颜色 |
| `colors.critical` | 颜色值 | `red` | 达到限制状态和严重阈值的颜色 |
| `colors.model` | 颜色值 | `cyan` | 模型徽章颜色，如 `[Opus]` |
| `colors.project` | 颜色值 | `yellow` | 项目路径的颜色 |
| `colors.git` | 颜色值 | `magenta` | Git 包装文本的颜色，如 `git:(` 和 `)` |
| `colors.gitBranch` | 颜色值 | `cyan` | Git 分支和分支状态文本的颜色 |
| `colors.label` | 颜色值 | `dim` | 标签和次要元数据的颜色，如 `Context`、`Usage`、计数和进度文本 |
| `colors.custom` | 颜色值 | `208` | 可选自定义行的颜色 |
| `colors.barFilled` | string | `█` | 进度条填充部分使用的字符 |
| `colors.barEmpty` | string | `░` | 进度条空白部分使用的字符 |

`colors.barFilled` 和 `colors.barEmpty` 接受单个可见字素。控制字符、不可见格式字符（双向控制符、零宽连接符、变体选择符）、行/段落分隔符和非字符会被拒绝。宽字符（emoji、CJK）可能会影响进度条对齐，具体取决于终端。

支持的颜色名称：`dim`、`red`、`green`、`yellow`、`magenta`、`cyan`、`brightBlue`、`brightMagenta`。你也可以使用 256 色数字（`0-255`）或十六进制（`#rrggbb`）。

`display.showMemoryUsage` 为完全 opt-in 选项，仅在 `expanded` 布局下渲染。它报告本地机器的近似系统 RAM 使用情况，而非 Claude Code 或特定进程内的精确内存压力。由于可回收的 OS 缓存缓冲区仍可能被计入已用内存，该数字可能高估实际压力。

`display.showCost` 为完全 opt-in 选项。ClaudeHUD 优先使用 Claude Code 在 stdin 上提供的原生 `cost.total_cost_usd` 字段（可用时）。如果该字段缺失或对直连 Anthropic 会话无效，ClaudeHUD 会回退到现有的基于本地转录文件的估算方案，确保费用行在旧负载下仍能工作。原生字段在会话中首个 API 响应之前为空，因此费用显示可能在响应到达前保持隐藏。对于已知的路由提供商（如 Bedrock、Vertex AI），ClaudeHUD 也会隐藏费用显示，因为云提供商计费会话可能报告 `$0.00` 或省略该字段，即使会话并非真正免费。

`display.showPromptCache` 为完全 opt-in 选项。启用后，ClaudeHUD 会读取本地 transcript 中最后一次 assistant 响应的时间戳，并显示距离 prompt cache 过期还剩多久。默认 TTL 为 5 分钟（`300` 秒）。如果你想按 1 小时的 Max 风格窗口显示，可将 `display.promptCacheTtlSeconds` 设为 `3600`。如果 transcript 里还没有 assistant 时间戳，这个元素会继续隐藏。

### 使用率限制

当 Claude Code 在 stdin 上提供订阅用户 `rate_limits` 数据时，使用率显示**默认启用**。它会在第 2 行与上下文进度条一起显示你的使用率消耗。

将 `display.usageValue` 设为 `remaining` 可显示剩余配额而非已使用配额。警告颜色和 7 天阈值检查仍使用底层的已使用百分比。

ClaudeHUD 优先使用官方 statusline stdin 负载中的使用率数据。如果 `rate_limits` 缺失，你可以通过 `display.externalUsagePath` 显式启用本地 sidecar 快照回退，例如让代理程序写入 JSON 文件。只要 stdin 和 sidecar 同时存在，stdin 始终优先。

回退快照必须足够新（由 `display.externalUsageFreshnessMs` 控制），并且包含有效的 `updated_at`、以及 `five_hour` 窗口、`seven_day` 窗口或 `balance_label`。`balance_label` 是预付费提供商余额的可选文本；显示前会进行裁剪、长度限制和清理。非法 JSON、过期文件或非法时间戳都会被静默忽略。

如果希望 ClaudeHUD 将官方 stdin `rate_limits` 写入本地快照供其他工具使用，可设置 `display.externalUsageWritePath`。该路径必须为绝对路径、以 `.json` 结尾，并位于已存在的目录中。ClaudeHUD 会使用私有权限写入该文件，并静默忽略无效路径。

免费/仅限每周账户会单独显示每周窗口，而不是显示幽灵 `5h: --` 占位符。

当 7 天使用率超过 `display.sevenDayThreshold`（默认 80%）时会显示：

```
上下文 █████░░░░░ 45% │ 使用率 ██░░░░░░░░ 25%（1小时30分 / 5小时）| ██████████ 85%（2天 / 7天）
```

如需禁用，请将 `display.showUsage` 设为 `false`。

重置时间默认显示为相对倒计时。将 `display.timeFormat` 设为 `absolute` 可显示墙钟时间，设为 `both` 可同时显示两种形式，设为 `elapsed` 可显示已用时长 / 窗口总时长（`1h 30m / 5h`），设为 `elapsedAndAbsolute` 可同时显示已用时长和墙钟重置时间。该设置目前只能手动编辑；`/claude-hud:configure` 会保留它，但不会修改它。

将 `display.showResetLabel` 设为 `false` 可使用较短的使用率倒计时格式，如 `(3h 17m)` 而非 `(resets in 3h 17m)`。

将 `display.usageCompact` 设为 `true` 可使用更短的使用率格式，如 `5h: 25% (1h 30m)`。紧凑模式优先于 `display.usageBarEnabled`。

**前提条件：**
- Claude Code 必须在当前会话的 stdin 上包含订阅用户 `rate_limits` 数据
- 不适用于仅使用 API 密钥的用户

**故障排查：** 如果使用率不显示：
- 确保你已使用 Claude 订阅账户登录（而非 API 密钥）
- 检查配置中的 `display.showUsage` 未设为 `false`
- API 用户看不到使用率显示（他们按 Token 付费，没有使用率限制）
- AWS Bedrock 模型显示 `Bedrock` 并隐藏使用率限制（使用率由 AWS 管理）
- Google Vertex AI 模型显示 `Vertex` 并隐藏费用估算（定价与 Anthropic 直连不同）
- Claude Code 可能在会话中首个模型响应之前将 `rate_limits` 留空
- 某些 Claude Code 构建版本和订阅层级即使在首个响应之后仍可能省略 `rate_limits`
- 如果你配置了 `display.externalUsagePath`，ClaudeHUD 会先尝试读取该本地快照，再决定是否隐藏使用率
- ClaudeHUD 不会回退到凭据抓取或未记录的 API 调用

回退快照示例：

```json
{
  "updated_at": "2026-04-20T12:00:00.000Z",
  "five_hour": {
    "used_percentage": 42,
    "resets_at": "2026-04-20T15:00:00.000Z"
  },
  "seven_day": {
    "used_percentage": 84,
    "resets_at": "2026-04-27T12:00:00.000Z"
  }
}
```

### 配置示例

```json
{
  "language": "zh",
  "lineLayout": "expanded",
  "pathLevels": 2,
  "elementOrder": ["project", "tools", "context", "usage", "memory", "environment", "agents", "todos", "sessionTime"],
  "gitStatus": {
    "enabled": true,
    "showDirty": true,
    "showAheadBehind": true,
    "showFileStats": true
  },
  "display": {
    "showTools": true,
    "showAgents": true,
    "showTodos": true,
    "showConfigCounts": true,
    "showDuration": true,
    "showMemoryUsage": true
  },
  "colors": {
    "context": "cyan",
    "usage": "cyan",
    "warning": "yellow",
    "usageWarning": "magenta",
    "critical": "red",
    "model": "cyan",
    "project": "yellow",
    "git": "magenta",
    "gitBranch": "cyan",
    "label": "dim",
    "custom": "#FF6600"
  }
}
```

### 显示示例

**1 级（默认）：** `[Opus] │ my-project git:(main)`

**2 级：** `[Opus] │ apps/my-project git:(main)`

**3 级：** `[Opus] │ dev/apps/my-project git:(main)`

**带脏状态指示器：** `[Opus] │ my-project git:(main*)`

**带领先/落后：** `[Opus] │ my-project git:(main ↑2 ↓1)`

**带文件统计：** `[Opus] │ my-project git:(main* !3 +1 ?2)`
- `!` = 修改的文件，`+` = 新增/暂存，`✘` = 删除，`?` = 未跟踪
- 计数为 0 的项会被省略，以保持显示整洁

### 临时关闭 HUD

设置环境变量 `CLAUDE_HUD_DISABLE`，即可在本次会话中关闭 HUD，无需从 `settings.json` 中移除 `statusLine` 配置：

```bash
CLAUDE_HUD_DISABLE=1 claude
```

不设置（或设为明确的否定值：`0`、`false`、`off`、`no`）则保持 HUD 启用。关闭时 HUD 会立即退出，不读取会话记录、不执行 git 操作，状态栏在该会话中保持为空。

### 故障排查

**配置不生效？**
- 检查 JSON 语法错误：无效的 JSON 会静默回退到默认值
- 确保值有效：`pathLevels` 必须是 1、2 或 3；`lineLayout` 必须是 `expanded` 或 `compact`；`maxWidth` 必须是正数
- 删除配置文件并运行 `/claude-hud:configure` 重新生成

**Git 状态缺失？**
- 验证你是否在 git 仓库中
- 检查配置中的 `gitStatus.enabled` 不为 `false`

**工具/Agent/待办行缺失？**
- 这些默认隐藏——在配置中通过 `showTools`、`showAgents`、`showTodos` 启用
- 它们也仅在有活动可显示时才会出现

**HUD 设置后不显示？**
- 重启 Claude Code 以加载新的 statusLine 配置
- 在 macOS 上，完全退出 Claude Code 并在终端中再次运行 `claude`
- 确认环境中没有设置 `CLAUDE_HUD_DISABLE`（例如从 shell 配置文件中导出）——它会让 HUD 完全静默，包括安装验证

---

## GLM / BigModel 用量桥接

当你通过 GLM（智谱 AI / BigModel）中转使用 `glm-5.2` 等模型时，中转端点不会在 statusline stdin 推送 Anthropic 风格的 `rate_limits`，Usage 行因此为空。本仓库自带的 `src/providers/glm/` 模块用于补上这一环：一个独立的 poller 定时查询 BigModel 额度 API，把结果写成本地用量快照供 Claude HUD 读取。

**架构：** poller 是独立的常驻进程；HUD 的状态栏进程保持 local-only（只读快照文件，不发起任何网络调用）。poller 仅用 Node 18+ 内置模块（`fs` / `os` / 全局 `fetch`），零 npm 依赖。

### 从本 fork 安装 Claude HUD

```
/plugin marketplace add tsungseu/claude-hud
/plugin install claude-hud
```

### 配置 API key（三选一，优先级从高到低）

- 环境变量 `GLM_API_KEY`，**或**
- `src/providers/glm/config.json` 的 `apiKey`（从 `src/providers/glm/config.example.json` 复制），**或**
- 自动探测：当 `~/.claude/settings.json` 的 `env` 里 `ANTHROPIC_BASE_URL` 指向 `bigmodel` 时，复用 `ANTHROPIC_AUTH_TOKEN`

### 周额度 / 长周期（可选）

GLM 除短窗口 `TOKENS_LIMIT`（~5h，用于 Usage 进度条）外，还有一个长周期窗口 `TIME_LIMIT`（~18 天）。要把它也显示成 claude-hud 的周额度行，在 `src/providers/glm/config.json` 设：

```json
{ "weeklyLimitType": "TIME_LIMIT" }
```

poller 会把该窗口写进 snapshot 的 `seven_day`。要让它**实际显示**，还需在 `~/.claude/plugins/claude-hud/config.json` 调低阈值：

```json
{ "display": { "sevenDayThreshold": 0 } }
```

（默认 80，即用量 ≥80% 才显示；设 `0` 总是显示。）

> 注意：claude-hud 把这行标为 `7d` / `weekly`，且在 `timeFormat: "elapsed"` 下按固定 7 天窗口算已用时长——因此对 GLM 的 ~18 天周期，**百分比准确，但时长和标签是近似**。若要重置倒计时（`resets in 18d`）精确，把 `timeFormat` 改回 `relative`。

### 运行 poller

```bash
npm run glm:poll        # 循环模式，默认每 5 分钟一次
npm run glm:poll:once   # 单次抓取，用于验证 key
```

### 接线状态栏

编辑 `~/.claude/plugins/claude-hud/config.json`：

```json
{
  "display": {
    "externalUsagePath": "/绝对路径/glm-usage-snapshot.json",
    "timeFormat": "elapsed"
  }
}
```

`timeFormat: "elapsed"` 让尾部显示「已用时长 / 窗口总时长」，如 `(1h 30m / 5h)`。poller 在跑时：

```
Usage ██░░░░░░░░ 25% (1h 30m / 5h)
```

### 通过 SessionStart hook 自动启动

本 fork 带一个 `SessionStart` hook（见 `plugin.json`），每次开 Claude Code 会话时执行 `src/providers/glm/poller.mjs --ensure`。`--ensure` 模式先查 PID 文件，仅在**没有常驻实例**时以 detached 方式拉起一个长期运行的进程——跨会话幂等，不会起重复实例。

效果：`/plugin install` 之后，下次开 Claude Code 会话会自动起 poller，随后在后台常驻（会话退出也继续运行）。无需 systemd / launchd / NSSM。

注意：detached 进程**不跨系统重启**——重启后会在下次开 Claude Code 会话时重新拉起。若要真正的 7×24 常驻（如服务器），仍使用下面的服务方案；两者可共存（PID 检测防止重复实例）。

### 作为系统服务常驻（开机自启 + 崩溃自动重启）

loop 模式是常驻进程，重启电脑后需重新拉起。下面按平台给出**开机自启 + 异常自动重启**方案。请把 `NODE`（如 `/usr/bin/node`、`/opt/homebrew/bin/node`）和 `POLLER`（`src/providers/glm/poller.mjs` 的绝对路径）换成你的实际值。

**Linux（systemd user 服务）** — `~/.config/systemd/user/glm-poller.service`：

```ini
[Unit]
Description=GLM quota -> claude-hud bridge poller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=NODE POLLER
Restart=always
RestartSec=10
StartLimitIntervalSec=60
StartLimitBurst=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now glm-poller
loginctl enable-linger $USER        # 注销 / 未登录也常驻
```

`Restart=always` 让进程任何原因退出（崩溃/被杀）都 10 秒后重启；`StartLimitBurst` 限制 60 秒内重启次数，避免崩溃死循环。

**macOS（launchd）** — `~/Library/LaunchAgents/com.glm.poller.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.glm.poller</string>
  <key>ProgramArguments</key>
  <array><string>NODE</string><string>POLLER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/glm-poller.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.glm.poller.plist
```

`KeepAlive=true` 在崩溃后自动拉起。

**Windows** — [NSSM](https://nssm.cc/)（服务化 + 自动重启）：

```cmd
nssm install glm-poller "C:\Program Files\nodejs\node.exe" "C:\path\to\glm\poller.mjs"
nssm set glm-poller AppStdout "C:\Users\YOU\glm-poller.log"
nssm set glm-poller AppStderr "C:\Users\YOU\glm-poller.log"
nssm start glm-poller
```

或用任务计划程序：触发器「登录时」→ 操作启动 `node POLLER` → 设置「失败时重启」。

### 故障排查

状态栏没有 Usage 行时：
1. poller 是否在跑？（`systemctl --user status glm-poller` / `launchctl list | grep glm` / `sc query glm-poller`）
2. 快照是否新鲜？`updated_at` 必须在 `externalUsageFreshnessMs`（默认 5 分钟）内，过期会隐藏。
3. `externalUsagePath` 是否绝对路径？（Windows 反斜杠需转义。）
4. 若同时存在 Claude 订阅的 `rate_limits`，它会优先，外部快照不显示。

poller 报错时旧快照不会被覆盖（失败容错），下一周期自动恢复。

### 安全说明

`src/providers/glm/config.json` 已被 git 忽略。poller 仅向 `https://open.bigmodel.cn` 发请求，`Authorization` 头直接放完整 key（无 `Bearer` 前缀，BigModel 约定）。快照以 `0o600` 权限原子写入，只含百分比与重置时间戳，不含 key。

---

## MiniMax 用量桥接

第二个自带 provider 桥接，位于 `src/providers/minimax/`，与 GLM 同款结构：独立 poller 查询 MiniMax 编程套餐额度 API，写快照供 claude-hud 读取。适用于通过 MiniMax 编程套餐使用 Claude Code 的场景。

- **端点**：`GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（国内）或 `https://api.minimax.io/...`（海外），由 `region`（`"cn"` 默认）选择。
- **鉴权**：`Authorization: Bearer <api key>`。
- **写入内容**：解析 `model_remains["general"]` 为 `five_hour`（5h 桶）和 `seven_day`（周桶，仅当 `current_weekly_status == 1`）。MiniMax 返回剩余%，反转为已用%。

### 配置

key 来源与 GLM 相同（优先级从高到低）：`MINIMAX_API_KEY` 环境变量 > `src/providers/minimax/config.json` 的 `apiKey` > 从 `~/.claude/settings.json` 自动探测（`ANTHROPIC_BASE_URL` 指向 minimax 时复用 token）。region 同样自动探测（`minimax.io` → en，否则 cn）。

### 运行

```bash
npm run minimax:poll        # 循环
npm run minimax:poll:once   # 单次
```

通过同一个 `SessionStart` hook 自动启动（`--ensure` 会同时跑 GLM 和 MiniMax；有 key 的那个会常驻，另一个静默跳过）。

### 接线 claude-hud

使用 MiniMax provider 时，把 `externalUsagePath` 指向 MiniMax 快照（默认路径 `~/.claude/minimax-usage-snapshot.json`）：

```json
{ "display": { "externalUsagePath": "/绝对路径/minimax-usage-snapshot.json" } }
```

要显示周额度行，还需设 `display.sevenDayThreshold: 0`（elapsed 时长近似的注意事项同 GLM 章节，此处同样适用）。

---

## 其他 provider 桥接（Alibaba / Kimi）

`src/providers/` 下还有两个桥接，与 GLM/MiniMax 同款结构：

### Alibaba（百炼 coding plan）

- **鉴权**：API key（Bearer + `x-api-key` + `X-DashScope-API-Key`）。未移植 cookie/web-session 模式。
- **region**：`intl`（modelstudio.console.alibabacloud.com）或 `cn`（bailian.console.aliyun.com）；失败自动回退另一 region。
- **快照**：`~/.claude/alibaba-usage-snapshot.json`；写 `five_hour` + `seven_day`（月度窗口丢弃——claude-hud 没有月度槽位）。
- **key**：`ALIBABA_API_KEY` / `DASHSCOPE_API_KEY` 环境变量 > `config.json` 的 `apiKey` > settings.json 自动探测。

```bash
npm run alibaba:poll        # 循环
npm run alibaba:poll:once   # 单次
```

### Kimi（Moonshot Code API）

- **鉴权**：Kimi **Code API key**（Bearer）。未移植 web/JWT 模式。
- **端点**：`GET {baseURL}/coding/v1/usages`（baseURL 默认 `https://api.kimi.com`）。
- **快照**：`~/.claude/kimi-usage-snapshot.json`；`response.usage`（周）→ `seven_day`，`response.limits[0]`（5h 速率限制）→ `five_hour`。
- **key**：`KIMI_CODE_API_KEY` 环境变量 > `config.json` 的 `apiKey` > settings.json 自动探测。

```bash
npm run kimi:poll        # 循环
npm run kimi:poll:once   # 单次
```

两者都通过 `SessionStart` hook 自动启动（有 key 的那个常驻）。切换 provider 时，把 `display.externalUsagePath` 指向对应快照，并设 `display.sevenDayThreshold: 0` 显示周额度行（elapsed 近似注意事项同 GLM）。

---

## 运行环境要求

- Claude Code v1.0.80+
- macOS/Linux：Node.js 18+ 或 Bun
- Windows：Node.js 18+

---

## 开发

```bash
git clone https://github.com/tsungseu/claude-hud
cd claude-hud
npm ci && npm run build
npm test
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)

---

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=tsungseu/claude-hud&type=Date)](https://star-history.com/#tsungseu/claude-hud&Date)
