# Pied Piper

## Agent skills

### Issue tracker

GitHub Issues (`Torres7707/pied-piper`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) plus Pied Piper workflow labels (`in-progress`, `in-review`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout using root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Pied Piper L0 角色与配置约定

- 角色配置与运行时开关位于 `.piedpiper/config.json`，角色说明位于 `.piedpiper/roles/{richard,jared,dinesh,gilfoyle}.md`。
- 配置校验原则：Gilfoyle 与 Dinesh 应配置不同的 `(adapter, model)` 组合；相同组合虽不阻断运行，但必须视为评审独立性风险警告。
- 执行 **Richard**：只读讨论，每次至少给出三个不同方向及代价，不写业务代码、不改任务板，结论落成 GitHub issue 或 `docs/adr/`。
- 执行 **Jared**：直接读取 `~/.claude/skills/{to-spec,to-tickets,triage,domain-modeling}/SKILL.md` 执行（不依赖受限的 `/skill` 触发），产出带 `ready-for-agent` 与原生阻塞关系的 Spec 和 Ticket。
- 执行 **Dinesh**：领取前沿任务时先打 `in-progress`，仅在基于默认分支创建的独立 `git worktree` 与分支中按 TDD 实现，不修改共享文档，开出 PR 后转为 `in-review`。
- 执行 **Gilfoyle**：严格只读、使用异构模型/独立会话，仅看 PR diff 与规格/任务上下文指针（屏蔽 Dinesh 推理过程），必须给出含文件、行号、依据与级别（阻塞级 / 建议级）的具体发现或明确通过理由；单个 PR 最多两轮自动修改，两轮后仍有阻塞级发现则打上 `ready-for-human` 交由开发者拍板，绝不自动合并。

