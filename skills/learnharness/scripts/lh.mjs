#!/usr/bin/env node
/**
 * lh.mjs — LearnHarness 学习会话的状态工具（阶段 0：技能版）
 *
 * 设计原则：
 *   1. 只读写 $DSH_HOME/learn/<slug>/ 下的文件，不碰会话、不删任何东西。
 *   2. 所有写入走同一个进程，JSON/JSONL 始终良构；agent 不需要手改文件。
 *   3. 计划 DAG 的解析与校验和 LearnHarness 原版同规则（mermaid 子集 + 环检测）。
 *
 * 数据布局：
 *   $DSH_HOME/learn/<slug>/topic.json    目标、阶段、strands、计划
 *   $DSH_HOME/learn/<slug>/pending.json  已承诺、尚未作答的那一道题（含答案键）
 *   $DSH_HOME/learn/<slug>/log.jsonl     已作答记录（一题一行）
 *
 * 用法见 `lh.mjs help`。除 status/log 外，其余子命令的输入一律从 stdin 读 JSON。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const ROOT = join(DSH_HOME, 'learn');

/* ─────────────────────────── 基础设施 ─────────────────────────── */

const die = (msg, code = 1) => {
  console.error(`lh: ${msg}`);
  process.exit(code);
};
const readStdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
const readJsonStdin = (what) => {
  const raw = readStdin().trim();
  if (!raw) die(`${what}: 需要从 stdin 读 JSON（heredoc 或管道）`);
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`${what}: stdin 不是合法 JSON — ${err.message}`);
  }
};
const readJson = (path, fallback = null) => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    die(`${path} 不是合法 JSON — ${err.message}`);
  }
};
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const nowIso = () => new Date().toISOString();

/** 阶段与位置都是派生的：有带 nodeId 的作答 = teach；有计划/评估 = plan；否则 probe。 */
const derivePhase = (topic, log) => {
  if (topic.mode === 'practice') return 'practice';
  if (log.some((entry) => entry.nodeId)) return 'teach';
  if (topic.plan || (topic.strands && topic.strands.length)) return 'plan';
  return 'probe';
};

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';

const topicDir = (slug) => join(ROOT, slug);
const topicFile = (slug) => join(topicDir(slug), 'topic.json');
const pendingFile = (slug) => join(topicDir(slug), 'pending.json');
const logFile = (slug) => join(topicDir(slug), 'log.jsonl');

const loadTopic = (slug) => {
  const topic = readJson(topicFile(slug));
  if (!topic) die(`找不到 topic "${slug}"（先跑 init，或用 status 列出已有 topic）`);
  return topic;
};
const saveTopic = (topic) => writeJson(topicFile(topic.slug), topic);

/** 解析 --flag value / --flag=value，其余为位置参数 */
const parseArgs = (argv) => {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[arg.slice(2)] = true;
        } else {
          flags[arg.slice(2)] = next;
          i += 1;
        }
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
};

/* ────────────────────── mermaid 计划子集解析 ────────────────────── */

const NODE_ID = /^[a-z0-9]+([_-][a-z0-9]+)*$/;

/**
 * 支持：`graph|flowchart TD|TB|LR|RL|BT` 头、`%%` 注释、`id`、`id[标题]`、`id("标题")`、
 * `-->` `==>` `-.->` 三种箭头、链式 `a --> b --> c`（拆成相邻对）、行内标签。
 * 规则与原版一致：节点 id 必须是小写 slug，违反就带行号报错。
 */
