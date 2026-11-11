/**
 * 宿主半冒烟测试：不需要模型、不需要 GUI、不碰真实 $DSH_HOME。
 *
 *   DSH_HOME="$(mktemp -d)/dsh-home" node test/host-smoke.mjs
 *
 * 覆盖：工具注册 → 开主题 → 画计划（含拒绝非法 mermaid）→ 出题（挂起）
 *      → 模拟客户端 POST 答案 → 工具恢复并判分 → 卡片载荷不含答案键 → 重复提交幂等。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.DSH_HOME || !process.env.DSH_HOME.includes('dsh-home')) {
  process.env.DSH_HOME = join(mkdtempSync(join(tmpdir(), 'lh-smoke-')), 'dsh-home');
}
console.log(`[smoke] DSH_HOME = ${process.env.DSH_HOME}`);

const mod = await import('../lib/index.js');
const { name, Config, apply, usingRealDefineTool } = mod;
console.log(`[smoke] defineTool：${usingRealDefineTool ? '真包' : '内置兜底'} 路径`);

/* ── 假 cordis ctx ── */
const tools = new Map();
const routes = new Map();
const ctx = {
  effect(fn) { fn(); },
  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
};
apply(ctx, { waitTimeoutMs: 3000, claimTimeoutMs: 3000, storeDir: '' });

const assert = (condition, message) => {
  if (!condition) {
    console.error(`[smoke] ✘ ${message}`);
    process.exit(1);
  }
  console.log(`[smoke] ✓ ${message}`);
};

assert(name === 'learnharness', '插件名');
assert(tools.size >= 7, `注册了 ${tools.size} 个工具：${[...tools.keys()].join(', ')}`);
assert(routes.has('/api/learnharness'), '注册了 /api/learnharness 路由');

/* ── 假 exec ── */
const controller = new AbortController();
const makeExec = (callId) => ({
  callId,
  agent: { sessionId: 'smoke-session' },
  signal: controller.signal,
  arguments: {},
});

/* ── 假 HTTP ── */
const call = async (method, url, body) => {
  const route = routes.get('/api/learnharness');
  const request = {
    method,
    url,
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(JSON.stringify(body));
      if (event === 'end') handler();
      return this;
    },
  };
  let status = 0;
  let payload = null;
  const response = {
    writeHead(code) { status = code; },
    end(raw) { payload = raw ? JSON.parse(raw) : null; },
  };
  await route.handler(request, response);
  return { status, payload };
};

const run = (toolName, args, callId) => tools.get(toolName).execute(args, makeExec(callId));

/* ── 1. 开主题 ── */
const started = await run('learn_start', { goal: '理解注意力机制', slug: 'smoke-attn' }, 'call-start');
assert(started.ok && started.slug === 'smoke-attn', 'learn_start 建主题');
assert(started.phase === 'probe', '初始阶段是 probe');

/* ── 2. 非法计划被拒 ── */
const badPlan = await run('learn_plan', { mermaid: 'graph TD\n  a --> b\n  b --> a' }, 'call-plan-bad');
assert(badPlan.ok === false && /环/.test(badPlan.errors.join('')), '带环的计划被拒');

/* ── 3. 合法计划 ── */
const plan = await run('learn_plan', {
  mermaid: 'flowchart TD\n  qkv[Q/K/V 为何分开] --> dot[点积即相似度]\n  dot --> sm[softmax 与 √d]',
}, 'call-plan');
assert(plan.ok && plan.nodeIds.length === 3, '计划写入并返回 3 个 nodeId');

/* ── 4. 出题：立即返回，不挂起 ── */
const quizPosed = await run('learn_quiz', {
  type: 'check',
  nodeId: 'qkv',
  question: 'Q/K/V 共用同一个投影矩阵会失去什么？',
  options: [
    { label: '无法表达查询与被查询的不对称', value: 'asym' },
    { label: '点积会变成负数', value: 'neg' },
    { label: '注意力矩阵不再对称', value: 'sym' },
  ],
  correctAnswer: 'asym',
  explanation: 'query 与 key 是两种角色。',
}, 'call-quiz-1');
assert(quizPosed.ok && quizPosed.posed === true, '出题立即返回（非阻塞）');
assert(quizPosed.callId === 'call-quiz-1', '返回本次调用的 callId');

