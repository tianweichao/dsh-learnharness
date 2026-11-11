# learnharness — DSH 技能版（阶段 0）

把 [LearnHarness](https://github.com/amosblomqvist/learnharness) 的**教学方法**搬进 DSH，
不搬它的应用。零代码改动：一个技能 + 一个状态工具脚本。

## 这是什么

LearnHarness 是一个独立的学习应用（Next.js + Electron）。它真正有价值的部分不是那个应用，
而是三样东西：

1. **方法提示词**——测量理解边界、画依赖图、一个推理步一轮地教；
2. **带"承诺答案"的提问仪器**——先写死答案键再出题，防止模型看着学生的答案改判；
3. **位置从调用派生**——计划节点的进度不是存下来的，是从"最近一道带 nodeId 的题"推出来的。

这三样都能在 DSH 里用「技能 + 状态文件」表达。阶段 0 就是把它们搬过来。

## 用法

技能会在你说「教我 X」「我想真正理解 X」「考考我」时自动加载。也可以手动：

```
skill learnharness
```

然后按 SKILL.md 的四阶段走：`probe` → `plan` → `teach` → `practice`。

## 状态存在哪

```
$DSH_HOME/learn/<slug>/
├── topic.json    目标、阶段、strands、计划 DAG、已访问节点
├── pending.json  已承诺、尚未作答的那一道题（含答案键）
└── log.jsonl     已作答记录（一题一行，含思路、置信度、判分）
```

**永远用 `scripts/lh.mjs` 读写，不要手改 JSON。** 脚本会做全部校验：
mermaid 计划的 id 规则与环检测、答案键必须在选项里、多选必须显式声明、
未答题未清空时拒绝出下一题、nodeId 必须在计划里。

```bash
node ~/.dsh/skills/learnharness/scripts/lh.mjs help
```

## 与 LearnHarness 原版的差异

| 原版 | 这里 | 原因 |
|---|---|---|
| `details` 字段（UI 可见、模型不可见） | 没有等价物 | DSH 技能层没有 UI 通道；答案键落在 `pending.json`，工具调用参数在 transcript 里可见 |
| 客户端乱序 + 判分 | 用 `ask_user_question` 原生卡，服务端判分 | 技能层没有客户端代码 |
| 思路输入框 + 置信度滑轨 | 思路靠自由文本，置信度靠第二个问题（0/30/50/70/90/100） | 原生问题卡只有选项 + 自由文本 |
| 知识图谱（命题/推理链 + 抽取流水线） | **不搬** | 原版教师从不读图谱；3000 行换来的地图没有教学决策读它 |
| 研究 / PDF / demo / 视觉子代理 | 不搬 | DSH 已有 |
| 三套 agent（prober/teacher/practitioner） | 一个 agent + 阶段状态 | DSH 技能没有"换角色"的机制，用阶段文件替代 |

### 已知妥协：答案键可见

`pending.json` 里的答案键、以及 `commit` 的 bash 调用参数，在会话里都是可见的。

**反谄媚机制本身不受影响**——模型在作答前已经承诺，`answer` 会回读答案键，回读后不允许改。
受影响的是"学生理论上能偷看"。阶段 1 的插件用 `presentCall` 把答案键挡在 UI 外。

## 阶段 1 计划（插件）

`~/dsh-plugins/dsh-learnharness/`，宿主半 + 客户端半：

- 宿主：`quiz` / `explain` / `probe` / `recall` / `plan_init` / `probe_done` 工具，
  `presentCall` 隐藏答案键，`finalizeContent` 给模型紧凑投影，
  动态 system-prompt 段（按阶段切换教义），自建 answer 路由；
- 客户端：`tool.call.toolview` 自定义题目卡（思路 textarea + 置信度滑轨 + 乱序判分）、
  `sidebar.right.pane.tab` 计划面板（DAG + 当前位置）；
- 复用本目录 `scripts/lh.mjs` 的存储层与 mermaid 解析。

## 验证（使用独立 DSH_HOME）

**任何验证脚本都必须指向一次性目录，不要跑在真实 `$DSH_HOME` 上：**

```bash
export DSH_HOME="$(mktemp -d)/dsh-home"
node scripts/lh.mjs init --goal "测试" --slug t
```

`lh.mjs` 本身**没有任何删除逻辑**：只创建、只追加、只写 `null` 占位，
不 `rm`、不 `rmSync`、不递归删任何路径。
