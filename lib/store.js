/**
 * 学习会话的存储层。
 *
 * 与 `~/.dsh/skills/learnharness/scripts/lh.mjs`（阶段 0 技能版）**共用同一套目录与文件格式**，
 * 所以用技能开的主题可以接着用插件教，反之亦然：
 *
 *   $DSH_HOME/learn/
 *   ├── sessions.json            {sessionId: slug}    哪个会话在学哪个主题
 *   ├── pending-index.json       {callId: slug}       按工具调用找未答题
 *   └── <slug>/
 *       ├── topic.json           目标、阶段、strands、计划 DAG、访问记录
 *       ├── pending.json         已承诺、未作答的那一道题（含答案键）
 *       └── log.jsonl            已作答记录
 *
 * 这里没有任何删除逻辑：只创建、只覆盖、只追加。清空 pending 是写 `null`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const resolveRoot = (configured = '') => {
  if (configured) return configured;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'learn');
};

const readJson = (path, fallback = null) => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const nowIso = () => new Date().toISOString();

export const slugify = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';

/* ─────────────────────────── 主题 ─────────────────────────── */

export const topicPaths = (root, slug) => {
  const dir = join(root, slug);
  return {
    dir,
    topic: join(dir, 'topic.json'),
    pending: join(dir, 'pending.json'),
    log: join(dir, 'log.jsonl'),
  };
};

export const listTopics = (root) => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJson(topicPaths(root, entry.name).topic))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
};

export const loadTopic = (root, slug) => readJson(topicPaths(root, slug).topic);
export const saveTopic = (root, topic) => writeJson(topicPaths(root, topic.slug).topic, topic);

export const createTopic = (root, goal, wantedSlug) => {
  const slug = wantedSlug ? slugify(wantedSlug) : slugify(goal);
  const existing = loadTopic(root, slug);
  if (existing) return { topic: existing, created: false };
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
    source: 'plugin',
  };
  saveTopic(root, topic);
  return { topic, created: true };
};

/* ─────────────────────── 会话 ↔ 主题绑定 ─────────────────────── */

const sessionsFile = (root) => join(root, 'sessions.json');
const pendingIndexFile = (root) => join(root, 'pending-index.json');

export const bindSession = (root, sessionId, slug) => {
  if (!sessionId) return;
  const map = readJson(sessionsFile(root), {});
  map[sessionId] = slug;
  writeJson(sessionsFile(root), map);
};

export const slugForSession = (root, sessionId) => readJson(sessionsFile(root), {})[sessionId] ?? null;

/** 某主题被哪些会话用过（含 legacy：只有 sessions.json 绑定、topic.sessionIds 为空）。 */
export const sessionsForSlug = (root, slug) => {
  const map = readJson(sessionsFile(root), {});
  const bound = Object.entries(map).filter(([, owner]) => owner === slug).map(([sessionId]) => sessionId);
  const topic = loadTopic(root, slug);
  const declared = Array.isArray(topic?.sessionIds) ? topic.sessionIds : [];
  return [...new Set([...declared, ...bound])];
};

/** 会话没绑定主题时，退回"最近修改的主题"（单主题用户的常见情形）。 */
export const resolveSlug = (root, sessionId) => {
  const bound = slugForSession(root, sessionId);
  if (bound && loadTopic(root, bound)) return bound;
  const topics = listTopics(root);
  return topics.length ? topics[0].slug : null;
};

/* ─────────────────────────── 未答题 ─────────────────────────── */

export const readPending = (root, slug) => readJson(topicPaths(root, slug).pending);

export const writePending = (root, slug, record) => {
  writeJson(topicPaths(root, slug).pending, record);
  const index = readJson(pendingIndexFile(root), {});
  for (const [callId, owner] of Object.entries(index)) {
    if (owner === slug && (!record || record.callId !== callId)) delete index[callId];
  }
  if (record?.callId) index[record.callId] = slug;
  writeJson(pendingIndexFile(root), index);
};

export const pendingByCallId = (root, callId) => {
  const slug = readJson(pendingIndexFile(root), {})[callId];
  if (!slug) return null;
  const pending = readPending(root, slug);
  if (!pending || pending.callId !== callId) return null;
  return { slug, pending };
};

/* ─────────────────────────── 作答记录 ─────────────────────────── */

export const readLog = (root, slug) => {
  const { log } = topicPaths(root, slug);
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
};

export const appendLog = (root, slug, record) => {
  const { dir, log } = topicPaths(root, slug);
  mkdirSync(dir, { recursive: true });
  appendFileSync(log, `${JSON.stringify(record)}\n`);
};

export const answeredByCallId = (root, callId) =>
  listTopics(root)
    .map((topic) => readLog(root, topic.slug).find((entry) => entry.callId === callId))
    .find(Boolean) ?? null;

/* ─────────────────────────── 派生状态 ─────────────────────────── */

/**
 * 阶段与位置都是**派生**的，不是存下来的（LearnHarness 的核心教训）。
 * 计划进度只由"最近一道带 nodeId 的题"决定，答对答错都不影响位置。
 */
