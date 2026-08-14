# Pi Agent ABI Extension 落地计划（基于当前代码库）

## 1. 项目目标

在 `pi-subagents` 现有 SubAgent 能力之上，实现"强类型 Agent ABI"：让一个 Markdown Agent Definition 除了声明 `name`/`description`/`tools`/`model`/`systemPrompt` 之外，还能声明输入/输出 JSON Schema 契约：

```text
Agent(
    InputSchema
) -> OutputSchema
```

目标是把子 Agent 从"只能通过自然语言 `task` 调用的 AI Worker"，升级为：

> **可发现、可验证、可组合、可调度的 Typed Agent。**

核心能力：

1. Agent Frontmatter 声明 `abi.input`（Input Schema）。
2. Agent Frontmatter 声明 `abi.output`（Output Schema）。
3. Agent 加载（discovery）阶段校验 ABI 定义本身。
4. 调用 Agent 前验证 `input` 是否符合 Input Schema。
5. 运行时要求 Agent 返回符合 Output Schema 的结构化 JSON。
6. 输出 JSON 解析 + Schema Validation。
7. 输出不合法时提供可控 retry/repair 机制。
8. 保持现有 `task`（即 `prompt`）调用方式完全兼容。
9. 让主 Agent 从 Agent Registry（`action:"list"`）看到 ABI 摘要，从而更可靠地选择和组合子 Agent。
10. 为未来 DAG / Workflow / Agent Composition 打基础。

---

## 2. 当前代码库现状（重要：计划必须基于此）

> ⚠️ 本计划**不是**基于 Pi 官方 `pi-mono` 的极简示例扩展（`packages/coding-agent/examples/extensions/subagent/`），而是基于本仓库 `pi-subagents`（v0.49.0）的真实实现。以下现状是探索代码后确认的事实，落地前仍应以代码为准。

### 2.1 目录与关键文件

```text
pi-subagents/
├── index.ts                     # 1 行 re-export
├── src/
│   ├── extension/
│   │   ├── index.ts             # 扩展入口：注册 subagent tool（第 593 行）
│   │   ├── schemas.ts           # TypeBox 定义 subagent tool 参数（SubagentParamProperties 第 257 行）
│   │   └── tool-description.ts  # 静态 tool description（纯常量模板，不含具体 agent）
│   ├── agents/
│   │   ├── agents.ts            # AgentConfig 定义（第 115 行）+ discovery（discoverAgents 第 1767 行）
│   │   ├── frontmatter.ts       # 手写 frontmatter 解析器（parseFrontmatter 第 65 行）
│   │   ├── agent-serializer.ts  # AgentConfig → .md 写回（serializeAgent 第 52 行，KNOWN_FIELDS 第 5 行）
│   │   └── agent-management.ts  # subagent tool 管理动作（handleList 第 753 行）
│   ├── runs/
│   │   ├── foreground/subagent-executor.ts   # 前台执行（SubagentParamsLike 第 266 行）
│   │   ├── shared/
│   │   │   ├── structured-output.ts          # 结构化输出运行时（核心，已存在）
│   │   │   ├── subagent-prompt-runtime.ts    # 子进程内 runtime（注入 prompt/tool）
│   │   │   └── pi-args.ts                    # 子进程 argv/env 构造
│   │   └── background/async-execution.ts     # 异步执行
│   └── shared/types.ts          # JsonSchemaObject、AgentContract、SingleResult 等共享类型
├── agents/*.md                  # builtin 示例 agent（6 个，均无 ABI）
└── docs/
```

### 2.2 关键现状（决定了落地方案）

1. **`AgentConfig`（`src/agents/agents.ts:115`）已有 60+ 字段**，但**没有** `abi`/`inputSchema`/`outputSchema`。所有未知 frontmatter 键会落进 `extraFields: Record<string, string>`（`agents.ts:1611-1614`），并被序列化时按纯字符串写回。

2. **frontmatter 解析是手写的，只返回 `Record<string, string>`**（`src/agents/frontmatter.ts:65`）。嵌套对象（如 `runner`/`permissions`/`memory`）走**两阶段模式**：手写解析器先拿原始块字符串 → `parseYaml(raw)` 二次解析（见 `agents.ts:1451` `parseAgentRunnerFrontmatter`、`:1620` `validatePermissionRules(parseYaml(...))`）。**ABI 必须复用此模式**，不能自创 parser，也不能要求用户把 JSON 塞进 YAML 字符串。

