# Pied Piper

一个用多个角色分工协作的 coding agent 系统。开发者和 Richard 讨论想法，Jared 把想法拆成任务，多个 Dinesh 并行实现，Gilfoyle 评审。每个角色可以单独配置用哪个 agent 和模型。状态记在 GitHub 上。

## 角色

**角色（Role）**:
系统里一类职责的配置，包含职责说明、使用的 agent 后端、模型、预载的 Skill、可用工具和读写范围。角色是配置，不是进程。
_Avoid_: agent, 子智能体

**Richard**:
陪开发者讨论想法的角色。每次讨论至少给出三个不同方向并说明代价，最终决定由开发者做。不写代码，不改任务板。
_Avoid_: 产品经理, 顾问

**Jared**:
把讨论结果写成 spec，再拆成带阻塞关系的任务（Ticket）的角色。
_Avoid_: planner, 规划者

**Dinesh**:
实现一个任务的角色。每个任务一个 worktree、一个分支、一个 PR。可以同时运行多份。
_Avoid_: builder, 开发者, worker

**Gilfoyle**:
评审 PR 的角色。只看 diff 和 spec，不看 Dinesh 的推理过程，必须给出具体问题或明确的通过理由。
_Avoid_: reviewer, 审查员

**开发者（Developer）**:
使用 Pied Piper 的人。决定方向、合并 PR、处理两轮后仍未解决的发现。
_Avoid_: 用户, owner

## 工作流

**想法（Idea）**:
开发者和 Richard 讨论的起点，尚未落成任务。
_Avoid_: 需求, 提案

**规格（Spec）**:
Jared 根据讨论写出的目标和验收标准，发布在 GitHub issue 上。
_Avoid_: PRD, 需求文档

**任务（Ticket）**:
从规格拆出的一个垂直切片，足够小，一个 Dinesh 能在一个上下文窗口内做完。声明被哪些任务阻塞。
_Avoid_: issue, 子任务

**前沿（Frontier）**:
所有阻塞任务都已完成、可以立刻领取的任务集合。
_Avoid_: 待办队列

**评审发现（Finding）**:
Gilfoyle 提出的一条具体问题，含文件、行号、依据和级别。
_Avoid_: comment, 评论

**阻塞级（Blocking）**:
会挡住合并的发现级别。另一个级别是建议级（Advisory），不挡合并。
_Avoid_: critical, 严重

**评审轮次（Review Round）**:
Gilfoyle 评审，加 Dinesh 修改的一遍。一个 PR 最多两轮，两轮后仍有阻塞级发现就交给开发者决定。
_Avoid_: iteration, 迭代

## 运行时

**适配器（Adapter）**:
把一个具体的命令行 agent 接入系统的最小接口：收到提示词和工作目录，返回最后一条回复。Claude Code、Codex 各有一个，另有通用命令适配器。
_Avoid_: 插件, driver, provider

**运行（Run）**:
一次角色执行：某个角色，通过某个适配器，在某个目录里，处理某个任务或 PR，直到结束。
_Avoid_: job, 会话, task

**调度器（Dispatcher）**:
读取 GitHub 状态，决定该启动哪个角色处理哪个对象的组件。自己不写代码也不评审。
_Avoid_: 编排器, orchestrator, scheduler

**事件日志（Event Log）**:
本地只追加的记录，每次运行的开始、结果、转交和决定都写在里面，用来回答"这一轮为什么跑"。GitHub 是任务状态的权威来源，日志只用于追溯。
_Avoid_: 审计日志, history

**跳数（Hops）**:
一次运行产生的新事件再触发运行时的累计层数。超过上限就只记录，不再派活，并通知开发者。
_Avoid_: 深度, depth

## 上下文

**上下文指针（Context Pointer）**:
传给角色的是 spec、任务、ADR、commit 的位置，不是它们的内容副本。
_Avoid_: 上下文传递, handoff