export function parseMermaidPlan(source) {
  const errors = [];
  const nodes = new Map();
  const edges = [];
  const lines = String(source).split(/\r?\n/);
  let sawHeader = false;

  const declare = (rawId, title, lineNo) => {
    const id = rawId.trim();
    if (!NODE_ID.test(id)) {
      errors.push(`第 ${lineNo} 行：节点 id "${id}" 不合法，只能用小写字母/数字，用 - 或 _ 连接`);
      return null;
    }
    const prev = nodes.get(id);
    const label = title?.trim();
    if (prev) {
      if (label && !prev.title) prev.title = label;
      return id;
    }
    nodes.set(id, { id, title: label || id });
    return id;
  };

  const parseEndpoint = (token, lineNo) => {
    const text = token.trim();
    const labelled = text.match(/^([A-Za-z0-9_-]+)\s*(?:\[(.+)\]|\(\s*"(.+)"\s*\)|\(\s*(.+)\s*\))\s*$/);
    if (labelled) {
      return declare(labelled[1], labelled[2] ?? labelled[3] ?? labelled[4], lineNo);
    }
    return declare(text, null, lineNo);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    let line = lines[index];
    const comment = line.indexOf('%%');
    if (comment !== -1) line = line.slice(0, comment);
    line = line.trim();
    if (!line) continue;

    if (!sawHeader) {
      const header = line.match(/^(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)\s*;?$/i);
      if (header) {
        sawHeader = true;
        continue;
      }
      errors.push(`第 ${lineNo} 行：第一行必须是 "graph TD" 或 "flowchart TD"（方向 TD/TB/LR/RL/BT）`);
      sawHeader = true;
      continue;
    }
    if (/^(?:graph|flowchart)\b/i.test(line)) continue;

    // 链式：用箭头切分，相邻两段成一条边
    const segments = line.split(/\s*(-->|==>|-\.->)\s*/);
    if (segments.length === 1) {
      parseEndpoint(segments[0], lineNo); // 孤立节点声明，允许
      continue;
    }
    let left = parseEndpoint(segments[0], lineNo);
    for (let i = 1; i < segments.length; i += 2) {
      const arrow = segments[i];
      const right = parseEndpoint(segments[i + 1], lineNo);
      if (left && right) {
        if (left === right) errors.push(`第 ${lineNo} 行：自环 ${left} ${arrow} ${right}`);
        else if (edges.some((e) => e.from === left && e.to === right)) {
          errors.push(`第 ${lineNo} 行：重复边 ${left} → ${right}`);
        } else edges.push({ from: left, to: right, kind: arrow });
      }
      left = right;
    }
  }

  if (!nodes.size && !errors.length) errors.push('计划里一个节点都没有');

  // 环检测（DFS）
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') {
      const at = stack.indexOf(id);
      errors.push(`计划里有环：${[...stack.slice(at), id].join(' → ')}`);
      return;
    }
    state.set(id, 'active');
    stack.push(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of nodes.keys()) visit(id);

  return {
    ok: errors.length === 0,
    errors,
    nodes: [...nodes.values()],
    edges: edges.map(({ from, to, kind }) => ({ from, to, kind })),
  };
}

/* ─────────────────────────── 子命令 ─────────────────────────── */