3. **结构化输出（Output Schema）已经完整存在且生产可用**：
   - `outputSchema` 已经是 `subagent` tool 的 per-call 公开参数（`schemas.ts:354`）。
   - 完整链路：`createStructuredOutputRuntime`（`structured-output.ts:127`）→ env 传递（`pi-args.ts:802-804`）→ 子进程注册 `structured_output` tool（`subagent-prompt-runtime.ts:609-640`）→ `readStructuredOutput` 二次校验（`structured-output.ts:156`）。
   - 校验用 `typebox/compile`，已处理 `$ref` 重写（`rewriteLocalJsonPointerRefs`）、错误格式化、临时目录清理、子进程环境下的加载回退（`importCompile`，`:87-109`）。
   - 结果字段已存在：`SingleResult.structuredOutput` / `structuredOutputFailed`（`src/shared/types.ts:951-954`）。
   - 结构化委托 API 已存在：`src/api/delegation.ts` 的 `SubagentDelegationResultRequest = {kind:"structured", schema}`。

   **结论**：Output ABI 的实现 = 把 per-call 的 `outputSchema` 扩展为"Agent 声明 + per-call 覆盖优先"，而非从零实现。

4. **输入侧（Input Schema）完全不存在**：当前唯一输入通道是 `task: string`（`schemas.ts:259`），没有 `input` 字段，没有 `inputSchema`。这是本计划的**唯一真正新工作**。

5. **命名冲突**：`AgentContract` / `agentContract`（`src/shared/types.ts:302`）已被占用为**兼容行为开关**（`{version: 1}`），与 ABI 无关。ABI 字段必须用 `abi`，不能叫 `contract`。

6. **子 agent 是独立 Pi 子进程**（`spawn`），父子通过 env 变量 + 临时文件通信（`pi-args.ts`）。输入注入应复用此通道，而非把 JSON 塞进 `task` 文本。

7. **发现性注入点**：`buildSubagentToolDescription`（`tool-description.ts`）是**纯静态常量**，不含任何 agent 名，它靠反复要求 LLM 先调 `{action:"list"}` 来发现 agent。真正的动态逐-agent 信息在 `handleList()`（`agent-management.ts:753`）的每行输出里。**ABI 摘要应加在 `handleList()`，不要改静态模板。**

8. **`keepTopLevelParameterDescriptions`（`schemas.ts:7`）会剪掉嵌套 `description`**，只保留 `properties.<name>.description`。新增 ABI 参数的说明必须写在顶层 property 上。

### 2.3 术语映射（计划 ↔ 代码）

| 计划用语 | 代码实际字段 | 说明 |
|---|---|---|
| `prompt` | `task`（`SubagentParamsLike.task`，`schemas.ts:259`） | 自由文本指令，唯一现有输入 |
| `outputSchema` | `outputSchema`（已存在） | per-call 结构化输出契约 |
| `input` | **不存在，需新增** | typed 业务输入 |
| `AgentResult` | `SingleResult`（`shared/types.ts:900`） | 单次调用结果 |
| `contract` | ⚠️ 已被 `AgentContract` 占用 | ABI 字段必须叫 `abi` |

---

## 3. 设计原则

1. **向后兼容**：无 ABI 的 agent 行为完全不变；`task` 调用方式不变。
2. **ABI 是可选增强**：允许只声明 `abi.input`、只声明 `abi.output`，或都不声明。
3. **JSON Schema 是唯一标准**：用现有 `typebox/compile` 做校验，**不引入 Ajv**（避免两套校验器并存）。
4. **Runtime Validation 优先**：Prompt 约束只是辅助，真正正确性靠代码校验。
5. **复用现有基础设施**：结构化输出的 env+临时文件通道、frontmatter 两阶段解析、`agentFrontmatterFields` 序列化保留机制，全部复用。

---

## 4. ABI Frontmatter 格式

### 4.1 目标格式（YAML 原生嵌套）