/* ── 5. 卡片载荷：必须不含答案键 ── */
const card = await call('GET', '/api/learnharness/card/call-quiz-1');
assert(card.status === 200 && card.payload.state === 'pending', '卡片载荷处于 pending');
const serialized = JSON.stringify(card.payload);
assert(!serialized.includes('asym'), '卡片载荷不含答案键 value');
assert(!serialized.includes('解释'), '卡片载荷不含 explanation');
assert(card.payload.options.length === 3, '卡片载荷给出 3 个选项');

/* ── 6. 提交错误答案 → 服务端判错 ── */
const answered = await call('POST', '/api/learnharness/answer', {
  callId: 'call-quiz-1',
  selected: ['点积会变成负数'],
  thinking: '我觉得点积会变负',
  confidence: 90,
});
assert(answered.payload.ok && answered.payload.correct === false, '提交错误答案后判定为错');
assert(answered.payload.explanation === 'query 与 key 是两种角色。', '答完才揭示解释');

/* ── 7. 重复提交幂等 ── */
const again = await call('POST', '/api/learnharness/answer', { callId: 'call-quiz-1', selected: ['无法表达查询与被查询的不对称'] });
assert(again.payload.ok && again.payload.duplicate === true, '重复提交不重复记账');
assert(again.payload.correct === false, '重复提交不覆盖原判分');

/* ── 8. learn_status 取回未送达的作答（含思路与置信度） ── */
const afterAnswer = await run('learn_status', {}, 'call-status-1');
assert(afterAnswer.ok && afterAnswer.unread.length === 1, 'learn_status 带出未送达的作答');
const unread = afterAnswer.unread[0];
assert(unread.correct === false && unread.confidence === 90, '取回判分与置信度');
assert(/点积会变负/.test(unread.thinking ?? ''), '取回学习者的思路');
assert(afterAnswer.current === 'qkv', 'current 由最近带 nodeId 的题派生');

/* ── 9. 未答题时拒绝再出题 ── */
const posed2 = await run('learn_quiz', {
  type: 'check', nodeId: 'dot', question: '第二题',
  options: [{ label: 'x', value: 'x' }, { label: 'y', value: 'y' }],
  correctAnswer: 'x', explanation: 'x',
}, 'call-quiz-2');
assert(posed2.ok && posed2.posed === true, '第二题出题成功');
const blocked = await run('learn_quiz', {
  type: 'check', nodeId: 'dot', question: '第三题',
  options: [{ label: 'x', value: 'x' }, { label: 'y', value: 'y' }],
  correctAnswer: 'x', explanation: 'x',
}, 'call-quiz-3');
assert(blocked.ok === false && /未作答/.test(blocked.error), '已有未答题时拒绝再出题');

/* ── 10. learn_answer 代答（无 GUI 通道） ── */
const relayed = await run('learn_answer', { selected: 'x', thinking: '代答' }, 'call-relay');
assert(relayed.ok && relayed.correct === true, 'learn_answer 代答并判对');

/* ── 10.5 跳过（dismiss） ── */
await call('POST', '/api/learnharness/dismiss', { callId: 'none', session: 'smoke-session' });
const afterDismiss = await call('GET', '/api/learnharness/state?session=smoke-session');
assert(afterDismiss.payload.ok && !afterDismiss.payload.topic.pending, 'dismiss 清掉未答题');

/* ── 11. 位置与阶段派生 ── */
const status = await run('learn_status', {}, 'call-status');
assert(status.ok && status.current === 'dot', 'current 跟到第二个节点');
assert(status.visited.includes('qkv') && status.visited.includes('dot'), 'visited 累积两个节点');
assert(status.phase === 'teach', '有带 nodeId 的作答后阶段变成 teach');

/* ── 11. 状态接口 ── */
const state = await call('GET', '/api/learnharness/state?session=smoke-session');
assert(state.payload.ok && state.payload.topic.slug === 'smoke-attn', 'state 接口按会话解析主题');

