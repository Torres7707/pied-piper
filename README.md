# Pied Piper

用多个角色分工协作的 coding agent 系统，灵感来自《硅谷》里的孵化器。

| 角色 | 职责 | 权限 | 典型 Skill |
|---|---|---|---|
| Richard | 陪开发者讨论想法，每次至少给出三个方向与代价 | `read` | `grilling`、`domain-modeling`、`prototype`、`research` |
| Jared | 写规格，拆分为带阻塞关系的任务并打 `ready-for-agent` | `read` | `to-spec`、`to-tickets`、`triage`、`domain-modeling` |
| Dinesh | 在独立 worktree 中按 TDD 实现单个任务并开 PR | `write` | `tdd`、`diagnosing-bugs`、`codebase-design` |
| Gilfoyle | 只读对抗式评审 PR，必须给出具体问题或明确通过理由 | `read` | `code-review`、`pr` |

每个角色可以单独配置适配器后端和模型，任务状态权威地记录在 GitHub（issue、标签、原生阻塞关系与 PR review）上。

**当前状态**：L0 角色规范与初始配置模板已就绪；L1/L2 运行时正在按 [设计文档](docs/DESIGN.md) 推进。完整领域术语见 [GLOSSARY.md](GLOSSARY.md)。

---

## 配置结构（`.piedpiper/`）

```text
.piedpiper/
├── config.json          # 角色与运行时配置（纯 JSON）
└── roles/
    ├── richard.md       # Richard 角色说明
    ├── jared.md         # Jared 角色说明
    ├── dinesh.md        # Dinesh 角色说明
    └── gilfoyle.md      # Gilfoyle 角色说明
```

### `roles.<name>` 字段说明

| 字段 | 含义 | 说明 |
|---|---|---|
| `adapter` | 适配器类型 | `claude`、`codex` 或 `command` |
| `model` | 模型名称 | 可选；省略时使用对应适配器的默认模型 |
| `skills` | Skill 列表 | 角色需要遵循的 Skill 名称列表 |
| `parallel` | 最大并行度 | 允许同时运行的份数（Dinesh 可大于 `1`，其余通常为 `1`） |
| `access` | 读写权限 | `read`（只读）或 `write`（允许修改独立 worktree） |
| `prompt` | 角色说明路径 | 相对于 `.piedpiper/` 的路径，如 `roles/gilfoyle.md` |

> **同组合警告原则（重要）**：模板默认将 **Dinesh**（`claude` / `claude-sonnet-5-5`）与 **Gilfoyle**（`codex` / `gpt-5-codex`）设为不同的适配器与模型组合，以保证独立对抗式评审。如果你在项目中将两者的 `(adapter, model)` 设为完全相同，L1/L2 运行时会在加载配置时输出明确警告（不阻断运行），提醒你独立评审效力可能下降；在 L0 手动执行时也应主动切换到不同的模型或全新隔离会话来扮演 Gilfoyle。

### `runtime` 配置项说明

- `notifications`：`desktop`（桌面通知开关）、`githubMention`（GitHub `@` 提醒开关）与 `githubHandle`（启用 `@` 提醒时的开发者账号）。
- `review`：`maxRounds`（单 PR 最大评审轮次，默认 `2`）、`validateOutput`（是否校验 Gilfoyle 必须给出具体评审发现或明确通过理由）。
- `dispatcher`：`maxHops`（事件链跳数熔断上限，默认 `8`）、`pollIntervalSec`（轮询间隔秒数）。
- `eventLog`：`type`（L2 为 `"jsonl"`）、`path`（默认 `".piedpiper/events.jsonl"`）。

---

## L0 手动端到端协作流程

在还没有运行 `piedpiper` 调度器之前，开发者可以直接按以下步骤在本地手动跑通完整协作闭环：

### 第 1 步：与 Richard 讨论想法（Idea → 已拍板方向）

1. 在你自己的交互式会话中，让当前对话读取 [`.piedpiper/roles/richard.md`](.piedpiper/roles/richard.md)、[GLOSSARY.md](GLOSSARY.md) 和相关 [ADR](docs/adr)。
2. 说明你的想法。Richard 会提出**至少 3 个不同方向**并说明代价，但**不会写代码也不会改任务板**。
3. 由你最终拍板选择方向，并让 Richard 将结论落盘为一个 GitHub issue（`gh issue create`）或新的 `docs/adr/NNNN-*.md` 文档，得到明确的上下文指针。

