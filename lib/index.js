/**
 * dsh-learnharness —— 把 LearnHarness 的教学法做成 DSH 插件（阶段 1）。
 *
 * 核心机制（不能省的三件）：
 *   1. **承诺**：出题工具要求模型在出题之前就写好答案键；答案键落盘、进 pending.json，
 *      答题后回读，模型无权修改。
 *   2. **暂停**：工具 `execute` 挂起，等客户端题目卡 POST 答案；答案作为这次调用的结果回灌。
 *      没有客户端时（CLI/无 GUI），用 `learn_answer` 代答。
 *   3. **派生位置**：计划进度只由"最近一道带 nodeId 的题"决定，不存 progress 字段。
 *
 * 存储与 `~/.dsh/skills/learnharness` 技能共用 $DSH_HOME/learn（见 lib/store.js）。
 */
import {
  resolveRoot, resolveSlug, slugForSession, listTopics, loadTopic, saveTopic, createTopic, bindSession, sessionsForSlug,
  readPending, writePending, pendingByCallId, appendLog, readLog, answeredByCallId,
  deriveState, parseMermaidPlan,
} from './store.js';

// 共享包用 try/catch 导入：解析不到也不能让 DSH 启动失败。
// 关键：拿不到真的 defineTool 时，参数 DSL（`required: true` 写在属性上）必须自己
// 转成合法 JSON Schema，否则模型会收到非法 schema。
let realDefineTool = null;
let z = null;
try {
  ({ defineTool: realDefineTool } = await import('@deepseek-ai/dsh-tools'));
} catch (err) {
  console.error('[learnharness] 无法导入 @deepseek-ai/dsh-tools，改用内置的 DSL→JSON Schema 转换：', err?.message || err);
}

const SCALAR_KEYS = ['type', 'enum', 'const', 'description', 'title', 'default', 'examples'];
const pickScalar = (node) => Object.fromEntries(SCALAR_KEYS.filter((key) => node[key] !== undefined).map((key) => [key, node[key]]));

/** 单个 DSL 节点 → JSON Schema 节点 */
const dslNodeToJsonSchema = (node) => {
  if (!node || typeof node !== 'object') return {};
  if (node.type === 'json') return {};
  if (node.type === 'array') {
    return { ...pickScalar({ ...node, type: 'array' }), items: node.items ? dslNodeToJsonSchema(node.items) : undefined };
  }
  if (node.type === 'object') {
    const { schema, required } = dslPropertyMapToJsonSchema(node.properties ?? {});
    return {
      ...pickScalar({ ...node, type: 'object' }),
      properties: schema,
      ...(required.length ? { required } : {}),
      additionalProperties: node.additionalProperties !== false,
    };
  }
  return pickScalar(node);
};

/** 参数属性表（`required: true` 标在属性上）→ 对象 JSON Schema */
const dslPropertyMapToJsonSchema = (spec) => {
  const properties = {};
  const required = [];
  for (const [key, node] of Object.entries(spec ?? {})) {
    if (!node || typeof node !== 'object') continue;
    const { required: isRequired, ...rest } = node;
    if (isRequired === true) required.push(key);
    properties[key] = dslNodeToJsonSchema(rest);
  }
  return { schema: properties, required };
};

const defineTool = realDefineTool ?? ((spec) => {
  const { schema, required } = dslPropertyMapToJsonSchema(spec.parameters ?? {});
  return {
    ...spec,
    parameters: { type: 'object', properties: schema, ...(required.length ? { required } : {}), additionalProperties: false },
    // output.schema 在真包里也走值 DSL，兜底时同样要转成原生 JSON Schema
    output: spec.output ? { ...spec.output, schema: dslNodeToJsonSchema(spec.output.schema) } : spec.output,
  };
});
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch (err) {
  console.error('[learnharness] 无法导入 @deepseek-ai/schemastery，跳过配置校验：', err?.message || err);
}

export const name = 'learnharness';
/** 是否拿到了真的 defineTool（拿不到就用内置 DSL 转换）——测试用 */
export const usingRealDefineTool = Boolean(realDefineTool);
export const inject = ['tools', 'webServer', 'userQuestions'];

