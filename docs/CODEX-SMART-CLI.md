# Codex Smart CLI 方案（按任务复杂度自动切换模型与推理等级）

**状态**: Proposal
**范围**: `agentmobile` 内的 Codex CLI 包装层设计，不等于本次直接落代码实现

---

## 1. 背景与问题

`agentmobile` 当前已经具备两类 Codex 接入：

- 交互式入口：[`agentmobile-run-codex.sh`](/home/ubuntu/code/idea0019-agent-mobile/agentmobile-run-codex.sh)
- 异步任务入口：[`server.js`](/home/ubuntu/code/idea0019-agent-mobile/server.js) 的 `runTask()`

现状里，Codex 已经可以显式指定模型。以本机 CLI 为准：

- `codex --help` / `codex exec --help` 均支持 `-m, --model <MODEL>`
- 当前 repo 的 Codex profile 也已经有：
  - `DEFAULT_MODEL`
  - `REASONING_EFFORT`
  - `SANDBOX_MODE`

也就是说，基础配置能力已经存在，缺的不是“能不能指定模型”，而是一个**按任务复杂度自动路由**的外层机制：

- 低价值扫描类任务，不该默认占用高成本高推理档
- 跨模块实现、复杂调试、高风险改动，又不该掉到低档
- 失败升级规则需要一致、可解释、可复用

本文只定义一个可落地的 CLI 包装方案：`codex-smart`。

---

## 2. 目标与非目标

### 2.1 目标

1. 在 **子任务 / 阶段** 粒度自动选择 `model + reasoning_effort`
2. 降低扫描、摘要、轻实现等低复杂度任务的默认成本
3. 保留复杂实现、复杂调试、高风险任务的质量上限
4. 让交互式入口与异步任务入口共用同一套路由规则
5. 每次执行都能输出“为什么选这个档位”，便于排错和回放

### 2.2 非目标

1. 不改 Codex 内核，不要求 Codex 自带自动路由
2. 不做**单个会话中途热切换**；只允许在子任务边界切换
3. 不改 tmux 架构，不替换 `agentmobile` 当前多 PTY 设计
4. 不引入多用户、租户、权限系统复杂度
5. 不在本文展开“项目内统一调度层”或通用 orchestrator

---

## 3. 现有接入点

`codex-smart` 需要复用的 repo 内接入点如下。

### 3.1 交互式 Codex 启动入口

- 文件：[`agentmobile-run-codex.sh`](/home/ubuntu/code/idea0019-agent-mobile/agentmobile-run-codex.sh)
- 作用：按 profile 读取 `data/configs/<profile>.json`，设置 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`CODEX_MODEL` 等环境，并启动交互式 `codex --yolo`

这意味着交互式场景下，`codex-smart` 最合适的接入方式是：

- 由 `agentmobile-run-codex.sh` 调起 `codex-smart`
- 或由它在进入 Codex 前先完成策略计算，再转调底层 `codex`

### 3.2 异步 `codex exec` 入口

- 文件：[`server.js`](/home/ubuntu/code/idea0019-agent-mobile/server.js)
- 位置：`runTask()`
- 现状：Codex 分支当前直接执行 `codex exec <prompt> --yolo --json`

这意味着异步任务场景下，`codex-smart` 应作为 `runTask()` 的外层包装命令，而不是另起一套任务系统。

### 3.3 profile 来源

- 目录：`data/configs/*.json`
- 已有字段：
  - `DEFAULT_MODEL`
  - `REASONING_EFFORT`
  - `SANDBOX_MODE`

因此该方案继续复用现有 profile JSON，不新增数据库，不新增独立配置中心。

---

## 4. 方案总览

新增一个包装命令：`codex-smart`

它不替代 Codex，只负责在调用前做一次“任务分档 + 参数决策”。

执行流：

```text
输入任务
  -> 阶段识别
  -> 复杂度判定
  -> 选 profile / model / reasoning_effort
  -> 调用 codex
  -> 打印本次命中规则与最终参数
```

关键边界：

- 只在**子任务边界**切换档位
- 不在同一子任务执行过程中频繁升降
- 包装层对上提供稳定接口：`phase + task + profile-set`
- 包装层对下负责适配当前安装版本的 Codex CLI 参数形式

这里尤其要区分两件事：