```yaml
---
name: architecture-reviewer
description: Analyze repository architecture and return structured findings.
model: claude-sonnet-4
tools: read,grep,find,ls

abi:
  version: "1"

  input:
    title: ArchitectureReviewRequest
    type: object
    additionalProperties: false
    required:
      - target
    properties:
      target:
        type: string
      areas:
        type: array
        items:
          type: string
          enum:
            - architecture
            - dependency
            - performance
            - security

  output:
    title: ArchitectureReviewResult
    type: object
    additionalProperties: false
    required:
      - summary
      - findings
    properties:
      summary:
        type: string
      findings:
        type: array
        items:
          type: object
          required:
            - severity
            - description
          properties:
            severity:
              type: string
              enum: [info, warning, error]
            description:
              type: string
            file:
              type: string
---

Analyze the target repository according to the requested areas.
```

### 4.2 ABI 类型定义

新增 `src/agents/abi.ts`（或并入 `src/shared/types.ts`）：

```ts
import type { JsonSchemaObject } from "../../shared/types.ts";

export interface AgentABI {
    input?: JsonSchemaObject;
    output?: JsonSchemaObject;
    version?: string;
}
```

`input`/`output` 都**可选**，允许逐步迁移。

---

## 5. AgentConfig 扩展（三处必须同步）

在 `AgentConfig`（`src/agents/agents.ts:115`）加：

```ts
abi?: AgentABI;
```

**关键：必须同步修改三处，否则 ABI 字段在 round-trip（`action:"update"`）时静默丢失：**

1. **`AgentConfig`**（`agents.ts:115`）加 `abi?` 字段。
2. **`KNOWN_FIELDS` 白名单**（`agent-serializer.ts:5`）加 `"abi"`。
3. **`serializeAgent()`**（`agent-serializer.ts:52`）加 `abi` 的写回逻辑，复用 `runner`/`permissions` 的模式：`stringifyYaml(abi)` + 2 空格缩进。

### frontmatter 解析

在 `loadAgentsFromDir`（`agents.ts:1513`）中，仿照 `parseAgentRunnerFrontmatter` 增加：