export const Config = z ? z.object({
  /** 一次提问等学习者作答的上限；超时则把 answered:false 交给模型，题仍留在 pending */
  waitTimeoutMs: z.number().default(600000),
  /** 等客户端卡片认领的时间（旧字段，保留兼容） */
  claimTimeoutMs: z.number().default(15000),
  /** 未作答的题超过这个时长就自动作废（默认 12 小时），避免会话删了题还挂着 */
  pendingTtlMs: z.number().default(43200000),
  /** 存储目录；空 = $DSH_HOME/learn（与技能共用） */
  storeDir: z.string().default(''),
}) : undefined;

const text = (value) => [{ type: 'text', text: String(value) }];
const line = (label, value) => (value === undefined || value === null || value === '' ? null : `${label}：${value}`);
const joinLines = (lines) => lines.filter(Boolean).join('\n');

/** 统一的工具输出契约：ok 必在，其余透传。 */
const OUTPUT = {
  // 值 DSL 写法：required 标在属性上；object 必须显式声明 additionalProperties
  schema: { type: 'object', properties: { ok: { type: 'boolean', required: true } }, additionalProperties: true },
  render: (args, value) => text(value.render ?? JSON.stringify(value, null, 2)),
};

/* ─────────────────────────── 作答结算 ─────────────────────────── */

const grade = (pending, selected) => {
  const keys = Array.isArray(pending.correctAnswer) ? pending.correctAnswer : [pending.correctAnswer];
  const chosen = new Set(
    selected.map((label) => pending.options?.find((option) => option.label === label)?.value ?? label),
  );
  return chosen.size === keys.length && keys.every((key) => chosen.has(key));
};

/**
 * 记录一次作答并（若有等待者）唤醒挂起的工具调用。
 * 幂等：同一 callId 重复提交返回已有结论，不重复写日志。
 */
const settle = (root, slug, pending, input, waiters) => {
  const already = answeredByCallId(root, pending.callId);
  if (already) return { record: already, duplicate: true };

  const selected = Array.isArray(input.selected) ? input.selected.map(String) : input.selected ? [String(input.selected)] : [];
  const unknown = selected.filter((label) => pending.options?.length && !pending.options.some((option) => option.label === label));
  if (unknown.length) return { error: `这些选项不属于本题：${unknown.join(' / ')}` };

  const dontKnow = input.dontKnow === true;
  const correct = pending.kind === 'quiz' && !dontKnow ? grade(pending, selected) : null;
  const record = {
    ...pending,
    selected,
    text: input.text ? String(input.text) : null,
    other: input.other ? String(input.other) : null,
    thinking: input.thinking ? String(input.thinking) : null,
    readingThinking: input.readingThinking ? String(input.readingThinking) : null,
    confidence: Number.isFinite(Number(input.confidence)) && !dontKnow ? Number(input.confidence) : null,
    dontKnow,
    correct,
    answeredAt: new Date().toISOString(),
    deliveredAt: null,
  };
  appendLog(root, slug, record);
  writePending(root, slug, null);
  const waiter = waiters.get(pending.callId);
  if (waiter) waiter(record);
  return { record };
};

/* ─────────────────────────── 插件主体 ─────────────────────────── */