1. `codex-smart` 的外部接口稳定暴露 `model` 与 `reasoning_effort`
2. `reasoning_effort` 最终如何传给 Codex，属于包装层内部适配细节

原因是当前本机 `codex --help` 明确提供了 `--model`，但未在帮助中暴露单独的 `--reasoning-effort` 顶层参数。因此本文将 `reasoning_effort` 定义为**包装层内部负责映射的执行参数**，而不是承诺某个固定 CLI flag 名称。

---

## 5. 四档策略

方案固定四档，命名统一为：

| 档位 | 模型 | reasoning_effort | 适用倾向 |
|---|---|---|---|
| Low | `gpt-5.4-mini` | `low` | 扫描、摘要、搜文件、轻阅读 |
| Middle | `gpt-5.4` | `medium` | 单模块实现、局部 bug fix、单测修复 |
| High | `gpt-5.5` | `high` | 跨模块改动、前后端联动、接口变更 |
| Superhigh | `gpt-5.5` | `xhigh` | 高风险决策、复杂并发、连续失败后的升级 |

命名要求全文一致，只使用：

- `Low`
- `Middle`
- `High`
- `Superhigh`

---

## 6. 阶段划分

`codex-smart` 在进入模型选择前，先要求任务被归入一个阶段。

推荐阶段：

| 阶段 | 含义 |
|---|---|
| `scan` | 扫描仓库、搜文件、读上下文、摘要现状 |
| `plan` | 方案比较、拆子任务、列实现路径 |
| `implement` | 写代码、改脚本、补文档中的可执行内容 |
| `test-debug` | 跑测试、定位失败、修复回归 |
| `review` | 代码审查、风险检查、回归点确认 |

阶段的作用不是替代复杂度，而是给复杂度判定提供第一层默认值。

---

## 7. 路由规则

### 7.1 默认路由

默认规则如下：

- `scan`、摘要、搜文件、轻度读代码 -> `Low`
- 单模块实现、局部 bug fix、单测修复 -> `Middle`
- 跨模块、前后端联动、接口字段变更 -> `High`
- `auth`、`security`、`db schema`、`migration`、并发问题 -> 最低 `High`，必要时 `Superhigh`

### 7.2 升级规则

以下规则命中后应向上升档：

1. `failure_count >= 2` -> 升到 `Superhigh`
2. 触达 `5+` 文件且跨目录 -> 最低 `High`
3. 涉及 `auth`、`security`、`migration`、并发、数据一致性 -> 最低 `High`
4. 边界不清、质量优先、预期回退成本高 -> 向上升一档

### 7.3 降级规则

降级必须更保守：

1. 仅允许在进入**下一个子任务**时降级
2. 同一子任务执行过程中禁止频繁升降
3. 如果刚经历失败升级，本子任务结束前不再降级

### 7.4 质量优先原则

对边界任务的处理原则是：

- 判断不清时，向上升档
- 不允许高风险任务掉到 `Low`
- 宁可在复杂任务上多花一点推理成本，也不要在关键改动上误判降档

---

## 8. 任务类型映射表

下表给出一张简化映射表，供实现和验收时对照。

| 任务类型 | 阶段 | 复杂度档位 | 模型 | reasoning_effort |
|---|---|---|---|---|
| 搜文件、看结构、读 README | `scan` | `Low` | `gpt-5.4-mini` | `low` |
| 总结某模块现状 | `scan` | `Low` | `gpt-5.4-mini` | `low` |
| 单文件 UI 微调 | `implement` | `Middle` | `gpt-5.4` | `medium` |
| 单模块局部 bug fix | `implement` | `Middle` | `gpt-5.4` | `medium` |
| 修复单元测试 | `test-debug` | `Middle` | `gpt-5.4` | `medium` |
| 跨前后端接口改动 | `implement` | `High` | `gpt-5.5` | `high` |
| 多目录联动重构 | `implement` | `High` | `gpt-5.5` | `high` |
| 权限 / 鉴权 / 安全修复 | `implement` | `Superhigh` | `gpt-5.5` | `xhigh` |
| schema / migration / 并发问题 | `test-debug` | `Superhigh` | `gpt-5.5` | `xhigh` |
| 连续两次失败后的重试 | `review` 或 `test-debug` | `Superhigh` | `gpt-5.5` | `xhigh` |

---

## 9. CLI 接口设计

### 9.1 基本命令

```bash
codex-smart "<task>"
```

