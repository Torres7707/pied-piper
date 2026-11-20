# 角色是配置，agent 是适配器

角色（Richard、Jared、Dinesh、Gilfoyle）只是一份配置：职责说明、适配器、模型、skill、权限。具体的命令行 agent 通过统一的适配器接口接入，接口只有"提示词和目录进，最后一条回复出"。系统不自己实现 agent，只调用本机已安装并登录的命令行 agent。

原因：要让不同角色用不同的 agent 和模型，尤其是让 Gilfoyle 与 Dinesh 用不同的模型，保证评审独立。同时新增一个 agent 只需写一个适配器，不改角色和调度逻辑。

## Considered Options

- 角色写死在代码里：改模型或换 agent 都要改代码，不能由开发者在仓库里配置。
- 完全使用 Claude Code 的 subagent：只能用一个模型家族，且 subagent 不能再派 subagent，无法做到不同角色用不同后端。
- 自己手写 agent 循环：这是 code-review-agent 项目已经做的事，在这里重复没有价值。

## Consequences

- 角色配置放在目标仓库里，随仓库版本管理。
- 适配器要处理各家 CLI 的参数、会话续接和输出格式差异，这部分是主要维护成本。
- 提示词作为独立参数传给命令，不经过 shell。
