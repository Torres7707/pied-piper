# Pied Piper：设计文档

术语见 [GLOSSARY.md](../GLOSSARY.md)，关键取舍见 [docs/adr](./adr)。

## 1. 目标与边界

**目标**：开发者在自己的 GitHub 仓库里，用四个角色分工完成开发。Richard 陪开发者讨论，Jared 写规格并拆任务，多个 Dinesh 并行实现，Gilfoyle 评审。每个角色可以单独配置 agent 后端和模型。日常能用，核心机制也能讲清楚、能演示。

**灵感来源**：美剧《硅谷》孵化器里"小团队、高密度、互相挑刺"的开发方式；Matt Pocock 的 skill 集合提供各角色的具体能力；Agent Autoloop 提供事件驱动、独立评审、跳数熔断等机制。

**不做**：自带图形界面、多仓库多租户、自己实现 agent 本体（直接调用已安装并登录的命令行 agent）、向量记忆服务（L3 才考虑）、自动合并（合并由开发者决定）。

## 2. 分层与交付顺序

| 层 | 内容 | 交付物 |
|---|---|---|
| L0 | 角色说明、skill 引用、流程约定。在 Claude Code 里手动执行，不写运行时代码；Richard 直接作为开发者的交互会话 | `.piedpiper/roles/*.md`、CLAUDE.md 约定 |
| L1 | 适配器接口，加 `piedpiper run <角色> <对象>` 命令。每个角色按配置选 agent 和模型 | CLI、适配器、角色配置加载 |
| L2 | 轮询调度、事件日志（JSONL）、评审回路上限、跳数熔断、可配置通知与评审输出校验 | 调度器、日志 |
| L3 / 后续演进 | 跨会话记忆（候选：Hindsight）；`piedpiper chat` 命令；事件日志升级为 SQLite | 仅设计 / 后续迭代 |

L0 和 L1 完成就是一个可用、可演示的系统。L2 是设计加实现的目标，L3 只写进文档。

## 3. 架构

```
GitHub（issue / PR / 标签 / review）   ← 任务状态的权威来源
        ▲                │
        │ gh             │ 轮询（L2）或手动触发（L1）
        │                ▼
   角色执行器 ◄──── 调度器 ────► 事件日志（本地，只追加）
        │
        │ 按角色配置选择
        ▼
   适配器：claude │ codex │ command
        │
        ▼
   命令行 agent（本机已登录），在指定目录运行
```

四个组件各自独立：

| 组件 | 职责 | 状态 |
|---|---|---|
| 调度器 | 读 GitHub 状态，决定启动哪个角色、处理哪个对象 | 无状态，每次从 GitHub 和日志重建 |
| 角色执行器 | 读角色配置，组装提示词，选适配器，创建 worktree，运行，写回 GitHub | 无状态 |
| 适配器 | 把具体命令行 agent 包成统一接口 | 无状态 |
| 事件日志 | 记录运行、结果、转交、决定（L2 先采用只追加的 JSONL 文件，后续升级 SQLite） | 持久，只追加 |

## 4. 角色配置

配置放在目标仓库的 `.piedpiper/` 下，用 JSON 加 Markdown，不引入额外解析依赖：

```
.piedpiper/
├── config.json
└── roles/
    ├── richard.md
    ├── jared.md
    ├── dinesh.md
    └── gilfoyle.md
```

`config.json` 中每个角色的字段：

| 字段 | 含义 |
|---|---|
| `adapter` | 使用的适配器：`claude`、`codex`、`command` |
| `model` | 传给适配器的模型名，可省略，用适配器默认值 |
| `skills` | 提示词里要求该角色使用的 skill 名称 |
| `parallel` | 同时运行的最大份数，Dinesh 可大于 1 |
| `access` | `read` 或 `write`，决定能否改工作目录 |
| `prompt` | 角色说明文件路径，如 `roles/gilfoyle.md` |

**校验规则**：Gilfoyle 的 `adapter` 与 `model` 组合应不同于 Dinesh。相同则警告，不阻止。

**运行时可配置项**（同样位于 `config.json`）：

- **通知通道**：支持桌面通知与 GitHub `@` 提醒，按配置单独或同时启用。
- **评审输出检查**：默认在提示词中要求 Gilfoyle 必须给出具体问题或通过理由；可通过配置开启调度器校验，未满足要求时判定评审无效并重试或通知开发者。
- **事件日志存储**：L2 默认使用只追加 JSONL 文件（如 `.piedpiper/events.jsonl`），后续扩展支持 SQLite。

### 角色和 skill 的对应