```ts
function parseAgentAbiFrontmatter(raw: string | undefined, agentName: string): AgentABI | undefined {
    if (raw === undefined || !raw.trim()) return undefined;
    let parsed: unknown;
    try {
        parsed = parseYaml(raw);
    } catch (error) {
        throw new Error(`Agent '${agentName}' has invalid abi frontmatter: ...`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Agent '${agentName}' has invalid abi frontmatter; expected an object.`);
    }
    return parsed as AgentABI;  // 结构细节由 ABI definition validation 校验
}
```

---

## 6. ABI Definition Validation（discovery 阶段）

在 discovery 阶段校验 `abi.input` / `abi.output` 是否为合法 JSON Schema，尽早暴露错误。

**校验方式（已根据实测修正）**：项目没有 Ajv / JSON Schema meta-schema，且实测 `typebox/compile` 的 `Compile` 对非法 schema（如 `type: "unknown_type"`、`enum` 传字符串）**不抛错、静默接受**，只有非对象根才 throw。因此本阶段做**结构性 sanity check**（与现有 `structured-output.ts` 的 `assertJsonSchemaObject` 同级别，不承诺 full meta-schema validation）：

1. `abi` 必须是对象（非数组、非 null）。
2. `abi.input` / `abi.output` 若存在，必须是对象（非数组、非原始类型），复用 `assertJsonSchemaObject` 的断言逻辑。
3. 可选：尝试 `Compile` 捕获非对象根的 throw（与现有 `validateStructuredOutputValue` 的 `invalid outputSchema` 分支一致）。

更深的 schema 定义错误（如 `type` 值非法）在调用阶段做 runtime validation 时暴露——这与现有 `outputSchema` 的行为一致，不新增依赖。

错误分级（区分清楚）：

```text
Agent Metadata Error          — name/description 缺失
Agent ABI Definition Error    — abi 结构非法（本阶段：非对象/非对象根）
Agent Runtime Input Error     — input 校验失败（调用阶段）
Agent Runtime Output Error    — output 校验失败（调用阶段）
Agent Execution Error         — 子进程执行失败
```

**错误策略（已确认）**：ABI 结构非法时 **`throw`（fail-fast）**，与 `runner`/`permissions` 现有语义一致（见 `agents.ts:1540` `parseAgentRunnerFrontmatter`）。理由：ABI 是开发者书写的声明错误，不是运行时数据错误；静默吞掉会让 agent 悄悄退化为"无 ABI"，造成"以为有契约、实际没有"的更隐蔽 bug（多 Agent 系统中"错误要响亮而局部"）。错误信息必须带 `agent` 名 + 具体 schema 路径（如 `abi.input: must be a JSON Schema object`）。落地时需确认 `discoverAgents` 上层是否对单 agent 错误有隔离捕获——若有，保持隔离；若无，与 runner 现状保持一致即可。

---

## 7. 实施阶段（按依赖顺序）

### Phase 1：ABI 类型 + frontmatter 解析 + discovery

**文件**：
- 新增 `src/agents/abi.ts`：`AgentABI` 类型 + `parseAgentAbiFrontmatter` + `validateAbiDefinition`（结构性 sanity check，见第 6 节）。
- `src/agents/agents.ts`：`AgentConfig` 加 `abi?`；`loadAgentsFromDir` 调用 `parseAgentAbiFrontmatter(frontmatter.abi)`。
- `src/agents/agent-serializer.ts`：`KNOWN_FIELDS` 加 `"abi"`；`serializeAgent` 写回。

**测试**：`test/unit/` 新增 frontmatter 解析 + ABI definition 校验测试。

### Phase 2：Output ABI（复用现有结构化输出，成本最低）

**核心改动**：把"per-call `outputSchema`"扩展为"Agent 声明 `abi.output` + per-call 覆盖优先"。

**文件**：
- `src/runs/foreground/subagent-executor.ts`：
  - 第 2921 行 `structuredOutputSchema: params.outputSchema` 改为 `structuredOutputSchema: params.outputSchema ?? resolvedAgent.abi?.output`。
  - 第 4287 行同样处理。
  - 需要在该执行函数中能拿到已 resolve 的 `AgentConfig`（`abi` 来源）。需确认 `params.agent` 解析出的 `AgentConfig` 在此处是否可用；若不在作用域，需在 resolve 阶段提前把 `abi.output` 注入到 task 结构。
- `src/runs/background/async-execution.ts`：异步路径同样回落（`outputSchema` 相关，第 723/872 行附近）。

**行为**：
- `abi.output` 存在 → 自动进入结构化输出模式（子进程注入 `STRUCTURED_OUTPUT_INSTRUCTIONS`，要求调用 `structured_output` tool）。
- per-call 传了 `outputSchema` → 覆盖 agent 声明（现有行为不变）。
- 两者都没有 → legacy 自由文本输出（现有行为不变）。

**注意**：现有结构化输出是 tool-based，模型输出天然无 fence/无夹带文本问题，因此**不需要**旧计划里的"JSON 提取容错 / 去 fence"逻辑。

### Phase 3：Input ABI（真正的新工作）

**新增 `input` 参数 + 父端校验 + 输入注入子进程**。

**文件**：
- `src/extension/schemas.ts`：`SubagentParamProperties` 加 `input: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, description: "Typed structured input matching the agent's declared abi.input schema." }))`。
- `src/runs/foreground/subagent-executor.ts`：`SubagentParamsLike`（第 266 行）加 `input?: unknown`。
- **父端校验**：resolve agent 后，若 `agent.abi?.input` 存在且 `params.input` 存在，用 `validateStructuredOutputValue(abi.input, params.input)` 校验；失败则**直接返回结构化错误，不启动子进程**（复用现有 `validateStructuredOutputValue`，它返回 `{status:"invalid", message}`，message 已是 `path: msg` 格式）。若 `agent.abi?.input` 存在但 `params.input` 缺失，则**降级为 legacy**（见下文"input 缺失策略"）。

**输入注入子进程（已确认：复用 env + 临时文件，绝不塞进 task 文本）**：
- 新增 `src/runs/shared/typed-input.ts`（或并入 `structured-output.ts`）：
  - `createTypedInputRuntime(input, baseDir)`：写 `input.json` + 返回 `{inputPath}`。
  - env 常量 `PI_SUBAGENT_TYPED_INPUT`。
- `src/runs/shared/pi-args.ts`：仿照 `input.structuredOutput`（第 802-804 行）注入 `PI_SUBAGENT_TYPED_INPUT`。
- `src/runs/shared/subagent-prompt-runtime.ts`：在 `before_agent_start` 钩子（第 651 行）读 env → 读 `input.json` → 追加到 `systemPrompt`（结构化输入区，见下）。

理由：输入即上下文边界，应作为可序列化的明确工件在隔离上下文接收（Anthropic 最佳实践）；塞进 task 文本有 JSON 转义、提示注入、大输入 token 膨胀三个问题。`task` 始终只作为自由文本补充指令，从 env+临时文件读取结构化输入。

**注入格式**（在子进程 system prompt 追加）：

```text
You are being invoked as a typed subagent.