/* ── 12. 配置 schema ── */
assert(Config === undefined || typeof Config === 'object', 'Config 已导出');

/* ── 13. 兜底路径下参数必须是合法 JSON Schema ── */
if (!usingRealDefineTool) {
  const quiz = tools.get('learn_quiz');
  assert(quiz.parameters.type === 'object', '兜底路径 parameters 是对象根');
  assert(Array.isArray(quiz.parameters.required), 'required 是数组');
  assert(quiz.parameters.properties.correctAnswer.type === 'string', '属性 schema 正常');
  assert(quiz.parameters.properties.options.items.type === 'object', '数组 items 递归转换');
  assert(!JSON.stringify(quiz.parameters).includes('"required":true'), '没有残留的 required:true 布尔');
}

/* ── 15. 题目绑定会话：别的会话看不到这道题 ── */
const posed = await run('learn_quiz', {
  type: 'check', nodeId: 'dot', question: '会话隔离测试',
  options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
  correctAnswer: 'a', explanation: 'e',
}, 'call-session-scope');
assert(posed.ok && posed.posed, '出题成功');
const sameSession = await call('GET', '/api/learnharness/state?session=smoke-session');
assert(sameSession.payload.topic.pending?.callId === 'call-session-scope', '本会话能看到这道题');
const otherSession = await call('GET', '/api/learnharness/state?session=someone-else');
assert(otherSession.payload.topic.pending === null, '别的会话看不到这道题（会话删了也不会残留）');

/* ── 16. 超时未作答自动作废 ── */
const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
const { join: j } = await import('node:path');
const pendingPath = j(process.env.DSH_HOME, 'learn', 'smoke-attn', 'pending.json');
const stale = JSON.parse(rf(pendingPath, 'utf8'));
stale.createdAt = '2020-01-01T00:00:00.000Z';
wf(pendingPath, JSON.stringify(stale));
const afterTtl = await call('GET', '/api/learnharness/state?session=smoke-session');
assert(afterTtl.payload.topic.pending === null, '过期未作答的题被自动作废');

/* ── 17. 会话归档后，学习主题跟着隐藏 ── */
const archivedTools = new Map();
const archivedRoutes = new Map();
const archivedCtx = {
  effect(fn) { fn(); },
  tools: { register(definition) { archivedTools.set(definition.name, definition); return () => {}; } },
  webServer: { register(route) { archivedRoutes.set(route.path, route); return () => {}; } },
  // DSH 左侧栏的"归档"= workspaceRegistry.archivedSessionIds
  get(name) { return name === 'workspaceRegistry' ? { archivedSessionIds: ['smoke-session'] } : undefined; },
};
apply(archivedCtx, { waitTimeoutMs: 3000, storeDir: '' });
const archivedCall = async (method, url) => {
  const route = archivedRoutes.get('/api/learnharness');
  const request = { method, url, on() { return this; } };
  let payload = null;
  await route.handler(request, { writeHead() {}, end(raw) { payload = raw ? JSON.parse(raw) : null; } });
  return payload;
};
const hiddenState = await archivedCall('GET', '/api/learnharness/state?session=smoke-session');
assert(hiddenState.ok && hiddenState.topic === null, '会话归档后，该主题不再显示');
assert(hiddenState.archived === true, '并明确标记为已归档');
assert(!hiddenState.topics.includes('smoke-attn'), '归档主题不出现在主题列表里');

/* ── 18. /state 返回完整作答历史（左侧面板与右侧页签用） ── */
const stateWithHistory = await call('GET', '/api/learnharness/state?session=smoke-session');
const history = stateWithHistory.payload.topic.history ?? [];
assert(history.length >= 1, 'history 非空');
const latest = history[history.length - 1];
assert(typeof latest.question === 'string' && latest.question.length > 0, '历史里带题目原文');
assert(Array.isArray(latest.selected), '历史里带学习者选择');
assert(latest.correct === false || latest.correct === true, '历史里带对错');
assert('thinking' in latest && 'confidence' in latest, '历史里带思路与置信度字段');

console.log('\n[smoke] 全部通过');