const derivePhase = (topic, tagged) => {
  if (topic.mode === 'practice') return 'practice';
  if (tagged.length) return 'teach';
  if (topic.plan || topic.strands?.length) return 'plan';
  return 'probe';
};

export const deriveState = (root, topic) => {
  const log = readLog(root, topic.slug);
  const pending = readPending(root, topic.slug);
  const tagged = log.filter((entry) => entry.nodeId);
  const visited = [];
  for (const entry of tagged) {
    if (visited[visited.length - 1] !== entry.nodeId) visited.push(entry.nodeId);
  }
  const current = tagged.length ? tagged[tagged.length - 1].nodeId : topic.current ?? null;
  const nodes = topic.plan?.nodes ?? [];
  const upcoming = nodes.map((node) => node.id).filter((id) => !visited.includes(id));
  return {
    slug: topic.slug,
    goal: topic.goal,
    phase: derivePhase(topic, tagged),
    strands: topic.strands,
    plan: topic.plan ? { mermaid: topic.plan.mermaid, nodes, edges: topic.plan.edges } : null,
    current,
    visited,
    upcoming,
    progress: nodes.length ? { done: visited.length, total: nodes.length } : null,
    pending: pending
      ? {
        callId: pending.callId,
        kind: pending.kind,
        nodeId: pending.nodeId,
        question: pending.question,
        options: pending.options,
        sessionId: pending.sessionId ?? null,
        createdAt: pending.createdAt ?? null,
      }
      : null,
    answered: log.length,
    recent: log.slice(-3).map((entry) => ({
      kind: entry.kind,
      nodeId: entry.nodeId,
      correct: entry.correct,
      confidence: entry.confidence,
      selected: entry.selected,
    })),
    // 完整作答历史：左侧学习面板与右侧学习页签都用它
    history: log.slice(-12).map((entry) => ({
      callId: entry.callId,
      kind: entry.kind,
      questionType: entry.questionType ?? null,
      nodeId: entry.nodeId ?? null,
      question: entry.question ?? '',
      options: (entry.options ?? []).map((option) => option.label),
      selected: entry.selected ?? [],
      text: entry.text ?? null,
      thinking: entry.thinking ?? null,
      confidence: entry.confidence ?? null,
      dontKnow: entry.dontKnow === true,
      correct: entry.correct ?? null,
      explanation: entry.explanation ?? null,
      answeredAt: entry.answeredAt ?? null,
    })),
    log,
  };
};

/* ─────────────────────── mermaid 计划子集解析 ─────────────────────── */

const NODE_ID = /^[a-z0-9]+([_-][a-z0-9]+)*$/;

/** 与 LearnHarness 原版同规则：小写 slug、无环/自环/重复边、带行号报错。 */
export const parseMermaidPlan = (source) => {
  const errors = [];
  const nodes = new Map();
  const edges = [];
  const lines = String(source).split(/\r?\n/);
  let sawHeader = false;

  const declare = (rawId, title, lineNo) => {
    const id = String(rawId).trim();
    if (!NODE_ID.test(id)) {
      errors.push(`第 ${lineNo} 行：节点 id "${id}" 不合法，只能用小写字母/数字，用 - 或 _ 连接`);
      return null;
    }
    const prev = nodes.get(id);
    const label = title?.trim();
    if (prev) {
      if (label && (!prev.title || prev.title === prev.id)) prev.title = label;
      return id;
    }
    nodes.set(id, { id, title: label || id });
    return id;
  };

  const parseEndpoint = (token, lineNo) => {
    const text = String(token).trim();
    const labelled = text.match(/^([A-Za-z0-9_-]+)\s*(?:\[(.+)\]|\(\s*"(.+)"\s*\)|\(\s*(.+)\s*\))\s*$/);
    if (labelled) return declare(labelled[1], labelled[2] ?? labelled[3] ?? labelled[4], lineNo);
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
      if (/^(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)\s*;?$/i.test(line)) {
        sawHeader = true;
        continue;
      }
      errors.push(`第 ${lineNo} 行：第一行必须是 "flowchart TD" 或 "graph TD"（方向 TD/TB/LR/RL/BT）`);
      sawHeader = true;
      continue;
    }
    if (/^(?:graph|flowchart)\b/i.test(line)) continue;

    const segments = line.split(/\s*(-->|==>|-\.->)\s*/);
    if (segments.length === 1) {
      parseEndpoint(segments[0], lineNo);
      continue;
    }
    let left = parseEndpoint(segments[0], lineNo);
    for (let i = 1; i < segments.length; i += 2) {
      const arrow = segments[i];
      const right = parseEndpoint(segments[i + 1], lineNo);
      if (left && right) {
        if (left === right) errors.push(`第 ${lineNo} 行：自环 ${left} ${arrow} ${right}`);
        else if (edges.some((edge) => edge.from === left && edge.to === right)) {
          errors.push(`第 ${lineNo} 行：重复边 ${left} → ${right}`);
        } else edges.push({ from: left, to: right, kind: arrow });
      }
      left = right;
    }
  }

  if (!nodes.size && !errors.length) errors.push('计划里一个节点都没有');

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

  return { ok: errors.length === 0, errors, nodes: [...nodes.values()], edges };
};