### 第 2 步：由 Jared 编写规格并拆分为任务（Spec → Tickets）

1. 新开一个交互会话，指示其扮演 **Jared** 并读取 [`.piedpiper/roles/jared.md`](.piedpiper/roles/jared.md)。
2. 只向 Jared 传递第 1 步结论的上下文指针（issue 编号或 ADR 路径）。
3. Jared 会**直接读取** `~/.claude/skills/to-spec/SKILL.md`、`~/.claude/skills/to-tickets/SKILL.md`、`~/.claude/skills/triage/SKILL.md`、`~/.claude/skills/domain-modeling/SKILL.md` 与 `docs/agents/*.md`：
   - 先发布 **Spec** issue 并打上 `ready-for-agent` 标签；
   - 再拆分为垂直切片 **Ticket**，挂为父 Spec 的 sub-issue（`gh issue create --parent <spec>`）、声明原生阻塞依赖（`--blocked-by`）并打上 `ready-for-agent` 标签。

### 第 3 步：由 Dinesh 在独立 worktree 中领取前沿任务并实现（Ticket → PR）

1. 查看当前无未关闭阻塞且尚未带有 `in-progress` / `in-review` / `ready-for-human` 标签的前沿（Frontier）任务：
   ```bash
   gh issue list --state open --label ready-for-agent --json number,title,labels
   gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by
   ```
2. 领取任务并立即打上 `in-progress` 标签防并发抢占：
   ```bash
   gh issue edit <n> --add-label in-progress
   ```
3. 为该任务创建独立的 `git worktree` 与分支（多个前沿任务可并行开多个 worktree）：
   ```bash
   git worktree add ../pied-piper-ticket-<n> -b ticket/<n> main
   ```
4. 在该 worktree 目录中启动新会话，读取 [`.piedpiper/roles/dinesh.md`](.piedpiper/roles/dinesh.md)，并仅传入任务 `#<n>`、父 Spec 编号、`GLOSSARY.md` 和 `docs/adr/` 指针。
5. Dinesh 按 `tdd` 与 `codebase-design` 完成实现与测试，**不修改共享文档**，推送分支并创建 PR，随后将任务标签流转为 `in-review`：
   ```bash
   gh pr create --title "..." --body "Closes #<n>"
   gh issue edit <n> --remove-label in-progress --add-label in-review
   ```

### 第 4 步：由 Gilfoyle 盲审 PR（PR diff → 评审发现）

1. 使用**不同于 Dinesh 的模型/工具（或至少全新的隔离会话）**以只读模式打开仓库或导出 PR diff 到只读文件：
   ```bash
   gh pr diff <pr> > /tmp/pr-<pr>.diff
   ```
2. 让其读取 [`.piedpiper/roles/gilfoyle.md`](.piedpiper/roles/gilfoyle.md)，**只提供** PR diff（或 `/tmp/pr-<pr>.diff` 路径）、任务 `#<n>` 与父 Spec 指针，**绝不传入 Dinesh 的对话或推理过程**。
3. Gilfoyle 输出结构化评审结论（每条发现必须含文件、行号、依据及 `阻塞级` / `建议级`，或逐项核验后的明确通过理由），并发布为 PR review：
   ```bash
   gh pr review <pr> --comment --body "..."
   ```

### 第 5 步：评审回路收口与开发者合并（Review Round ≤ 2）

- **无阻塞级发现（或仅含建议级发现）**：结束自动修改回路，由**开发者**亲自审核并手动合并 PR，随后清理 worktree（`git worktree remove ../pied-piper-ticket-<n>`）并确认任务关闭。
- **存在阻塞级发现（第 1 轮）**：让对应的 Dinesh 在原 worktree 修复阻塞级发现并推送更新，随后开启第 2 轮 Gilfoyle 评审——**第 2 轮只核对第 1 轮遗留的阻塞级发现**。
- **第 2 轮后仍存在阻塞级发现**：停止继续派发 Dinesh，为任务打上 `ready-for-human` 并移除 `in-review`（或按配置通知开发者），由开发者亲自拍板处理：
  ```bash
  gh issue edit <n> --remove-label in-review --add-label ready-for-human
  ```

