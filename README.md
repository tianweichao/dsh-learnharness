# dsh-learnharness

把 [LearnHarness](https://github.com/amosblomqvist/learnharness) 的**教学方法**做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。

> **English:** A DSH plugin that ports the *method* of LearnHarness — measure the learner's understanding boundary, plan a dependency DAG, teach one reasoning step per turn, then practice retrieval — into DeepSeek Harness. It is a derivative work of LearnHarness (AGPL-3.0), not a fork of its application.

不是把那个应用搬过来。LearnHarness 是一个独立应用（Next.js + Electron，849 个文件），其中大部分是它不得不自己造、而 DSH 已经有的东西（会话模型、agent 循环、模型供应商、子代理、附件、听写）。这个仓库只搬三样真正构成"学习 harness"的东西：

1. **承诺答案键**——出题工具要求模型在出题**之前**写好答案键与解释，落盘后回读，模型无权改判。
2. **暂停与回灌**——题目在作答卡上呈现，学习者的答案落盘，下一轮模型读回它继续教。
3. **位置从调用派生**——计划进度只由"最近一道带 `nodeId` 的题"决定，不存 progress 字段。

---

## 衍生声明（AGPL-3.0 要求）

| | |
|---|---|
| 上游项目 | [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness)，AGPL-3.0 |
| 本仓库性质 | **衍生作品（derivative work）**：移植其教学方法、工具契约与状态模型 |
| 未包含 | 上游的 Next.js/Electron 应用代码、Pi agent 运行时、UI 组件、知识图谱抽取流水线 |
| 教学文本 | `skills/learnharness/references/` 下的教义是**中文重写**，不是上游英文提示词的逐字复制；结构与判据来自上游 |
| 协议 | 本仓库同样以 **AGPL-3.0** 发布（见 [LICENSE](LICENSE)） |

上游作者与本仓库无关联，本插件未经其背书。若上游不同意此衍生方式，请联系仓库作者下架。

---

## 为什么是重写而不是移植

| LearnHarness 自己造的 | DSH 已有原语 | 是否移植 |
|---|---|---|
| ChatRecord（消息即状态）+ 流式 + 恢复 | Session / session log / 重连 | ❌ |
| Pi agent 循环、工具执行、并行批次 | `dsh-agent-loop` + `dsh-tools` | ❌ |
| 模型供应商、订阅、Claude Code 桥 | `llm-pi-ai` 全家桶 | ❌ |
| 研究 / PDF / demo / 视觉 子代理 | `dsh-subagent` / `dsh-tool-jobs` / browser | ❌ |
| 附件、图片管线、听写、成本计量、压缩 | 对应 DSH 包 | ❌ |
| **方法提示词** | 本插件的 `skills/` + 工具描述 | ✅ |
| **带承诺答案键的提问仪器** | `learn_quiz` / `learn_explain` / `learn_probe_question` | ✅ |
| **计划 DAG（mermaid 子集 + 环检测 + 派生状态）** | `learn_plan` + `lib/store.js` | ✅ |
| **作答历史与位置感** | 自建作答卡 + 学习面板 + 学习页签 | ✅ |
| 知识图谱（命题/推理链 + 抽取流水线，约 3000 行） | **不做** | 上游教师从不读图谱，性价比最低 |

---

## 功能

### 工具（模型侧）

| 工具 | 作用 |
|---|---|
| `learn_start` | 开/接续学习主题，绑定到当前会话 |
| `learn_status` | 阶段、计划位置、未答题、未送达的作答 |
| `learn_plan` | 写入/整体替换计划 DAG（mermaid 子集，校验 id、环、重复边） |
| `learn_probe_done` | 结束探针：写入每条依赖线的 floor / ceiling / misconception |
| `learn_probe_question` | 探针提问（有选项=选择，无选项=自由回答） |
| `learn_quiz` | 选择题：`correctAnswer` + `explanation` 出题前承诺，**服务端判分** |
| `learn_explain` | 自由回忆：承诺完整答案，由模型判分 |
| `learn_answer` | 无界面时的代答通道（CLI / 对话里直接作答） |

### 界面（浏览器侧）

- **右侧栏「学习」页签**：有待答题时显示作答卡（选项按 callId 稳定洗牌、思路输入框、置信度滑条、多选、我不知道、跳过这题）；没有待答题时显示作答历史。与「浏览器 / 文件 / 终端」并列，一起收起。
- **左侧栏「学习」入口**：学习面板，显示目标、阶段、进度条、依赖图（✓ 已走 / ▶ 当前）、作答历史。
- **对话流内卡片**：每次工具调用渲染成对应卡片（历史记录）。

作答历史默认**一行一条**：`序号 · 题目 · 时间 · 判定`，点击展开看完整题目、你的作答、置信度、所属节点、思路、解释。

### 作答后自动继续

提交答案 → 答案落盘 → 插件通过 `ctx.sessions.scope(sessionId).conversation.send()` 给该会话发一条消息 → 触发新一轮 → 模型用 `learn_status` 取回判分与思路继续教。**不需要手动说"继续"。**

### 随插件附带的教学技能

`skills/learnharness/` 是一个独立的 DSH 技能（含 6 篇教义与 `lh.mjs` 状态工具）。它可以：

- 由本插件的工具描述驱动（推荐，体验最好）；
- 或**单独复制到 `~/.dsh/skills/`** 使用——不装插件也能跑完整流程（用 `ask_user_question` 代替作答卡）。

---

## 安装

| 方式 | 命令 |
|---|---|
| **npm 包**（可进 DSH 内置 Plugin Hub） | `dsh plugin --profile web add dsh-learnharness` |
| **GitHub 源**（无需 npm） | `dsh plugin --profile web add github:tianweichao/dsh-learnharness` |
| **本地目录** | `dsh plugin --profile web add /path/to/dsh-learnharness`，或 GUI：插件 → 本地插件目录 |

桌面版 profile 由 Electron 独占，CLI 不接管，请在 GUI 里安装（同一路径/包名）。

装完 **host 侧改动需要重启 DSH**；客户端 bundle 由 `dsh-client-hmr` 热替换，改完刷新页面（⌘R）即可。

### 兼容性

| 项 | 值 |
|---|---|
| DSH | `>= 0.2.0`（在 `0.2.2-rc.1` 上开发与验证） |
| 平台 | macOS / Linux / Windows（纯 Node 内置模块 + 浏览器 bundle，无原生依赖） |
| 权限 | 只读写 `$DSH_HOME/learn/`，**不发起任何网络请求** |
| 外部服务 | 无 |
| 卸载 | 插件管理器移除，或从 `dsh.profile.bundles` 删掉；学习数据留在 `$DSH_HOME/learn/` |

依赖：DSH `>= 0.2.0`。插件对 `@deepseek-ai/dsh-tools` / `schemastery` 的导入做了 try/catch：解析不到时用内置的 **DSL→JSON Schema 转换**兜底，两种路径都有测试覆盖。

---

## 数据

```
$DSH_HOME/learn/
├── sessions.json          {sessionId: slug}     会话 ↔ 主题
├── pending-index.json     {callId: slug}        按调用找未答题
└── <slug>/
    ├── topic.json         目标、阶段、strands、计划 DAG、访问记录
    ├── pending.json       已承诺、未作答的那一道题（含答案键）
    └── log.jsonl          已作答记录
```

- **没有任何删除逻辑**：只创建、只覆盖、只追加；清空 pending 是写 `null`。
- 未作答超过 **12 小时**自动作废（`pendingTtlMs` 可配）。
- 题目**绑定会话**：别的会话看不到这道题。
- 主题用过的会话**全部被归档**时，该主题自动隐藏（DSH 的「归档」= `workspaceRegistry.archivedSessionIds`）。
- 数据全在本机，插件不发起任何网络请求。

---

## 配置（profile patch 里的 `config`）

```yaml
- insert:
    - id: learnharness
      name: dsh-learnharness
      config:
        waitTimeoutMs: 600000      # 旧字段，保留兼容
        claimTimeoutMs: 15000      # 旧字段，保留兼容
        pendingTtlMs: 43200000     # 未答题过期时间（默认 12 小时）
        storeDir: ''               # 空 = $DSH_HOME/learn
```

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 答案键会随工具参数进入浏览器 | 卡片不渲染它，但翻 devtools 可见。反谄媚机制不受影响（模型作答前已承诺、回读后不能改） |
| 8 个 `learn_*` 工具全局注册 | 写代码的会话里工具表也会多这 8 项。干净的解法是做成 `dsh-agent-preset` 的 `learning` 预设 |
| 没有知识图谱 | 跨会话靠 `log.jsonl` 与笔记 |
| 作答历史上限 20 条 | 只显示最近 20 次作答 |
| 依赖 DSH 内部 API | `ctx.slots` / `ctx.sidebarRightTabs` / `ctx.sessions.scope()` 等属于 `0.2.x` 的实现细节，升级可能变动 |

---

## 开发与测试

```bash
# 宿主半冒烟测试：假 cordis ctx，不需要模型、不需要 GUI
DSH_HOME="$(mktemp -d)/dsh-home" node test/host-smoke.mjs
```

覆盖 40+ 项断言：工具注册、非法计划被拒、出题立即返回、卡片载荷不含答案键、错答判错、重复提交幂等、未答题时拒绝再出题、代答通道、位置/阶段派生、会话隔离、TTL 过期、归档隐藏、作答历史字段。

**验证脚本一律使用一次性 `DSH_HOME`，不要跑在真实目录上；仓库内没有任何指向 `$DSH_HOME` 的删除逻辑。**

客户端半是手写的 lazy-CJS bundle（`lib/client.js`，`window.__ModuleLoader__.load({ id, factory })`），没有构建步骤；改完需要让宿主重新组合（重启或 toggle 插件）后再刷新页面。

---

## 路线图

- [ ] `learning` agent 预设：只在学习会话挂载这 8 个工具
- [ ] 知识图谱（命题 / 推理链）与跨会话引用
- [ ] 练习模式的提示阶梯 R0–R5 与错因分类落库
- [ ] 计划 DAG 的图形化渲染（当前是列表）

---

## License

[AGPL-3.0](LICENSE)，与上游 LearnHarness 一致。
