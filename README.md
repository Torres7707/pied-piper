# Pied Piper

用多个角色分工协作的 coding agent 运行时，灵感来自《硅谷》里的孵化器。任务状态权威地记录在 GitHub（issue、标签、原生阻塞关系与 PR review）上，每个角色可独立配置 CLI 适配器后端和模型。

| 角色 | 职责 | 权限 | 典型 Skill |
|---|---|---|---|
| **Richard** | 陪开发者讨论想法，每次至少给出三个不同方向与代价，结论落盘 | `read` | `grilling`、`domain-modeling`、`prototype`、`research` |
| **Jared** | 编写规格（Spec），拆分为带原生阻塞关系的垂直切片任务并打 `ready-for-agent` | `read` | `to-spec`、`to-tickets`、`triage`、`domain-modeling` |
| **Dinesh** | 在独立 `git worktree` 中按 TDD 实现单个前沿任务并开 PR | `write` | `tdd`、`diagnosing-bugs`、`codebase-design` |
| **Gilfoyle** | 盲审隔离、严格只读地对抗式评审 PR，必须给出具体发现或明确通过理由 | `read` | `code-review`、`pr` |

> **当前状态**：L0 角色规范、L1 单角色运行器（`piedpiper run`）与 L2 无状态调度器（`piedpiper dispatch`）均已在 `main` 就绪。完整设计见 [docs/DESIGN.md](docs/DESIGN.md)，术语表见 [GLOSSARY.md](GLOSSARY.md)，仓库规则见 [CLAUDE.md](CLAUDE.md)。

---

## 一、环境准备与安装（Installation）

### 1. 前置依赖

在使用 `piedpiper` 之前，请确保本机已安装并配置好以下工具：

- **Node.js**（推荐 `22+`，本项目开发与测试基于 Node `24`）与 **pnpm**
- **git**
- **GitHub CLI（`gh`）**：需先登录（`gh auth login`），且目标仓库已配置 GitHub `origin` remote（涉及原生 sub-issue 与阻塞依赖时建议 `gh` 2.94+）
- **至少一个本机已登录的命令行 Coding Agent**：
  - `claude`（Claude Code CLI，对应 `adapter: "claude"`）
  - `codex`（OpenAI Codex CLI，对应 `adapter: "codex"`）
  - 或任意自定义本地命令（对应 `adapter: "command"`）
- **（可选）角色 Skill 文档**：各角色提示词会引导按需读取 `~/.claude/skills/<skill>/SKILL.md`（如 `to-spec`、`to-tickets`、`triage`、`tdd`、`code-review` 等）。

### 2. 克隆、构建与测试

```bash
git clone https://github.com/Torres7707/pied-piper.git
cd pied-piper

pnpm install
pnpm typecheck
pnpm build
pnpm test
```

确认编译产物可执行：

```bash
node dist/cli.js --help
```

### 3. 注册全局命令（可选，推荐）

`package.json` 已声明 `"bin": { "piedpiper": "./dist/cli.js" }`。执行全局链接后，即可在任意目标仓库中直接运行 `piedpiper`：

```bash
# 在 pied-piper 仓库根目录执行（npm 或 pnpm 任选其一）
npm link
# 或：pnpm link --global

# 验证命令可用
piedpiper --help
```

> 如果不做全局链接，后续教程中的所有 `piedpiper ...` 命令都可以直接替换为 `node /path/to/pied-piper/dist/cli.js ...`。

---

## 二、初始化目标仓库

要让 Pied Piper 管理你自己的 GitHub 仓库，需要准备**本地配置文件**与**GitHub 标签**。

### 1. 准备 `.piedpiper/` 配置目录

将本仓库的 `.piedpiper/` 模板复制到你的目标仓库根目录：

```text
<your-repo>/
└── .piedpiper/
    ├── config.json          # 角色与运行时配置（纯 JSON）
    └── roles/
        ├── richard.md       # Richard 角色说明
        ├── jared.md         # Jared 角色说明
        ├── dinesh.md        # Dinesh 角色说明
        └── gilfoyle.md      # Gilfoyle 角色说明
```

默认 [`.piedpiper/config.json`](.piedpiper/config.json) 关键字段如下：

#### `roles.<name>`（角色配置）

