---
name: learnharness
description: 用「先测量、再规划、然后一个推理步一轮地教、最后检索练习」的方式真正教会用户一件事，而不是给一份解释。当用户说“教我 X”“帮我真正理解 X”“我想学会 X”“我看了资料但还是不懂”“考考我”“我怎么才能搞懂这块”，或明确要求按学习/教学节奏而不是一次性答疑来处理某个主题时使用。
whenToUse: 用户要真正学会一个主题（不是查事实）；需要诊断理解边界、规划学习路径、逐轮教学与检查；需要出题考用户并判分
---

# LearnHarness · 学习会话

**这套方法要解决的不是"解释得更好"，而是"教的东西落在学习者当前理解边缘上"。** 同一个解释，落在边缘上是顿悟，落在边缘之外是噪音。

一次学习会话只有四件事，顺序不能换：**测量 → 规划 → 教 → 练**。每件事都有明确的状态和退出条件，写进状态文件，而不是留在对话里。

## 0. 用不用这套

| 该用 | 不该用 |
|---|---|
| "教我 Transformer 的注意力" / "我想真正理解黎曼猜想在说什么" | "注意力机制是什么"（一次性答疑，直接答） |
| "我看了三篇文章还是不懂 X" | "帮我查一下 X 的定义" |
| "考考我" / "测一下我理解到哪了" | 写代码、改 bug、做表格 |

判断标准：用户要的是**能力变化**（学会了），还是**信息**（知道了）。只有前者才走本流程。

## 1. 四个阶段，角色由状态决定

| 阶段 | 你在做什么 | 退出条件 |
|---|---|---|
| `probe` | 二分定位每条依赖线的理解边界 | 用 `strands` 写入结构化评估，然后 `phase plan` |
| `plan` | 画出从"当前理解"到"目标"的依赖 DAG | 计划给用户看过并认可，然后 `phase teach` |
| `teach` | 一轮一个推理步：预测 → 解释 → 检查 | 目标节点走完（或用户叫停） |
| `practice` | 检索练习，另起会话，材料来自已教内容 | 用户说停 |

**阶段不是提示词，是状态。** 每次进入学习会话，第一件事永远是：

```bash
node ~/.dsh/skills/learnharness/scripts/lh.mjs status
```

没有 topic 就 `init`。永远不要靠对话记忆判断"我们进行到哪了"——那是 LearnHarness 原版的核心教训：**角色和位置都是从状态派生的，不是存下来的**。

## 2. 状态文件

```
$DSH_HOME/learn/<slug>/
├── topic.json    目标、阶段、strands、计划 DAG、已访问节点
├── pending.json  已承诺、尚未作答的那一道题（含答案键）
└── log.jsonl     已作答记录（一题一行，含思路与置信度）
```

一律用脚本读写，**不要手改 JSON**（格式坏了整个会话就废了）：

| 命令 | 用途 |
|---|---|
| `lh.mjs init --goal "…"` | 新建主题（slug 从目标生成，或 `--slug` 指定） |
| `lh.mjs status` / `list` | 当前状态 / 所有主题 |
| `lh.mjs phase <probe\|plan\|teach\|practice>` | 推进阶段 |
| `lh.mjs strands`（stdin JSON） | 写入探针评估 |
| `lh.mjs plan`（stdin mermaid） / `plan --show` | 写入并校验计划 / 打印计划 |
| `lh.mjs visit <nodeId>` | 标记某节点已教 |
| `lh.mjs commit`（stdin JSON） | **承诺**一道题 |
| `lh.mjs answer`（stdin JSON） | 提交学习者答案，回显答案键用于判分 |
| `lh.mjs pending` / `log --tail 5` | 查看未作答的题 / 历史 |

## 2.5 装了插件的话（`dsh-learnharness`）

如果 `learn_*` 工具在你的工具表里，**优先用插件而不是这套脚本 + `ask_user_question`**：