### 9.2 建议参数

```bash
codex-smart "<task>" \
  --phase implement \
  --profile-set codex \
  --cwd /workspace/project
```

建议支持的参数：

| 参数 | 说明 |
|---|---|
| `--phase` | 显式指定阶段：`scan` / `plan` / `implement` / `test-debug` / `review` |
| `--profile-set` | 指定复用哪套 profile 作为基础配置来源 |
| `--cwd` | 指定工作目录 |
| `--failure-count` | 显式传入当前子任务失败次数 |
| `--files-touched` | 可选，供调用方传入变更文件数 |
| `--cross-dir` | 可选布尔值，显式表示是否跨目录 |

### 9.3 输出要求

每次执行前，`codex-smart` 至少打印：

- 最终使用的 `model`
- 最终使用的 `reasoning_effort`
- 当前 `phase`
- 命中的规则
- 是否发生升档

示例：

```text
[codex-smart] phase=implement
[codex-smart] tier=High
[codex-smart] model=gpt-5.5
[codex-smart] reasoning_effort=high
[codex-smart] matched_rules=cross-module, api-change
```

### 9.4 对底层 Codex 的调用形式

包装层对外暴露稳定接口，对内再转成当前安装版本可接受的 Codex 调用形式。原则上：

- `model` 明确映射到 `codex ... --model <MODEL>`
- `reasoning_effort` 由包装层映射到当前版本支持的配置注入方式
- `SANDBOX_MODE` 继续复用现有 profile / 运行参数

对于异步执行，可保持现有 `codex exec ... --json` 流水线；对于交互式执行，则包装 `codex --yolo` 的启动入口。

---

## 10. 与 repo 的映射

### 10.1 交互式场景

交互式场景建议包装 [`agentmobile-run-codex.sh`](/home/ubuntu/code/idea0019-agent-mobile/agentmobile-run-codex.sh)：

- 保留现有 profile 读取逻辑
- 在真正启动 Codex 前调用 `codex-smart`
- `codex-smart` 决定本轮子任务的 `model + reasoning_effort`

适合的落点：

- 用户在 Web 终端新建 Codex session
- 用户在 tmux 窗口中进入 Codex 交互式工作流

### 10.2 异步任务场景

异步任务场景建议包装 [`server.js`](/home/ubuntu/code/idea0019-agent-mobile/server.js) 中的 `runTask()`：

- 当前 `runTask()` 中 Codex 分支直接执行 `codex exec`
- 方案改为先调用 `codex-smart`
- `codex-smart` 再统一下发到底层 `codex exec`

这样做的价值是：

- Web TaskPanel
- Telegram / IM 异步任务
- 后续其他非交互触发源

都能走同一套路由规则。

### 10.3 profile 继续复用

基础配置仍来自 `data/configs/*.json`：

- 不新增数据库
- 不新增用户维度配置
- 不改变现有单用户设计

`codex-smart` 只是在这些 profile 之上增加一层**任务级路由决策**。

---

## 11. 验收标准

以下标准用于判断该方案落地后是否达标：

1. 同一类任务稳定落到预期档位
2. 高风险任务不会掉到低档
3. 失败升级路径清晰、可解释
4. 低复杂度任务不默认占用高档模型
5. 交互式入口与异步任务入口的路由行为基本一致
6. 日志或标准输出中可以看到本次命中的规则与最终选择

---

## 12. 后续扩展

本文刻意只覆盖 `CLI 版：只做 codex-smart`。

可预留但**不在本文实现范围内**的扩展方向：

1. 工程版统一调度层
2. 基于历史任务结果的动态打分
3. 更细粒度的任务标签体系
4. 与测试结果、diff 大小、失败类型联动的自动升档

这些都可以作为后续能力，但不应混入当前方案的首版范围。

---

## 13. 锚点核对

对照 [`docs/NORTH-STAR.md`](/home/ubuntu/code/idea0019-agent-mobile/docs/NORTH-STAR.md)，本方案保持以下边界不变：

1. 仍服务于 AI Agent 管理与低摩擦使用，提升的是 Codex 接入效率
2. 仍是单用户设计，不引入团队/多用户复杂度
3. 不替换 tmux，不改变现有多 PTY 架构
4. 不把 `agentmobile` 扩展成通用 Web SSH

因此该方案与当前 North Star 三原则一致。