| 字段 | 含义 | 默认模板示例 |
|---|---|---|
| `adapter` | `claude`、`codex` 或 `command` | Dinesh 用 `claude`，Gilfoyle 用 `codex` |
| `model` | 传给适配器的模型名（可省略，省略时用适配器默认值） | `claude-sonnet-5-5` / `gpt-5-codex` |
| `skills` | 注入提示词的 Skill 名称列表 | `["tdd", "diagnosing-bugs", "codebase-design"]` |
| `parallel` | 最大并行数（整数 `>= 1`） | Dinesh 为 `2`，其余为 `1` |
| `access` | `read`（只读）或 `write`（允许写独立 worktree） | Dinesh 为 `write`，其余为 `read` |
| `prompt` | 角色说明路径（相对于 `.piedpiper/`，且不能逃逸仓库根目录） | `"roles/dinesh.md"` |
| `command` | 仅当 `adapter` 为 `"command"` 时必填，非空字符串或字符串数组 | `["my-agent", "--flag"]` |

> **同组合警告原则（重要）**：为了保证独立对抗式评审，默认将 **Dinesh**（`claude` / `claude-sonnet-5-5`）与 **Gilfoyle**（`codex` / `gpt-5-codex`）设为不同的 `(adapter, model)` 组合。如果两者配置完全相同，加载配置时会打印警告（不阻断运行），提示独立评审效力可能下降。

#### `runtime`（运行时配置，可省略并按默认值填充）

| 配置路径 | 默认值 | 说明 |
|---|---|---|
| `notifications.desktop` | `true` | 是否发送系统桌面通知（macOS 使用 `osascript`，Linux 使用 `notify-send`） |
| `notifications.githubMention` | `false` | 是否在需要人工介入时在 GitHub issue/PR 下 `@` 评论提醒 |
| `notifications.githubHandle` | `""` | GitHub `@` 账号（开启 `githubMention: true` 时必填） |
| `review.maxRounds` | `2` | 单个 PR 的最大自动评审回路轮次 |
| `review.validateOutput` | `true` | 是否启用 Gilfoyle 输出结构化校验（拦截“LGTM”等空泛放行） |
| `dispatcher.maxHops` | `8` | 事件链跳数熔断上限，防止无限循环 |
| `dispatcher.pollIntervalSec` | `60` | `piedpiper dispatch --poll` 的默认轮询间隔（秒） |
| `eventLog.type` | `"jsonl"` | 事件日志格式（当前支持 `"jsonl"`） |
| `eventLog.path` | `".piedpiper/events.jsonl"` | 只追加事件日志路径（须位于仓库根目录内） |

### 2. 配置 `.gitignore`

运行时会产生本地日志与只读临时资料文件，建议在目标仓库 `.gitignore` 中加入：

```gitignore
.piedpiper/events.jsonl
.piedpiper/tmp/
```

### 3. 创建 GitHub 状态标签

`piedpiper` 使用 GitHub 标签流转任务状态。请在目标仓库中先创建好以下标签（已存在时 `--force` 可幂等更新）：

```bash
gh label create ready-for-agent --color 0e8a16 --description "Fully specified, ready for an AFK agent" --force
gh label create in-progress    --color fbca04 --description "Claimed by a Dinesh run" --force
gh label create in-review      --color 5319e7 --description "PR opened and handed over to Gilfoyle for review" --force
gh label create ready-for-human --color d93f0b --description "Requires human decision or implementation" --force
gh label create needs-triage    --color c2e0c6 --description "Maintainer needs to evaluate this issue" --force
gh label create needs-info      --color d4c5f9 --description "Waiting on reporter for more information" --force
gh label create wontfix         --color ffffff --description "Will not be actioned" --force
```

---

## 三、完整使用教程（从想法到 PR 合并）

下面以“在一个已配置 `.piedpiper/` 的仓库中开发新功能”为例，串起完整开发闭环。

### 第 1 步：与 Richard 讨论想法（Idea → 已拍板方向）

Richard 负责帮你澄清需求、比较至少 **3 个实质不同的方向与代价**，**不会写代码也不会改动任务板**。

- **方式 A（推荐，交互式会话）**：在你的 Claude Code / 终端交互会话中指示它：
  > 读取 `.piedpiper/roles/richard.md`、`GLOSSARY.md` 和 `docs/adr/`，我想实现 `<你的想法>`，请按 Richard 的规则与我讨论。
- **方式 B（通过 CLI 单次调用）**：如果你已经有一个初步想法 issue（例如 `#10`）或文档路径，也可以直接运行：
  ```bash
  piedpiper run richard "#10" --repo /path/to/your-repo
  ```

你拍板选定方向后，让 Richard 把结论落盘为 **GitHub issue**（例如 `#10`）或 **`docs/adr/NNNN-*.md` 文档**——后续角色只通过指针消费结果。