Agent: architecture-reviewer

Input contract:
<JSON Schema 摘要>

Input:
<JSON 实例>

Additional instruction:
<optional task 文本>

You MUST treat the input object as the primary structured task input.
```

**注意**：`task` 仍保留为自由文本补充指令（映射旧计划里的 `prompt`）。

**input 缺失策略（已确认，兼容降级）**：`abi.input` 存在但调用只给 `task` 不给 `input` 时，**不硬报错，降级为 legacy 行为**（忽略 input ABI，仅用 task）。理由：现有所有 agent 都用 `task` 调，硬报错会破坏现有工作流；向后兼容靠缺省值（"旧配置不填新字段仍可用"）。**唯一要报错的情况是"明确给了 `input` 但值不合法"**——此时 schema 校验失败必须 fail-fast，返回可行动的错误信息（含 `path: message` 定位），不启动子进程。

### Phase 4：Output repair / retry（增量，可选但推荐）

现有结构化输出校验失败时，错误抛回给子进程模型自纠（`structured-output.ts` 的 `structured_output` tool execute 里 throw）。本 phase 增加**父级有限重试**（validate-repair-retry 模式）：

- `abi.maxRetries`（默认 2）加到 `AgentABI`。
- 输出校验失败 → 生成修复 prompt（含 `path: message` 结构化错误）→ 父进程重新发起一轮对话给同一子进程（复用 session/fork），要求"仅修复输出，不要重跑任务"。
- 上限 2 次（行业标准），耗尽则返回 typed failure（`structuredOutputFailed: true`）。

**已确认的关键约束**：
- retry 次数超过 2 是"schema 与模型输出风格打架"的信号，应修 schema 而非调高上限。`maxRetries` 默认 2、可配置，但不鼓励调高。
- 这是对现有"模型内自纠"的**额外兜底**。落地前需先确认：子进程 `structured_output` 校验失败 throw 后，Pi 子进程是否会自动让模型重试——若会，父级 repair 需避免与子进程自纠重复/冲突。**此确认在 Phase 3 完成后、Phase 4 开工前进行**，不阻塞 Phase 1-3。

### Phase 5：发现性（Tool Description / list 摘要）

**文件**：`src/agents/agent-management.ts` 的 `handleList()`（第 753 行）。

每行 agent 输出追加 ABI 摘要（有 `title` 用 title，否则用 `object`）：

```text
- architecture-reviewer (builtin): Analyze repository architecture [ArchitectureReviewRequest -> ArchitectureReviewResult]
- reviewer (builtin): Versatile review specialist
```

**不要**改 `tool-description.ts` 的静态模板（影响所有调用、token 成本高）。可选：在静态模板里加一句"调用 list 可查看每个 agent 的 ABI 契约"。

### Phase 6：测试 + 示例

**测试**：
- unit：ABI frontmatter 解析、ABI definition 校验、input 校验、output 回落优先级、序列化 round-trip（声明 ABI → serialize → 字段不丢）。
- integration：真实子进程 typed 调用（input → 结构化 output）。
- backward compat：6 个现有 builtin agent（delegate/oracle/researcher/reviewer/scout/worker）无 ABI 时行为不变。

**示例**：新增 `agents/architecture-reviewer.md`（带完整 ABI），并在 README 加使用示例。

**验证命令**：`npm run typecheck`、`npm run test:unit`、`npm run test:integration`。

---

## 8. 兼容性矩阵

| Agent ABI | Call | 预期 |
|---|---|---|
| 无 ABI | `task` | 原有行为 |
| 无 ABI | `input` | 忽略 `input`，仅用 `task`（无 ABI 时不校验） |
| `abi.input` | `input` | 校验后执行 |
| `abi.input` | `input` 非法 | fail-fast 返回结构化错误，不启动子进程 |
| `abi.input` | `task`（无 input） | 兼容降级为 legacy 行为（忽略 input ABI） |
| `abi.output` | `task` | 自动结构化输出 |
| `abi.input`+`abi.output` | `input` | 完整 typed execution |
| `abi.input`+`abi.output` | `input`+`task` | typed input + 补充指令 |
| output 校验失败 | maxRetries>0 | repair/retry |
| output 校验失败 | retries 耗尽 | typed failure（`structuredOutputFailed: true`） |

---

## 9. 非目标（第一版不做）

1. Agent DAG 自动规划 / 类型自动匹配。
2. Schema 远程 Registry / MCP integration。
3. 跨语言 ABI / 自动生成 TS/Go types。
4. 复杂版本协商（`abi.version` 仅作占位，不做 `reviewer@1`/`@2` 路由）。
5. 分布式 Runtime / 永久 Artifact Store。

---

## 10. Definition of Done

- [ ] 旧 agent 无 ABI 时行为完全兼容。
- [ ] Frontmatter 可声明 `abi.input` / `abi.output`。
- [ ] ABI 用标准 JSON Schema，`typebox/compile` 校验。
- [ ] Discovery 阶段校验 ABI 定义，错误尽早暴露。
- [ ] 三处序列化同步（`AgentConfig` + `KNOWN_FIELDS` + `serializeAgent`），round-trip 不丢字段。
- [ ] `subagent` tool 支持 `input`。
- [ ] input 在启动子进程前校验，非法时 fail-fast、不启动、返回清晰错误。
- [ ] `abi.input` 存在但仅传 `task` 时兼容降级为 legacy 行为，不报错。
- [ ] `abi.output` 自动进入结构化输出模式（复用现有链路）。
- [ ] 输出 JSON 解析 + Schema 校验（复用现有 `structured_output`）。
- [ ] 支持有限次 output repair/retry。
- [ ] `handleList` 展示 ABI 摘要。
- [ ] 完整测试覆盖（unit + integration + backward compat）。
- [ ] 至少一个 typed 示例 agent + README 示例。
- [ ] 不修改 Pi core，只在 extension 层实现。
- [ ] 不破坏现有 `task` 调用模型。

---

## 11. 已确认决策

以下决策已与用户确认，作为落地的确定约束：

1. **ABI schema 非法时的 discovery 策略 → `throw`（fail-fast）**。与 `runner`/`permissions` 现有语义一致；错误信息带 `agent` 名 + schema 路径。落地时确认 `discoverAgents` 是否对单 agent 错误有隔离捕获。

2. **`abi.input` 存在但调用无 `input` → 兼容降级**。不硬报错，忽略 input ABI，仅用 `task` 走 legacy。唯一 fail-fast 场景是"明确给了 `input` 但校验不合法"。

3. **`input` 注入子进程方式 → env + 临时文件**。复用结构化输出通道，绝不塞进 `task` 文本；`task` 始终仅作自由文本补充指令。

4. **命名 → 锁定 `abi`**。`agentContract` 已被占用（`shared/types.ts:302` 的兼容开关），ABI 字段、类型、frontmatter key 一律用 `abi`。

5. **repair/retry → 父级有限重试（默认 2 次）**。validate-repair-retry 模式：修复 prompt + 重新发起对话（仅修复输出不重跑任务）。在 Phase 3 完成后、Phase 4 开工前，先确认子进程自纠与父级重试是否冲突，再定最终交互细节。

---

## 12. 给执行者的要求

1. 先阅读代码再修改；本计划引用的行号是基于当前快照，实施前需复核。
2. 复用 `structured-output.ts` 的 `loadCompile`/`validateStructuredOutputValue`/`createStructuredOutputRuntime`，**不引入 Ajv**。
3. 复用 frontmatter 两阶段解析范式（`parseYaml`），不自创 parser。
4. 不修改 Pi core；若 extension 层无法完成，先记录理由。
5. ABI 必须是可选能力；`input`/`output` 都可单独存在。
6. 新增核心逻辑必须有测试。
7. 每完成一个 Phase 运行对应测试，最后跑完整 `typecheck`/`test`。
8. 最终报告：修改文件、ABI 格式、新增 API、兼容性、测试结果、已知限制、后续建议。
