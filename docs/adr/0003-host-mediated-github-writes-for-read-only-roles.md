# 只读角色的 GitHub 写入由宿主进程通过 GitHubPort 代理执行

Richard 和 Jared 的权限范围固定为 `access: "read"`，适配器在调用底层命令行工具时强制启用只读沙箱（Claude Code 的 `--permission-mode plan`、Codex 的 `-s read-only`）。只读角色不在子进程内直接执行 `gh issue create` 或写本地文件；当需要将讨论结论落盘为 GitHub issue，或将规格（Spec）拆分为带原生父子关系与阻塞依赖的任务（Ticket）时，角色只输出结构化内容，由 `piedpiper` 宿主进程校验后通过 `GitHubPort` 统一写入 GitHub。

原因：如果为了让 Richard 或 Jared 创建 issue 而放开底层 CLI 的 shell 执行权限，就无法在沙箱层阻止它们误改本地源码或越权操作任务板；由宿主进程集中代理 GitHub 写入，既守住了只读角色对工作区的物理隔离，又能由宿主统一保证父子挂载、`blockedBy` 依赖边与 `ready-for-agent` 标签的一致性，并复用同一套 `GitHubPort` 测试接缝。

## Considered Options

- 放开 Richard 和 Jared 的适配器写入权限，让它们在子进程内自己调用 `gh issue create` 或写 `docs/adr/`：提示词虽可约定"不改代码"，但失去了底层 CLI 只读沙箱的硬约束，且无法通过内存 `GitHubPort` 接缝对建单与拆任务流程做确定性行为测试。
- 要求开发者手工复制终端输出再去跑 `gh issue create`：破坏了在 `piedpiper` 交互会话内从想法讨论到 `/issue`、`/jared`、`/dispatch` 一键衔接的闭环体验。

## Consequences

- Richard 与 Jared 始终运行在只读沙箱中，永远不会污染本地源码树。
- `GitHubPort` 契约需覆盖创建 issue、挂载原生 sub-issue、建立原生 `blockedBy` 阻塞边与幂等同步状态标签（依然绝不暴露合并 PR 的能力）。
- Jared 的角色说明与运行器需约定末尾结构化任务图 JSON 输出格式，宿主负责解析、拓扑校验并按依赖顺序调用 `GitHubPort` 落盘。