---

### 第 2 步：由 Jared 编写 Spec 并拆分 Ticket（Spec → Tickets）

将第 1 步落盘的上下文指针交给 Jared，让它产出规范的 Spec 与可并行领取的垂直切片任务：

```bash
piedpiper run jared "#10" --repo /path/to/your-repo
```

（若当前未配置自动写入权限或希望交互确认，也可新开会话读取 `.piedpiper/roles/jared.md` 手动驱动。）

Jared 会按以下结构在 GitHub 上创建任务图：
1. 发布父 **Spec** issue（例如 `#11`）并打上 `ready-for-agent`。
2. 拆分为多个垂直切片 **Ticket**（例如 `#12`、`#13`、`#14`），挂为 `#11` 的原生 sub-issue，并通过 `--blocked-by` 声明前置依赖（例如 `#14` 被 `#12` 阻塞），全部打上 `ready-for-agent`。

> 注意：带有未关闭子任务的父 Spec（如 `#11`）以及被未关闭 Ticket 阻塞的下游任务（如 `#14`），都不会被调度器提前派发；只有当前无未关闭阻塞的**前沿（Frontier）**任务（如 `#12`、`#13`）会被领取。

---

### 第 3 步：启动调度器自动实现与对抗式评审（L2 推荐用法）

一切任务就绪后，你可以运行一次单周期试跑，或开启持续轮询：

```bash
# 单次调度一个完整周期（推荐初次试跑使用）
piedpiper dispatch --once --repo /path/to/your-repo

# 持续轮询（按 config.json 中的 pollIntervalSec，或通过 --interval 覆盖）
piedpiper dispatch --poll --interval 60 --repo /path/to/your-repo
```

`piedpiper dispatch` 是完全无状态的，每次启动都会从 GitHub 实时重建现状，并自动执行以下闭环：

1. **计算前沿并防抢占标记**：找出所有前沿 Ticket，按 `roles.dinesh.parallel` 上限领取，并在启动 Dinesh 前立即为任务打上 `in-progress` 标签。
2. **Worktree 隔离开发（Dinesh）**：
   - 为每个任务创建独立工作区 `../<repo>-worktrees/ticket-<n>` 与分支 `ticket/<n>`（如后续进入第 2 轮修改则复用同一 worktree）。
   - 将外部 issue / Spec 正文落盘为 `.piedpiper/tmp/...` 下的只读（`0o444`）资料文件，提示词仅传校验过的编号与本地路径，防止 Prompt 注入越权。
   - Dinesh 按 TDD 实现并提交推送后，自动创建指向默认分支的 PR（正文包含 `Closes #<n>`）。
3. **转交盲审（Gilfoyle）**：
   - PR 创建后，调度器自动把 Ticket 标签从 `in-progress` 切换为 `in-review`。
   - 为 Gilfoyle 准备 PR diff 与关联 Spec/Ticket 指针文件（屏蔽 Dinesh 的推理与会话历史），以严格只读模式运行并提交 PR Review。
4. **评审输出校验与有限轮次回路（默认 `maxRounds = 2`）**：
   - 开启 `runtime.review.validateOutput: true` 时，空泛放行（如 `LGTM`、“代码整体清晰，通过”）或缺少 `file:line` / 依据 / 级别的发现会被判定为 `review.invalid` 并触发重试；重试仍无效则停止自动派发并升级人工处理。
   - **无阻塞级发现 / 仅含建议级（Advisory）发现**：结束自动修改回路，**不退回 Dinesh，也绝不自动合并 PR**。
   - **第 1 轮存在阻塞级（Blocking）发现**：将阻塞级发现整理为上下文文件退回原 worktree 的 Dinesh 修复并推送；第 2 轮 Gilfoyle 仅针对第 1 轮遗留的阻塞级发现做定点复核。
   - **第 2 轮后仍存在阻塞级发现**：停止自动派发，移除 `in-review` / `in-progress` 并打上 `ready-for-human`，写入 `review.escalated` 事件，并按 `runtime.notifications` 发送桌面通知或 GitHub `@` 评论提醒。
5. **跳数熔断（Hop Circuit Breaker）**：
   - 当事件链累计跳数达到 `runtime.dispatcher.maxHops`（默认 `8`）时，调度器记录 `dispatcher.halted`、发送通知并安全中止（可用 `--hop <n>` 显式指定初始跳数）。

---

### 第 4 步：单步手动运行指定角色（L1 调试 / 点对点触发）