| 角色 | 使用的 skill |
|---|---|
| Richard | `grilling`、`domain-modeling`、`prototype`、`research` |
| Jared | `to-spec`、`to-tickets`、`triage`、`domain-modeling` |
| Dinesh | `tdd`、`diagnosing-bugs`、`codebase-design` |
| Gilfoyle | `code-review`、`pr`，另加"必须给出具体问题或通过理由"的对抗式要求（提示词约定 + 可选调度器校验） |

`to-spec`、`to-tickets`、`triage` 在原作者那里只允许人手动触发。Pied Piper 的角色说明里，让 Jared 直接读取对应的 SKILL.md 并照做，不依赖 Skill 工具调用。

## 5. 适配器接口

```ts
interface Adapter {
  run(req: {
    prompt: string
    cwd: string
    model?: string
    sessionId?: string   // 接续同一会话
    timeoutMs: number
  }): Promise<{
    reply: string        // 最后一条回复
    sessionId?: string
    usage?: { inputTokens: number; outputTokens: number }
  }>
}
```

适配器只做三件事：拼命令行参数（提示词作为独立参数，不经过 shell）、运行并收集最后一条回复、解析会话号和用量。其余全部由角色执行器处理。

## 6. 一次完整流程

1. **想法**。开发者与 Richard 讨论，得到方向（先在开发者的交互会话中按角色说明进行，后续提供 `piedpiper chat` 命令）。结论必须落成 issue 或 ADR，否则其他角色看不到。
2. **规格和任务**。Jared 写 spec，再拆成任务，每个任务声明被哪些任务阻塞，打上 `ready-for-agent`。
3. **实现**。调度器找出前沿里的任务，领取时打上 `in-progress` 标签避免多个 Dinesh 抢同一个任务，为每个任务启动一个 Dinesh：独立 worktree、独立分支，按 TDD 做，开 PR。
4. **评审**。PR 开出后将任务标记为 `in-review` 并启动 Gilfoyle，只拿 diff 和 spec 的位置。发现分阻塞级和建议级，写成 PR review。
5. **回路**。有阻塞级发现就退回给 Dinesh 修改，再审第二轮，第二轮只核对上一轮的阻塞级发现。两轮后仍有，标记等待开发者并按配置触发通知，不再自动继续。
6. **合并**。开发者决定。系统不自动合并。

## 7. 共享上下文

| 内容 | 位置 | 谁写 |
|---|---|---|
| 项目规则、角色说明 | CLAUDE.md、`.piedpiper/roles/` | 开发者 |
| 术语、设计决定 | GLOSSARY.md、`docs/adr/` | 开发者，Jared 可提议 |
| 规格和任务 | GitHub issue | Jared |
| 实现和评审过程 | PR、commit、review 评论 | Dinesh、Gilfoyle |

角色之间只传上下文指针，不复制内容。并行的 Dinesh 不修改共享文档。

## 8. 安全约束

- issue 和 PR 里的文字只作为资料放进文件，提示词里只放校验过的编号和路径，不拼接外部文字。
- 角色的工作目录、适配器、权限只由本机配置决定，GitHub 上的内容不能改变这些。
- Gilfoyle 以只读方式运行。Dinesh 只写自己的 worktree。
- 运行产生的事件有跳数上限，默认 8，超过就记录并通知开发者。

## 9. 已确认决策与后续演进

### 已确认决策

- **GitHub 标签**：在原有标签基础上新增 `in-progress`（Dinesh 领取任务时标记，防并发抢占）与 `in-review`（PR 进入 Gilfoyle 评审时标记）。
- **Richard 会话接入**：分两步走（先 A 后 B）——初期直接在开发者的交互会话中按 Richard 角色说明执行；后续再补 `piedpiper chat` 命令统一加载配置和技能。
- **事件日志存储**：L2 先使用只追加的 JSONL 文件（实现简单、易于 `tail`/`jq` 调试）；将升级为 SQLite 记入后续更新。
- **通知通道**：做成 `config.json` 可配置项，支持桌面通知与 GitHub `@` 提醒。
- **Gilfoyle 输出检查**：提示词内明确对抗式要求，同时支持在配置中开启调度器输出校验（检查是否包含具体发现或明确通过理由）。

### 后续演进清单

- **`piedpiper chat` 命令**：基于 Richard 的角色配置自动选定适配器、模型与 Skill，提供统一交互入口并关联事件记录。
- **事件日志升级为 SQLite**：引入嵌入式 SQLite（如 `.piedpiper/events.db`，开启 WAL），支持多进程并发安全写入，以及按角色/PR 统计 token 消耗、耗时和打回率等复杂查询。