export function apply(ctx, config = {}) {
  const root = resolveRoot(config.storeDir ?? '');
  const waitTimeoutMs = Number(config.waitTimeoutMs ?? 600000) || 600000;
  const claimTimeoutMs = Number(config.claimTimeoutMs ?? 15000) || 15000;
  const pendingTtlMs = Number(config.pendingTtlMs ?? 43200000) || 43200000;

  /** 过期未作答的题直接作废（会话删掉后题不该永远挂着）。 */
  const prunePending = (slug) => {
    const pending = readPending(root, slug);
    if (!pending) return null;
    const created = Date.parse(pending.createdAt ?? '') || 0;
    if (created && Date.now() - created > pendingTtlMs) {
      writePending(root, slug, null);
      return null;
    }
    return pending;
  };
  /** callId -> (record) => void */
  const waiters = new Map();

  const sessionOf = (exec) => exec?.agent?.sessionId ?? exec?.agent?.id ?? null;

  /** 客户端自检上报（排查"卡片没渲染"用） */
  let clientReport = null;

  /** 归档的会话集合（DSH 左侧栏"归档"= 看不见，学习记录要跟着走）。 */
  const archivedSessions = () => {
    try {
      const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
      return new Set(registry?.archivedSessionIds ?? []);
    } catch {
      return new Set();
    }
  };

  /** 主题用过的会话全被归档 → 这个主题也该藏起来。 */
  const isTopicArchived = (slug, archived) => {
    const sessions = sessionsForSlug(root, slug);
    return sessions.length > 0 && sessions.every((sessionId) => archived.has(sessionId));
  };

  const requireTopic = (exec) => {
    const slug = resolveSlug(root, sessionOf(exec));
    if (!slug) return { error: '还没有学习主题。先调用 learn_start（参数 goal）开一个。' };
    const topic = loadTopic(root, slug);
    if (!topic) return { error: `主题 "${slug}" 的记录不见了，重新 learn_start。` };
    return { slug, topic };
  };

  /**
   * 出题：落盘承诺后**立即返回**，不挂起等答案。
   *
   * 早期版本让工具挂起等卡片 POST 答案，问题很实际：学习者在对话里一打字就打断
   * 工具调用，pending 记录残留，输入框上方的 dock 就永远显示那道题。
   * 现在改成非阻塞——学习者答完后卡片会自动发一条消息触发新回合，模型用
   * learn_status 取回作答（未送达的答案会一并带出）。
   */
  const poseQuestion = (slug, pending) => {
    writePending(root, slug, pending);
    return pending.callId;
  };

  const answerRender = (record, extra = []) => joinLines([
    `已作答：${record.dontKnow ? '学习者选择"我不知道"' : (record.selected ?? []).join(' / ') || '（自由作答）'}`,
    line('置信度', record.confidence),
    line('他的思路', record.thinking),
    ...extra,
    record.correct === true ? '判定：对' : record.correct === false ? '判定：错' : null,
  ]);

  const tools = [];

  /* ── learn_start ─────────────────────────────────────────────── */
  tools.push(defineTool({
    name: 'learn_start',
    description: '开一个（或接续一个）学习主题。LearnHarness 教学法的入口：先测量理解边界，再规划依赖图，然后一轮一个推理步地教。开始任何教学前先调这个，或在已有主题时用它确认当前阶段。',
    parameters: {
      goal: { type: 'string', required: true, description: '学习者想真正理解的东西，一句话' },
      slug: { type: 'string', description: '主题 id（小写 slug）；省略则从 goal 生成' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const goal = String(args.goal ?? '').trim();
      if (!goal) return { ok: false, error: 'goal 不能为空' };
      const { topic, created } = createTopic(root, goal, args.slug ? String(args.slug) : undefined);
      bindSession(root, sessionOf(exec), topic.slug);
      const state = deriveState(root, topic);
      return {
        ok: true,
        created,
        slug: topic.slug,
        phase: state.phase,
        progress: state.progress,
        plan: state.plan ? state.plan.nodes.map((node) => node.id) : null,
        pending: state.pending,
        render: joinLines([
          `${created ? '已创建' : '已接续'}学习主题 "${topic.slug}"：${topic.goal}`,
          `当前阶段：${state.phase}${state.progress ? `（计划进度 ${state.progress.done}/${state.progress.total}）` : ''}`,
          state.pending ? `⚠️ 有一道未作答的题（${state.pending.kind}），先处理它` : null,
          state.phase === 'probe' ? '下一步：探针 —— 拆依赖线（strands），每条从高处进入、向下二分，一次只问一题。' : null,
          state.phase === 'plan' ? '下一步：learn_plan 画依赖 DAG，然后给学习者看。' : null,
          state.phase === 'teach' ? '下一步：继续教学循环，一轮一个推理步。' : null,
        ]),
      };
    },
  }));

  /* ── learn_status ────────────────────────────────────────────── */
  tools.push(defineTool({
    name: 'learn_status',
    description: '读学习主题的当前状态：阶段、计划与当前位置、未作答的题、尚未送达的作答记录。每次进入学习会话、或不确定进行到哪时先调它——不要靠对话记忆判断位置。',
    parameters: {},
    output: OUTPUT,
    async execute(args, exec) {
      const found = requireTopic(exec);
      if (found.error) return { ok: false, error: found.error };
      const state = deriveState(root, found.topic);
      const unread = state.log.filter((entry) => !entry.deliveredAt);
      if (unread.length) {
        // 标记已送达：这些答案会在本次调用里交给模型
        const { log } = { log: readLog(root, found.slug) };
        for (const entry of log) {
          if (!entry.deliveredAt) entry.deliveredAt = new Date().toISOString();
        }
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
          `${root}/${found.slug}/log.jsonl`,
          `${log.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
        );
      }
      return {
        ok: true,
        slug: state.slug,
        goal: state.goal,
        phase: state.phase,
        current: state.current,
        visited: state.visited,
        upcoming: state.upcoming,
        progress: state.progress,
        pending: state.pending,
        unread: unread.map((entry) => ({
          callId: entry.callId,
          kind: entry.kind,
          nodeId: entry.nodeId,
          selected: entry.selected,
          text: entry.text,
          thinking: entry.thinking,
          confidence: entry.confidence,
          correct: entry.correct,
          answeredAt: entry.answeredAt,
        })),
        render: joinLines([
          `主题：${state.goal}（${state.slug}）`,
          `阶段：${state.phase}${state.progress ? ` · 进度 ${state.progress.done}/${state.progress.total}` : ''}`,
          line('当前节点', state.current),
          state.upcoming.length ? `未走：${state.upcoming.join(' → ')}` : null,
          state.pending ? `未作答：${state.pending.kind}（callId ${state.pending.callId}）${state.pending.question}` : null,
          unread.length
            ? `\n还有 ${unread.length} 条作答未处理：\n${unread.map((entry) => `- ${entry.kind}${entry.nodeId ? ` [${entry.nodeId}]` : ''}：选了 ${(entry.selected ?? []).join(' / ') || entry.text || '（空）'}${entry.correct === null ? '' : entry.correct ? '（对）' : '（错）'}；置信度 ${entry.confidence ?? '—'}；思路：${entry.thinking ?? '—'}`).join('\n')}`
            : null,
        ]),
      };
    },
  }));

  /* ── learn_plan ──────────────────────────────────────────────── */
  tools.push(defineTool({
    name: 'learn_plan',
    description: '写入（或整体替换）学习计划 DAG。计划是依赖图不是大纲：一个节点 = 学生需要接受的一个推理步，边表示"没有 a 就无法理解 b"。首行必须 `flowchart TD`，节点 id 只能是小写 slug。写完必须把计划给学习者看、等他认可，再开始教学。之后每道题都要带 nodeId。',
    parameters: {
      mermaid: { type: 'string', required: true, description: 'mermaid 子集：flowchart TD + a[标题] --> b[标题]' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const found = requireTopic(exec);
      if (found.error) return { ok: false, error: found.error };
      const parsed = parseMermaidPlan(String(args.mermaid ?? ''));
      if (!parsed.ok) {
        return {
          ok: false,
          errors: parsed.errors,
          render: `计划没通过校验，按行修一下：\n${parsed.errors.join('\n')}`,
        };
      }
      const topic = found.topic;
      topic.plan = { mermaid: String(args.mermaid).trim(), nodes: parsed.nodes, edges: parsed.edges };
      topic.visited = [];
      topic.current = null;
      topic.updatedAt = new Date().toISOString();
      if (topic.phase === 'probe') topic.phase = 'plan';
      saveTopic(root, topic);
      return {
        ok: true,
        nodeIds: parsed.nodes.map((node) => node.id),
        nodes: parsed.nodes,
        render: joinLines([
          `计划已写入（${parsed.nodes.length} 个节点）。合法 nodeId：${parsed.nodes.map((node) => node.id).join(', ')}`,
          '',
          ...parsed.nodes.map((node) => `- ${node.id}：${node.title}`),
          '',
          '现在把这张图给学习者看，问一句"有没有多余的、缺的、或者顺序不对的"。他认可后开始第一个节点。',
        ]),
      };
    },
  }));

  /* ── learn_probe_done ────────────────────────────────────────── */
  tools.push(defineTool({
    name: 'learn_probe_done',
    description: '结束探针阶段：把每条依赖线（strand）的理解边界写成结构化评估。每条要具体到 floor（能自己讲清到哪）/ ceiling（从哪讲不清）/ misconception（具体误解）。写完就进入规划。',
    parameters: {
      strands: {
        type: 'array',
        required: true,
        description: '每条依赖线一条：{strand, assessment}',
        items: {
          type: 'object',
          properties: {
            strand: { type: 'string', required: true },
            assessment: { type: 'string', required: true },
          },
          additionalProperties: true,
        },
      },
      summary: { type: 'string' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const found = requireTopic(exec);
      if (found.error) return { ok: false, error: found.error };
      const list = Array.isArray(args.strands) ? args.strands : [];
      if (!list.length) return { ok: false, error: 'strands 不能为空' };
      const topic = found.topic;
      topic.strands = list
        .map((item) => ({ strand: String(item.strand ?? '').trim(), assessment: String(item.assessment ?? '').trim() }))
        .filter((item) => item.strand);
      topic.phase = 'plan';
      topic.updatedAt = new Date().toISOString();
      saveTopic(root, topic);
      return {
        ok: true,
        strands: topic.strands.length,
        render: joinLines([
          `探针评估已记录（${topic.strands.length} 条依赖线）。它已经展示给学习者了。`,
          args.summary ? `总结：${args.summary}` : null,
          '现在进入规划：用 learn_plan 画从当前理解到目标的依赖 DAG，然后给学习者看。',
        ]),
      };
    },
  }));

  /* ── learn_probe_question（探针提问） ─────────────────────────── */
  tools.push(defineTool({
    name: 'learn_probe_question',
    description: '探针阶段向学习者提一个诊断问题，并挂起等他作答。一次只问一题；问应用不问背诵；可给选项（有选项=选择，无选项=自由回答）。作答结果会作为这次调用的结果回来。',
    parameters: {
      question: { type: 'string', required: true },
      options: {
        type: 'array',
        description: '2–4 个选项；省略则为自由回答',
        items: {
          type: 'object',
          properties: { label: { type: 'string', required: true } },
          additionalProperties: true,
        },
      },
      multiSelect: { type: 'boolean' },
      detail: { type: 'string', description: '补充说明（不要在这里泄露答案）' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const found = requireTopic(exec);
      if (found.error) return { ok: false, error: found.error };
      const existing = prunePending(found.slug);
      if (existing) return { ok: false, error: `还有一道未作答的题（${existing.kind}）。先处理它，或用 learn_status 看情况。` };
      const question = String(args.question ?? '').trim();
      if (!question) return { ok: false, error: 'question 不能为空' };
      const options = Array.isArray(args.options)
        ? args.options.map((option) => ({ label: String(option.label ?? option).trim(), value: String(option.value ?? option.label ?? option).trim() }))
        : [];
      if (options.length && options.length < 2) return { ok: false, error: '要么不给选项，要么至少 2 个' };
      const pending = {
        callId: exec.callId,
        kind: 'probe',
        nodeId: null,
        question,
        detail: args.detail ? String(args.detail) : null,
        options,
        multiSelect: args.multiSelect === true,
        correctAnswer: null,
        explanation: null,
        sessionId: sessionOf(exec),
        createdAt: new Date().toISOString(),
      };
      const callId = poseQuestion(found.slug, pending);
      return {
        ok: true,
        posed: true,
        callId,
        render: joinLines([
          '题目已提出，学习者会在输入框上方的作答卡片里作答。',
          '现在结束你的回合：不要继续出题，也不要自己替学习者回答。',
          '他提交后会自动触发新回合，那时用 learn_status 取回作答。',
        ]),
      };

    },
  }));

  /* ── learn_quiz（选择题，带承诺答案键） ───────────────────────── */
  tools.push(defineTool({
    name: 'learn_quiz',
    description: '出一道选择题并挂起等作答。必须给出 correctAnswer（选项的 value，在出题之前就承诺，之后不得修改）和 explanation（答完之后才展示）。type=predict 用于引入新推理步前的预测（答完揭示），type=check 用于解释后的检查。选项写成裸断言、长度接近、不给 description。一轮只问一题。',
    parameters: {
      type: { type: 'string', enum: ['predict', 'check'], required: true },
      nodeId: { type: 'string', required: true, description: '计划里的节点 id（位置由它派生）' },
      question: { type: 'string', required: true },
      options: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          properties: { label: { type: 'string', required: true }, value: { type: 'string' } },
          additionalProperties: true,
        },
      },
      correctAnswer: { type: 'string', required: true, description: '正确选项的 value；多选时用逗号分隔' },
      explanation: { type: 'string', required: true, description: '答完之后展示的解释' },
      multiSelect: { type: 'boolean' },
      detail: { type: 'string' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const found = requireTopic(exec);
      if (found.error) return { ok: false, error: found.error };
      const { slug, topic } = found;
      const existing = prunePending(slug);
      if (existing) return { ok: false, error: `还有一道未作答的题（${existing.kind}）。先处理它。` };
      const options = (Array.isArray(args.options) ? args.options : [])
        .map((option) => ({ label: String(option.label ?? option).trim(), value: String(option.value ?? option.label ?? option).trim() }))
        .filter((option) => option.label);
      if (options.length < 2) return { ok: false, error: '至少需要 2 个选项' };
      if (new Set(options.map((option) => option.value)).size !== options.length) {
        return { ok: false, error: '选项的 value 重复了' };
      }
      const keys = String(args.correctAnswer ?? '').split(',').map((key) => key.trim()).filter(Boolean);
      if (!keys.length) return { ok: false, error: 'correctAnswer 不能为空——必须出题前承诺' };
      for (const key of keys) {
        if (!options.some((option) => option.value === key)) {
          return { ok: false, error: `correctAnswer "${key}" 不在选项 value 里（合法值：${options.map((o) => o.value).join(' / ')}）` };
        }
      }
      if (keys.length > 1 && args.multiSelect !== true) return { ok: false, error: '多选答案必须显式 multiSelect: true' };
      const nodeId = String(args.nodeId ?? '').trim();
      if (topic.plan && !topic.plan.nodes.some((node) => node.id === nodeId)) {
        return {
          ok: false,
          error: `计划里没有节点 "${nodeId}"。合法值：${topic.plan.nodes.map((node) => node.id).join(', ')}`,
        };
      }
      const pending = {
        callId: exec.callId,
        kind: 'quiz',
        questionType: args.type,
        nodeId,
        question: String(args.question),
        detail: args.detail ? String(args.detail) : null,
        options,
        multiSelect: args.multiSelect === true,
        correctAnswer: keys.length === 1 ? keys[0] : keys,
        explanation: String(args.explanation ?? ''),
        sessionId: sessionOf(exec),
        createdAt: new Date().toISOString(),
      };
      const callId = poseQuestion(slug, pending);
      return {
        ok: true,
        posed: true,
        callId,
        nodeId,
        render: joinLines([
          '选择题已提出，学习者在作答卡片上作答（服务端按你承诺的答案键判分）。',
          '现在结束你的回合。他提交后会自动触发新回合，那时用 learn_status 取回判分与他的思路。',
        ]),
      };

    },
  }));

  /* ── learn_explain（自由回忆，模型判分） ──────────────────────── */
  tools.push(defineTool({
    name: 'learn_explain',
    description: '出一道自由回忆题（不给选项）并挂起等作答。必须给出 correctAnswer：完整的正确答案（含推理），在出题之前承诺，判分时只能照着它判，不得因为看到学习者的答案而修改。自由文本由你判分，不用规则匹配。',
    parameters: {
      nodeId: { type: 'string', required: true },
      question: { type: 'string', required: true },
      correctAnswer: { type: 'string', required: true, description: '完整正确回答（含推理），出题前承诺' },
      detail: { type: 'string' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const found = requireTopic(exec);
      if (found.error) return { ok: false, error: found.error };
      const { slug, topic } = found;
      const existing = prunePending(slug);
      if (existing) return { ok: false, error: `还有一道未作答的题（${existing.kind}）。先处理它。` };
      const committed = String(args.correctAnswer ?? '').trim();
      if (!committed) return { ok: false, error: 'correctAnswer 不能为空——必须出题前承诺' };
      const nodeId = String(args.nodeId ?? '').trim();
      if (topic.plan && !topic.plan.nodes.some((node) => node.id === nodeId)) {
        return { ok: false, error: `计划里没有节点 "${nodeId}"。合法值：${topic.plan.nodes.map((node) => node.id).join(', ')}` };
      }
      const pending = {
        callId: exec.callId,
        kind: 'explain',
        nodeId,
        question: String(args.question),
        detail: args.detail ? String(args.detail) : null,
        options: [],
        multiSelect: false,
        correctAnswer: committed,
        explanation: null,
        sessionId: sessionOf(exec),
        createdAt: new Date().toISOString(),
      };
      const callId = poseQuestion(slug, pending);
      return {
        ok: true,
        posed: true,
        callId,
        nodeId,
        render: joinLines([
          '自由回忆题已提出，学习者在作答卡片上作答。',
          '现在结束你的回合。他提交后会自动触发新回合，那时用 learn_status 取回他的回答与思路，',
          '再严格对照你出题前承诺的答案判分。',
        ]),
      };

    },
  }));

  /* ── learn_answer（无 GUI 时的代答通道） ──────────────────────── */
  tools.push(defineTool({
    name: 'learn_answer',
    description: '替学习者提交答案（用于没有题目卡界面的情形，例如 CLI，或学习者在对话里直接作答）。通常不需要：有界面时答案由题目卡自动提交。',
    parameters: {
      callId: { type: 'string', description: '题目调用的 id；省略则取当前未作答的那道' },
      selected: { type: 'string', description: '选项 label；多选用逗号分隔' },
      text: { type: 'string', description: '自由回答内容' },
      thinking: { type: 'string', description: '学习者的思路' },
      confidence: { type: 'number', description: '0–100' },
      dontKnow: { type: 'boolean' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const callId = args.callId ? String(args.callId) : null;
      const located = callId
        ? pendingByCallId(root, callId)
        : (() => {
            const found = requireTopic(exec);
            if (found.error) return null;
            const pending = readPending(root, found.slug);
            return pending ? { slug: found.slug, pending } : null;
          })();
      if (!located) return { ok: false, error: '没有未作答的题' };
      const result = settle(root, located.slug, located.pending, {
        selected: args.selected ? String(args.selected).split(',').map((label) => label.trim()).filter(Boolean) : [],
        text: args.text,
        thinking: args.thinking,
        confidence: args.confidence,
        dontKnow: args.dontKnow === true,
      }, waiters);
      if (result.error) return { ok: false, error: result.error };
      const record = result.record;
      return {
        ok: true,
        answered: true,
        correct: record.correct,
        render: joinLines([
          answerRender(record),
          record.explanation ? `解释：${record.explanation}` : null,
        ]),
      };
    },
  }));

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `learnharness.${tool.name}`);
  }

  /* ─────────────────────────── HTTP 路由 ─────────────────────────── */

  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });

  const sendJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };

  /** 题目卡读的载荷：永远不含答案键。 */
  const cardPayload = (callId) => {
    const located = pendingByCallId(root, callId);
    if (located) {
      const pending = located.pending;
      return {
        state: 'pending',
        callId,
        kind: pending.kind,
        questionType: pending.questionType ?? null,
        nodeId: pending.nodeId,
        question: pending.question,
        detail: pending.detail,
        options: (pending.options ?? []).map((option) => ({ label: option.label })),
        multiSelect: pending.multiSelect === true,
        goal: loadTopic(root, located.slug)?.goal ?? null,
      };
    }
    const answered = answeredByCallId(root, callId);
    if (answered) {
      return {
        state: 'answered',
        callId,
        kind: answered.kind,
        nodeId: answered.nodeId,
        question: answered.question,
        selected: answered.selected,
        text: answered.text,
        thinking: answered.thinking,
        confidence: answered.confidence,
        dontKnow: answered.dontKnow,
        correct: answered.correct,
        explanation: answered.explanation,
      };
    }
    return { state: 'missing', callId };
  };

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/api/learnharness/answer' && req.method === 'POST') {
      const body = await readBody(req);
      const callId = String(body.callId ?? '');
      const located = pendingByCallId(root, callId);
      if (!located) {
        const answered = answeredByCallId(root, callId);
        if (answered) return sendJson(res, 200, { ok: true, duplicate: true, ...cardPayload(callId) });
        return sendJson(res, 404, { ok: false, error: '这道题不在待答状态（可能已超时或已作答）' });
      }
      const result = settle(root, located.slug, located.pending, body, waiters);
      if (result.error) return sendJson(res, 400, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, ...cardPayload(callId) });
    }

    if (path.startsWith('/api/learnharness/card/') && req.method === 'GET') {
      const callId = decodeURIComponent(path.slice('/api/learnharness/card/'.length));
      if (!callId) return sendJson(res, 400, { ok: false, error: '缺少 callId' });
      return sendJson(res, 200, cardPayload(callId));
    }

    if (path === '/api/learnharness/selfcheck') {
      if (req.method === 'POST') {
        clientReport = { ...(await readBody(req)), receivedAt: new Date().toISOString() };
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 200, { ok: true, report: clientReport });
    }

    if (path === '/api/learnharness/dismiss' && req.method === 'POST') {
      const body = await readBody(req);
      const callId = String(body.callId ?? '');
      const located = callId ? pendingByCallId(root, callId) : null;
      const slug = located?.slug ?? resolveSlug(root, String(body.session ?? '')) ?? null;
      if (slug && readPending(root, slug)) writePending(root, slug, null);
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/learnharness/state' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      const archived = archivedSessions();
      const visibleTopics = listTopics(root).filter((topic) => !isTopicArchived(topic.slug, archived));
      // 有会话参数时**只看这个会话绑定的主题**，没有绑定就是空——
      // 之前会退回"最近修改的主题"，导致对话右边栏显示别的对话的学习记录。
      const boundSlug = sessionId ? slugForSession(root, sessionId) : null;
      const slug = sessionId
        ? boundSlug
        : (url.searchParams.get('slug') || resolveSlug(root, ''));
      if (!slug) {
        return sendJson(res, 200, {
          ok: true,
          topic: null,
          bound: sessionId ? false : null,
          topics: visibleTopics.map((topic) => topic.slug),
        });
      }
      const topic = loadTopic(root, slug);
      if (!topic) return sendJson(res, 404, { ok: false, error: '主题不存在' });
      if (isTopicArchived(slug, archived)) {
        return sendJson(res, 200, { ok: true, topic: null, archived: true, topics: visibleTopics.map((entry) => entry.slug) });
      }
      prunePending(slug);
      const state = deriveState(root, topic);
      // 题目绑定会话：不属于当前会话的题不显示（会话被删后也不会残留）
      if (sessionId && state.pending && state.pending.sessionId && state.pending.sessionId !== sessionId) {
        state.pending = null;
      }
      return sendJson(res, 200, {
        ok: true,
        topic: {
          slug: state.slug,
          goal: state.goal,
          phase: state.phase,
          plan: state.plan,
          current: state.current,
          visited: state.visited,
          upcoming: state.upcoming,
          progress: state.progress,
          pending: state.pending,
          answered: state.answered,
          recent: state.recent,
          history: state.history,
        },
        topics: visibleTopics.map((entry) => entry.slug),
      });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/api/learnharness', handler }),
    'learnharness.routes',
  );
}