const commands = {
  help() {
    console.log(`lh.mjs — LearnHarness 学习会话状态工具

  node lh.mjs init --goal "<学习目标>" [--slug <slug>]   新建学习主题（slug 省略则从目标生成）
  node lh.mjs list                                      列出所有主题及阶段
  node lh.mjs status [--slug <slug>]                    当前状态（默认最近修改的主题）
  node lh.mjs phase <probe|plan|teach|practice>         推进阶段
  node lh.mjs strands                                   stdin: [{"strand":"…","assessment":"…"}]
  node lh.mjs plan                                      stdin: mermaid 源码，解析+校验+落盘
  node lh.mjs plan --show                               打印当前计划
  node lh.mjs visit <nodeId>                            标记某计划节点已教学（current 由最近访问推导）
  node lh.mjs commit                                    stdin: 承诺一道题（写入 pending.json）
  node lh.mjs answer                                    stdin: 学习者答案 → 归档进 log.jsonl 并回显答案键
  node lh.mjs pending                                   查看未作答的题（含答案键，用于判分）
  node lh.mjs log [--tail 5]                            作答历史

所有写操作默认作用于 $LH_SLUG，未设置时用最近修改的主题。`);
  },

  init({ flags }) {
    const goal = flags.goal;
    if (!goal || goal === true) die('init 需要 --goal "<学习目标>"');
    const slug = flags.slug && flags.slug !== true ? slugify(String(flags.slug)) : slugify(String(goal));
    mkdirSync(topicDir(slug), { recursive: true });
    if (existsSync(topicFile(slug))) die(`主题 "${slug}" 已存在，用 status 查看或换 --slug`);
    const topic = {
      slug,
      goal: String(goal),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      phase: 'probe',
      strands: [],
      plan: null,
      visited: [],
      current: null,
      practice: [],
    };
    saveTopic(topic);
    console.log(JSON.stringify({ ok: true, slug, phase: topic.phase, dir: topicDir(slug) }, null, 2));
  },

  list() {
    if (!existsSync(ROOT)) {
      console.log('（还没有任何学习主题）');
      return;
    }
    const rows = readdirSync(ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJson(topicFile(entry.name)))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (!rows.length) {
      console.log('（还没有任何学习主题）');
      return;
    }
    for (const topic of rows) {
      const nodes = topic.plan?.nodes?.length ?? 0;
      const log = readLog(topic.slug);
      const visited = log.filter((entry) => entry.nodeId).length;
      console.log(
        `${topic.slug}\t[${derivePhase(topic, log)}]\t节点 ${visited}/${nodes}\t${topic.goal.slice(0, 40)}`,
      );
    }
  },

  status({ flags }) {
    const slug = resolveSlug(flags);
    const topic = loadTopic(slug);
    const pending = readJson(pendingFile(slug));
    const log = readLog(slug);
    const tagged = log.filter((entry) => entry.nodeId);
    const derived = { visited: [], current: null };
    for (const entry of tagged) {
      if (derived.visited[derived.visited.length - 1] !== entry.nodeId) derived.visited.push(entry.nodeId);
      derived.current = entry.nodeId;
    }
    console.log(JSON.stringify({
      slug: topic.slug,
      goal: topic.goal,
      phase: derivePhase(topic, log),
      strands: topic.strands,
      plan: topic.plan ? {
        nodes: topic.plan.nodes,
        edges: topic.plan.edges,
        // 位置从"最近一道带 nodeId 的题"派生，不靠 visit 手工标记
        current: derived.current ?? topic.current,
        visited: derived.visited.length ? derived.visited : topic.visited,
        upcoming: topic.plan.nodes.map((n) => n.id).filter((id) => !derived.visited.includes(id)),
      } : null,
      pending: pending ? { kind: pending.kind, nodeId: pending.nodeId, question: pending.question, options: pending.options } : null,
      answered: log.length,
      dir: topicDir(slug),
    }, null, 2));
  },

  phase({ rest, flags }) {
    const next = rest[0];
    if (!['probe', 'plan', 'teach', 'practice'].includes(next)) die('phase 只接受 probe|plan|teach|practice');
    const slug = resolveSlug(flags);
    const topic = loadTopic(slug);
    topic.phase = next;
    topic.updatedAt = nowIso();
    saveTopic(topic);
    console.log(JSON.stringify({ ok: true, slug, phase: next }, null, 2));
  },

  strands({ flags }) {
    const input = readJsonStdin('strands');
    const list = Array.isArray(input) ? input : input.strands;
    if (!Array.isArray(list) || !list.length) die('strands 需要非空数组 [{strand, assessment}]');
    const slug = resolveSlug(flags);
    const topic = loadTopic(slug);
    topic.strands = list.map((item) => ({
      strand: String(item.strand ?? item.name ?? '').trim(),
      assessment: String(item.assessment ?? '').trim(),
    })).filter((item) => item.strand);
    topic.updatedAt = nowIso();
    saveTopic(topic);
    console.log(JSON.stringify({ ok: true, strands: topic.strands.length }, null, 2));
  },

  plan({ flags }) {
    const slug = resolveSlug(flags);
    const topic = loadTopic(slug);
    if (flags.show) {
      if (!topic.plan) die('还没有计划');
      console.log(topic.plan.mermaid);
      return;
    }
    const source = readStdin();
    if (!source.trim()) die('plan 需要从 stdin 读 mermaid 源码');
    const parsed = parseMermaidPlan(source);
    if (!parsed.ok) {
      console.error(JSON.stringify({ ok: false, errors: parsed.errors }, null, 2));
      process.exit(2);
    }
    topic.plan = { mermaid: source.trim(), nodes: parsed.nodes, edges: parsed.edges };
    topic.visited = topic.visited.filter((id) => parsed.nodes.some((node) => node.id === id));
    topic.current = null;
    topic.updatedAt = nowIso();
    saveTopic(topic);
    console.log(JSON.stringify({
      ok: true,
      nodeIds: parsed.nodes.map((node) => node.id),
      reminder: '这些是计划的节点 id —— 之后每次出题都必须带其中一个 nodeId。',
    }, null, 2));
  },

  visit({ rest, flags }) {
    const nodeId = rest[0];
    if (!nodeId) die('visit 需要 nodeId');
    const slug = resolveSlug(flags);
    const topic = loadTopic(slug);
    if (!topic.plan) die('还没有计划，先 plan');
    if (!topic.plan.nodes.some((node) => node.id === nodeId)) {
      die(`计划里没有节点 "${nodeId}"。合法值：${topic.plan.nodes.map((n) => n.id).join(', ')}`);
    }
    if (topic.visited[topic.visited.length - 1] !== nodeId) topic.visited.push(nodeId);
    topic.current = nodeId;
    topic.updatedAt = nowIso();
    saveTopic(topic);
    console.log(JSON.stringify({ ok: true, current: nodeId, visited: topic.visited }, null, 2));
  },

  commit({ flags }) {
    const input = readJsonStdin('commit');
    const slug = resolveSlug(flags, input);
    const topic = loadTopic(slug);
    const existing = readJson(pendingFile(slug));
    if (existing) die(`还有一道未作答的题（${existing.kind} / ${existing.nodeId ?? '无节点'}），先 answer 或作废再出下一道`);

    const kind = input.kind === 'explain' || input.kind === 'recall' ? 'explain' : 'quiz';
    const question = String(input.question ?? '').trim();
    if (!question) die('commit 需要 question');
    const answerKey = input.correctAnswer ?? input.answerKey;
    if (answerKey === undefined || answerKey === null || (Array.isArray(answerKey) && !answerKey.length)) {
      die('commit 需要 correctAnswer —— 必须在出题之前就承诺（这是反谄媚机制的核心）');
    }
    const options = Array.isArray(input.options) ? input.options.map((option) => ({
      label: String(option.label ?? option).trim(),
      value: String(option.value ?? option.label ?? option).trim(),
    })).filter((option) => option.label) : [];
    if (kind === 'quiz') {
      if (options.length < 2) die('quiz 至少需要 2 个选项');
      const values = options.map((option) => option.value);
      if (new Set(values).size !== values.length) die('选项 value 重复');
      const keys = Array.isArray(answerKey) ? answerKey : [answerKey];
      for (const key of keys) {
        if (!values.includes(String(key))) die(`correctAnswer "${key}" 不在选项 value 里（合法值：${values.join(' / ')}）`);
      }
      if (keys.length > 1 && input.multiSelect !== true) die('多选答案必须显式 multiSelect: true');
    }
    const nodeId = input.nodeId ?? null;
    if (topic.plan && nodeId && !topic.plan.nodes.some((node) => node.id === nodeId)) {
      die(`计划里没有节点 "${nodeId}"。合法值：${topic.plan.nodes.map((n) => n.id).join(', ')}`);
    }

    const pending = {
      kind,
      questionType: input.type === 'predict' || input.type === 'check' ? input.type : null,
      nodeId,
      question,
      detail: input.detail ? String(input.detail) : null,
      options,
      multiSelect: input.multiSelect === true,
      correctAnswer: Array.isArray(answerKey) ? answerKey.map(String) : String(answerKey),
      explanation: input.explanation ? String(input.explanation) : null,
      createdAt: nowIso(),
    };
    writeJson(pendingFile(slug), pending);
    console.log(JSON.stringify({
      ok: true,
      slug,
      committed: { kind, nodeId, options: options.length },
      next: '现在把问题交给学习者：用 ask_user_question，只给 question 和 options，不要提答案键。',
    }, null, 2));
  },

  answer({ flags }) {
    const input = readJsonStdin('answer');
    const slug = resolveSlug(flags, input);
    const pending = readJson(pendingFile(slug));
    if (!pending) die('没有未作答的题');

    const selected = Array.isArray(input.selected) ? input.selected.map(String) : input.selected ? [String(input.selected)] : [];
    const correctKeys = Array.isArray(pending.correctAnswer) ? pending.correctAnswer : [pending.correctAnswer];
    let correct = null;
    if (pending.kind === 'quiz' && !input.dontKnow) {
      const chosen = new Set(selected.map((label) => pending.options.find((o) => o.label === label)?.value ?? label));
      correct = chosen.size === correctKeys.length && correctKeys.every((key) => chosen.has(key));
    }
    const record = {
      ...pending,
      selected,
      text: input.text ? String(input.text) : null,
      other: input.other ? String(input.other) : null,
      thinking: input.thinking ? String(input.thinking) : null,
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
      dontKnow: input.dontKnow === true,
      correct,
      answeredAt: nowIso(),
    };
    mkdirSync(topicDir(slug), { recursive: true });
    appendFileSync(logFile(slug), `${JSON.stringify(record)}\n`);
    writeJson(pendingFile(slug), null); // 保留文件写 null，不删文件（数据安全约定）

    const topic = loadTopic(slug);
    topic.updatedAt = nowIso();
    saveTopic(topic);

    console.log(JSON.stringify({
      ok: true,
      kind: record.kind,
      selected: record.selected,
      correct,
      confidence: record.confidence,
      answerKey: pending.correctAnswer,
      explanation: pending.explanation,
      thinking: record.thinking,
      next: '现在按承诺的答案判分并回应：错就定位断点，不要直接给正确答案；对就下一步。',
    }, null, 2));
  },

  pending({ flags }) {
    const slug = resolveSlug(flags);
    const pending = readJson(pendingFile(slug));
    if (!pending) {
      console.log(JSON.stringify({ ok: true, pending: null }));
      return;
    }
    console.log(JSON.stringify(pending, null, 2));
  },

  log({ flags }) {
    const slug = resolveSlug(flags);
    const rows = readLog(slug);
    const tail = Number(flags.tail ?? 5);
    console.log(JSON.stringify(rows.slice(-tail), null, 2));
  },
};

/* ─────────────────────────── 入口 ─────────────────────────── */

function readLog(slug) {
  if (!existsSync(logFile(slug))) return [];
  return readFileSync(logFile(slug), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** 决定操作哪个主题：--slug > 环境变量 LH_SLUG > 输入 JSON 的 slug > 最近修改的主题 */
function resolveSlug(flags, input = null) {
  if (typeof flags.slug === 'string') return slugify(flags.slug);
  if (process.env.LH_SLUG) return process.env.LH_SLUG;
  if (input && typeof input.slug === 'string') return input.slug;
  if (!existsSync(ROOT)) die('还没有任何学习主题，先 init');
  const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const topics = dirs.map((entry) => readJson(topicFile(entry.name))).filter(Boolean);
  if (!topics.length) die('还没有任何学习主题，先 init');
  topics.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return topics[0].slug;
}

const { flags, rest } = parseArgs(process.argv.slice(2));
const command = rest.shift() ?? 'help';
const handler = commands[command];
if (!handler) die(`未知子命令 "${command}"，跑 help 看看`);
handler({ flags, rest });