当你只想单独运行某个角色（例如调试提示词、单独重跑某个 Ticket 或手工评审某个 PR），可以使用 `piedpiper run`：

```bash
# 让 Dinesh 在独立 worktree 中实现或修复 Ticket #12
piedpiper run dinesh "#12" --repo /path/to/your-repo

# 让 Gilfoyle 独立盲审 PR #25 并发表 PR Review
piedpiper run gilfoyle "PR #25" --repo /path/to/your-repo

# 恢复 Dinesh 之前的适配器会话（注意：Gilfoyle 盲审会主动忽略传入的 --session）
piedpiper run dinesh "#12" --session <session-id> --repo /path/to/your-repo

# 调整单次超时时间（默认 300000 ms，即 5 分钟）
piedpiper run dinesh "#12" --timeout 600000 --repo /path/to/your-repo
```

---

### 第 5 步：查看运行日志、人工合并与清理

#### 1. 查看 JSONL 事件日志

所有执行起止、标签流转、评审拦截/升级、熔断与通知都会以只追加形式写入 `.piedpiper/events.jsonl`：

```bash
# 实时观察事件流
tail -f .piedpiper/events.jsonl

# 用 jq 统计各角色运行情况与 token 用量
jq -c '{ts: .timestamp, type, role, target, status, usage, decision}' .piedpiper/events.jsonl
```

#### 2. 开发者审核并手动合并 PR

**Pied Piper 永远不会自动合并 PR。** 当 PR 评审通过（或仅剩建议级意见）后：
1. 在 GitHub 上审阅 diff、CI 与 Gilfoyle 的 PR Review。
2. 确认无误后手动合并 PR（PR 正文里的 `Closes #<n>` 会自动关闭对应 Ticket，从而解锁下游被阻塞的 Ticket）。
3. 如果某任务被打上了 `ready-for-human`，人工解决后可手动合并或重新调整标签交回流程。

#### 3. 清理本地 worktree 与分支

PR 合并后，清理对应任务的 worktree 与分支：

```bash
git worktree remove ../<repo>-worktrees/ticket-<n>
git branch -d ticket/<n>
```

---

## 四、CLI 命令速查

```text
Usage:
  piedpiper run <role> <target> [--repo <path>] [--cwd <path>] [--timeout <ms>] [--session <id>]
  piedpiper dispatch [--once | --poll] [--interval <sec>] [--hop <n>] [--repo <path>] [--timeout <ms>]

Options:
  --repo <path>      包含 .piedpiper/config.json 的仓库路径（默认：当前工作目录）
  --cwd <path>       传给适配器的工作目录（默认：仓库根目录；Dinesh 处理 issue 时会自动切到独立 worktree）
  --timeout <ms>     适配器单次执行超时毫秒数（默认：300000）
  --session <id>     可选，恢复既有会话 ID（Gilfoyle 盲审时忽略）
  --once             执行单次调度周期（dispatch 默认模式）
  --poll             按 pollIntervalSec 持续轮询调度
  --interval <sec>   覆盖轮询间隔秒数
  --hop <n>          指定调度器初始事件链跳数
  -h, --help         显示帮助信息
```

---

## 五、不运行 CLI 时的纯手动方式（L0）

如果暂时不想启动 `piedpiper` 调度器，也可以完全按照 `.piedpiper/roles/*.md` 中的 **L0 手动执行清单**，在多个独立终端会话中手动推进流程：

1. **Richard**：当前会话读取 `.piedpiper/roles/richard.md`、`GLOSSARY.md`、`docs/adr/`，讨论并落盘 issue / ADR。
2. **Jared**：新开会话读取 `.piedpiper/roles/jared.md`，产出 Spec 与带 `--blocked-by` 的 `ready-for-agent` Ticket。
3. **Dinesh**：用 `gh issue list --state open --label ready-for-agent` 找前沿任务，先 `gh issue edit <n> --add-label in-progress`，再用 `git worktree add ../pied-piper-ticket-<n> -b ticket/<n> main` 开独立工作区，按 TDD 实现并开 PR 后转为 `in-review`。
4. **Gilfoyle**：在**不同模型或全新只读会话**中用 `gh pr diff <pr> > /tmp/pr-<pr>.diff` 导出 diff，读取 `.piedpiper/roles/gilfoyle.md` 盲审并用 `gh pr review <pr> --comment --body "..."` 提交结论；最多两轮阻塞级返工，未收敛打 `ready-for-human`，最终由开发者手动合并。