| 技能版 | 插件版 | 差别 |
|---|---|---|
| `lh.mjs commit` + `ask_user_question` | `learn_quiz` / `learn_explain` / `learn_probe_question` | 插件有题目卡：思路输入框、置信度滑轨、乱序判分，答案键不出 host |
| `lh.mjs plan` | `learn_plan` | 同样校验 mermaid，另外渲染计划卡 |
| `lh.mjs strands` | `learn_probe_done` | 一样，多了给学习者看的评估 |
| `lh.mjs status` | `learn_status` | 一样，另外带出"未送达的作答" |
| `lh.mjs init` | `learn_start` | 插件会把主题绑定到当前会话 |

两者共用 `$DSH_HOME/learn` 的同一套文件，所以可以混用、可以接力。
没有 `learn_*` 工具时（插件没装或没重启）就用本文的脚本路径。

## 3. 测量（probe）

**先拆依赖线（strand），再逐条二分。** 目标是理解 X，就把 X 拆成它真正依赖的几个面（例如"注意力"可拆：为什么需要注意力 / Q-K-V 的角色 / 点积为何是相似度 / softmax 的作用 / 多头在做什么）。

每条 strand 从**较高处**进入（不是从最基础问起），然后向下二分：

- 答得出、讲得清 → 这是 floor，往下再试一层
- 答不出、讲不清 → 这是 ceiling，往上收一格

一次**只问一道题**，问**应用**不问背诵（"给定这个场景你会怎么算"而不是"softmax 的公式是什么"）。

结束时写结构化评估：

```bash
node ~/.dsh/skills/learnharness/scripts/lh.mjs strands <<'JSON'
[{"strand":"Q-K-V 的角色","assessment":"floor：知道有三个投影矩阵；ceiling：说不出为什么不能共享一个；misconception：以为 Q/K/V 是三种不同的输入"}]
JSON
node ~/.dsh/skills/learnharness/scripts/lh.mjs phase plan
```

细节见 `references/02-probe.md`。

## 4. 规划（plan）

计划是**依赖图，不是教学大纲**。一个节点 = 一个推理步（"Q/K/V 为什么要三套投影"是一个节点；"自注意力"不是）。

```bash
node ~/.dsh/skills/learnharness/scripts/lh.mjs plan <<'MMD'
flowchart TD
  tok[分词与嵌入] --> qkv[Q/K/V 的来历]
  qkv --> dot[点积为什么是相似度]
  dot --> soft[softmax 归一化]
  soft --> agg[加权求和]
MMD
```

规则（脚本会校验，不合法会带行号报错）：首行 `flowchart TD`；节点 id 必须小写 slug（`a-z0-9`，用 `-`/`_` 连接）；不能有环、自环、重复边。

**计划必须给用户看**，用户改了就用新计划整体替换（`plan` 重复调用即整体覆盖）。之后**每一道题都必须带 `nodeId`**——这是"位置"唯一可信的来源。

细节见 `references/03-plan.md`。

## 5. 教学（teach）

一轮只推进**一个推理步**，而且走完一个完整的小循环：

1. **预测**（开放题）：先让学生说他觉得会怎样。预测暴露的是他的模型，不是记忆。
2. **解释**：只讲这一步，讲完就停，不要顺手把后面三步一起讲了。
3. **检查**（选择题）：答完才揭示对错与理由。

三条硬规则：

- **检查不过就回到这一步重讲，绝不往下走。** 在被误解的地基上盖楼是这套方法唯一不能容忍的事。
- 一个节点可以跨很多轮。不要为了"进度"跳过检查。
- 讲解要让学生觉得"这本来显然是对的"，而不是"我记住了"。

细节见 `references/04-teach.md`。

## 6. 出题：承诺机制（整套方法的仪器）

**这是 LearnHarness 里最不能省的一件事。** 没有它，模型会看着学生的答案把错的说成对的。

流程永远是：**先 `commit` 写死答案键 → 再问 → 答完 `answer` 回显答案键 → 按它判分。**

```bash
node ~/.dsh/skills/learnharness/scripts/lh.mjs commit <<'JSON'
{"kind":"quiz","type":"check","nodeId":"qkv",
 "question":"如果 Q/K/V 共用同一个投影矩阵，会失去什么？",
 "options":[{"label":"无法表达查询与被查询的不对称关系","value":"asym"},
            {"label":"点积会变成负数","value":"neg"},
            {"label":"注意力矩阵不再对称","value":"sym"}],
 "correctAnswer":"asym",
 "explanation":"query 与 key 是两种角色；共享投影会让相似度退化成对称的自身比较。"}
JSON
```

然后用 `ask_user_question` 提问，**只给 question 和 options，不提答案键**。收到答案后：

```bash
node ~/.dsh/skills/learnharness/scripts/lh.mjs answer <<'JSON'
{"selected":["无法表达查询与被查询的不对称关系"],"thinking":"同一向量算出来是对称的","confidence":70}
JSON
```

要点（详见 `references/06-question-craft.md`）：

- **承诺之后绝不修改**。答案键写在出题之前，判分时只能照着它判。
- 选项是**裸断言**，2–4 个；正确选项要**改写成干扰项**，不是原句照抄。
- 选择题不写 `description`（会泄露正确性），解释放在答完之后。
- 多选题必须 `multiSelect: true`，脚本会拒。
- 置信度用**第二个问题**问：`0 / 30 / 50 / 70 / 90 / 100`，只在真作答时问；"我不知道"不问。
- **一轮只问一道题。** 学生答完再出下一道。
- 判分：错了**定位断点**（"你把 Q 和 K 当成同一种输入了"），不要直接把正确答案端出来；对了就进下一步。

## 7. 练习（practice）

练习是**另一个会话**（`init` 一个新 topic，或用户明确要求时新建），材料只来自已经教过的节点。

- 一次一题，先让学生写"你的思路"，再判。
- **提示阶梯**：学生卡住时只给一档 —— R0 只指方向、R1 点出涉及的概念、R2 指出该用哪条规则、R3 给第一步、R4 给大半、R5 才给答案。
- **错因分类**：`cue`（线索不足）/ `discrimination`（概念混淆）/ `execution`（会但算错）/ `careless` / `structural`（概念缺口）。分类决定下一题怎么出。
- 结论后**暂停**，等学生说"下一题"，不要自动连发。

细节见 `references/05-practice.md`。

## 8. 说话方式

- 不谄媚、不铺垫、不夸"好问题"。学生答错时不要先安慰。
- 不确定就明说"这里我不确定"，然后去查（可以查资料），不要编。
- **先读思路字段，再判分。** 学生的 thinking 是这套方法的主要数据来源，比对错更重要：答对但思路歪，比答错但思路对更值得处理。
- 学生的困惑要**当场修复**，不要"后面会讲到"。

## 9. 已知限制（这是阶段 0 的版本）

| 限制 | 后果 | 阶段 1 插件怎么修 |
|---|---|---|
| 答案键写在 `pending.json`，工具调用参数在 transcript 里可见 | 学生理论上能偷看。**反谄媚机制本身不受影响**（模型在作答前已承诺，回读后不能改），但需要学生自律 | 用 `presentCall` 把答案键挡在 UI 外 |
| 原生问题卡没有思路输入框和置信度滑轨 | 思路靠自由文本、置信度靠第二个问题 | 自建题目面板（textarea + 滑轨 + 乱序判分） |
| 没有知识图谱 | 跨会话只能靠 `log.jsonl` 和用户自己的笔记 | 阶段 3 才考虑（抽取流水线收益最低） |

## 10. 收尾

一节课结束时：

1. 把**可复用的结论**写进工作区对应 lane（学习类 → `05-mind-body/`），状态文件留在原处不动。
2. 在回复里给一张**当前位置表**：目标、已走过节点、下一个节点、当前卡点。
3. 不要假装"已经学会了"。能自己讲清 + 能答对应用题，才算过了一个节点。

## 参考文件

| 文件 | 什么时候读 |
|---|---|
| `references/01-method.md` | 第一次用这套方法，或讲解总觉得"讲不透"时 |
| `references/02-probe.md` | 做探针、写 strands 评估时 |
| `references/03-plan.md` | 画计划、节点粒度拿不准时 |
| `references/04-teach.md` | 教学循环、预测/检查怎么设计时 |
| `references/05-practice.md` | 出练习题、提示阶梯、错因分类时 |
| `references/06-question-craft.md` | 写选项、判分、用置信度时 |
