window.__ModuleLoader__.load({
  id: 'dsh-learnharness',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const name = 'learnharness-client';
    const inject = ['slots', 'layout', 'sidebarRight', 'sidebarRightTabs'];
    /** 左侧栏入口 id 与它打开的主面板 key 必须是同一个 */
    const PANEL_ID = 'learnharness';

    /** 这些工具的调用在对话流里渲染成学习卡片 */
    const QUESTION_TOOLS = ['learn_quiz', 'learn_explain', 'learn_probe_question', 'learn_answer'];
    const PLAN_TOOLS = ['learn_plan'];
    const STATUS_TOOLS = ['learn_status', 'learn_start', 'learn_probe_done'];

    const COLORS = {
      line: 'rgba(127,127,127,.28)',
      soft: 'rgba(127,127,127,.10)',
      muted: 'rgba(127,127,127,.85)',
      ok: '#2f9e44',
      bad: '#e03131',
      accent: '#1971c2',
    };

    const box = (children, extra = {}) => h('div', {
      style: {
        border: `1px solid ${COLORS.line}`,
        borderRadius: 10,
        padding: '12px 14px',
        margin: '6px 0',
        fontSize: 14,
        lineHeight: 1.6,
        background: 'transparent',
        ...extra,
      },
    }, children);

    const label = (text) => h('div', {
      style: { fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: COLORS.muted, marginBottom: 6 },
    }, text);

    /** callId → 稳定洗牌种子：刷新页面顺序不变，但学习者看不到"正确项永远在第一个" */
    const seededOrder = (callId, length) => {
      let seed = 2166136261;
      for (let i = 0; i < callId.length; i += 1) {
        seed ^= callId.charCodeAt(i);
        seed = Math.imul(seed, 16777619);
      }
      const order = Array.from({ length }, (_, index) => index);
      for (let i = order.length - 1; i > 0; i -= 1) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        const j = Math.abs(seed) % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      return order;
    };

    const post = (path, body) => fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((response) => response.json()).catch((err) => ({ ok: false, error: String(err?.message || err) }));

    const getJson = (path) => fetch(path, { headers: { accept: 'application/json' } })
      .then((response) => response.json())
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));

    /* ───────────────────────── 选择题 / 自由回忆 ───────────────────────── */

    function QuestionCard(props) {
      const { callId, toolName, phase, onAnswered, onDismiss } = props;
      // 工具调用行默认折叠，题目藏在里面没人看得见 —— 用 shell 给的 disclosure 钩子自动展开。
      const disclosure = typeof props.useDisclosure === 'function' ? props.useDisclosure() : null;
      const autoExpanded = React.useRef(false);
      React.useEffect(() => {
        if (autoExpanded.current || !disclosure) return;
        autoExpanded.current = true;
        if (!disclosure.expanded) disclosure.setExpanded(true);
      }, [disclosure]);
      const [payload, setPayload] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [selected, setSelected] = React.useState([]);
      const [freeText, setFreeText] = React.useState('');
      const [thinking, setThinking] = React.useState('');
      const [confidence, setConfidence] = React.useState(50);

      React.useEffect(() => {
        let alive = true;
        getJson(`/api/learnharness/card/${encodeURIComponent(callId)}`).then((value) => {
          if (alive) setPayload(value);
        });
        return () => { alive = false; };
      }, [callId, phase]);

      const submit = async (dontKnow) => {
        setBusy(true);
        setError(null);
        const response = await post('/api/learnharness/answer', {
          callId,
          selected: dontKnow ? [] : selected,
          text: freeText || null,
          thinking: thinking || null,
          confidence: dontKnow ? null : confidence,
          dontKnow: dontKnow === true,
        });
        setBusy(false);
        if (!response?.ok) {
          setError(response?.error ?? '提交失败');
          return;
        }
        setPayload(response);
        try {
          onAnswered?.(response);
        } catch (err) {
          console.error('[learnharness] onAnswered 失败：', err?.message || err);
        }
      };

      // 注意：所有 hook 必须在任何 return 之前调用，否则第二次渲染会抛
      // "Rendered more hooks than during the previous render"（0.2.0 的 bug）。
      const options = payload?.options ?? [];
      const order = seededOrder(callId, options.length);

      if (!payload) return box([label('学习检查'), h('div', { style: { color: COLORS.muted } }, '载入中…')]);

      if (payload.state === 'missing') {
        return box([
          label('学习检查'),
          h('div', { style: { color: COLORS.muted } }, '这道题的记录已经不在了（可能已超时或被清理）。'),
        ]);
      }

      const answered = payload.state === 'answered';
      const isFree = payload.kind === 'explain' || options.length === 0;

      const header = [
        label([
          payload.kind === 'quiz' ? (payload.questionType === 'predict' ? '预测' : '检查') : payload.kind === 'probe' ? '探针' : '回忆',
          payload.nodeId ? ` · ${payload.nodeId}` : '',
          payload.goal ? ` · ${payload.goal}` : '',
        ].join('')),
      ];

      const question = h('div', { style: { fontWeight: 600, marginBottom: 10, whiteSpace: 'pre-wrap' } }, payload.question);

      if (answered) {
        const verdict = payload.correct === true
          ? h('span', { style: { color: COLORS.ok, fontWeight: 600 } }, '对')
          : payload.correct === false
            ? h('span', { style: { color: COLORS.bad, fontWeight: 600 } }, '错')
            : h('span', { style: { color: COLORS.muted } }, payload.dontKnow ? '不知道' : '已记录');
        return box([
          ...header,
          question,
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 } },
            verdict,
            h('span', { style: { color: COLORS.muted, fontSize: 12 } },
              [
                (payload.selected ?? []).length ? `选了：${payload.selected.join(' / ')}` : null,
                payload.text ? `作答：${payload.text}` : null,
                payload.confidence !== null && payload.confidence !== undefined ? `置信度 ${payload.confidence}` : null,
              ].filter(Boolean).join(' · ')),
          ),
          payload.thinking ? h('div', { style: { fontSize: 13, color: COLORS.muted, borderLeft: `2px solid ${COLORS.line}`, paddingLeft: 10, marginBottom: 8 } }, `思路：${payload.thinking}`) : null,
          payload.explanation ? h('div', { style: { fontSize: 13, background: COLORS.soft, borderRadius: 8, padding: '8px 10px' } }, payload.explanation) : null,
        ]);
      }

      const optionRow = (option, index) => {
        const checked = selected.includes(option.label);
        return h('label', {
          key: `${index}-${option.label}`,
          style: {
            display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 8,
            cursor: busy ? 'default' : 'pointer', background: checked ? COLORS.soft : 'transparent',
          },
        }, [
          h('input', {
            key: 'input',
            type: payload.multiSelect ? 'checkbox' : 'radio',
            name: `lh-${callId}`,
            checked,
            disabled: busy,
            onChange: () => setSelected((current) => {
              if (payload.multiSelect) {
                return current.includes(option.label)
                  ? current.filter((entry) => entry !== option.label)
                  : [...current, option.label];
              }
              return [option.label];
            }),
            style: { marginTop: 4 },
          }),
          h('span', { key: 'text', style: { whiteSpace: 'pre-wrap' } }, option.label),
        ]);
      };

      return box([
        ...header,
        question,
        payload.detail ? h('div', { style: { fontSize: 13, color: COLORS.muted, marginBottom: 8, whiteSpace: 'pre-wrap' } }, payload.detail) : null,

        isFree
          ? h('textarea', {
              value: freeText,
              disabled: busy,
              placeholder: '写下你的回答（用自己的话，含推理）',
              onChange: (event) => setFreeText(event.target.value),
              rows: 4,
              style: {
                width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
                border: `1px solid ${COLORS.line}`, background: 'transparent', color: 'inherit',
                font: 'inherit', resize: 'vertical', marginBottom: 10,
              },
            })
          : h('div', { style: { marginBottom: 10 } }, order.map((index) => optionRow(options[index], index))),

        h('div', { style: { fontSize: 12, color: COLORS.muted, marginBottom: 4 } }, '你的思路（比答案更有价值，会用来定位断点）'),
        h('textarea', {
          value: thinking,
          disabled: busy,
          placeholder: '你是怎么想的？哪里不确定？',
          onChange: (event) => setThinking(event.target.value),
          rows: 2,
          style: {
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
            border: `1px solid ${COLORS.line}`, background: 'transparent', color: 'inherit',
            font: 'inherit', resize: 'vertical', marginBottom: 10,
          },
        }),

        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 } }, [
          h('span', { key: 'l', style: { fontSize: 12, color: COLORS.muted, minWidth: 72 } }, `置信度 ${confidence}`),
          h('input', {
            key: 'r',
            type: 'range', min: 0, max: 100, step: 10, value: confidence, disabled: busy,
            onChange: (event) => setConfidence(Number(event.target.value)),
            style: { flex: 1 },
          }),
        ]),

        error ? h('div', { style: { color: COLORS.bad, fontSize: 13, marginBottom: 8 } }, error) : null,

        h('div', { style: { display: 'flex', gap: 8 } }, [
          h('button', {
            key: 'submit',
            type: 'button',
            disabled: busy || (isFree ? !freeText.trim() : selected.length === 0),
            onClick: () => submit(false),
            style: {
              padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: COLORS.accent, color: '#fff', fontWeight: 600,
              opacity: busy || (isFree ? !freeText.trim() : selected.length === 0) ? 0.5 : 1,
            },
          }, busy ? '提交中…' : '提交'),
          onDismiss
            ? h('button', {
                key: 'dismiss',
                type: 'button',
                disabled: busy,
                onClick: () => onDismiss(),
                style: {
                  padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
                  border: 'none', background: 'transparent', color: COLORS.muted,
                },
              }, '跳过这题')
            : null,
          payload.kind === 'quiz'
            ? h('button', {
                key: 'dontknow',
                type: 'button',
                disabled: busy,
                onClick: () => submit(true),
                style: {
                  padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${COLORS.line}`, background: 'transparent', color: 'inherit',
                },
              }, '我不知道')
            : null,
        ]),
      ]);
    }

    /* ───────────────────────── 计划 / 状态 ───────────────────────── */

    function PlanCard(props) {
      const { toolName, callId, phase } = props;
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        getJson('/api/learnharness/state').then((value) => {
          if (alive) setState(value);
        });
        return () => { alive = false; };
      }, [toolName, callId, phase]);

      const topic = state?.topic;
      if (!topic) return box([label('学习计划'), h('div', { style: { color: COLORS.muted } }, '还没有学习主题（先 learn_start）。')]);

      const visited = new Set(topic.visited ?? []);
      const nodes = topic.plan?.nodes ?? [];

      return box([
        label(`学习计划 · ${topic.phase}${topic.progress ? ` · ${topic.progress.done}/${topic.progress.total}` : ''}`),
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, topic.goal),
        nodes.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, nodes.map((node, index) => {
              const done = visited.has(node.id);
              const current = topic.current === node.id;
              return h('div', {
                key: node.id,
                style: {
                  display: 'flex', gap: 8, alignItems: 'baseline',
                  padding: '4px 8px', borderRadius: 6,
                  background: current ? COLORS.soft : 'transparent',
                  opacity: done && !current ? 0.6 : 1,
                },
              }, [
                h('span', {
                  key: 'mark',
                  style: { width: 14, color: current ? COLORS.accent : done ? COLORS.ok : COLORS.muted, fontSize: 12 },
                }, current ? '▶' : done ? '✓' : `${index + 1}`),
                h('span', { key: 'title', style: { fontWeight: current ? 600 : 400 } }, node.title),
                h('span', { key: 'id', style: { fontSize: 11, color: COLORS.muted } }, node.id),
              ]);
            }))
          : h('div', { style: { color: COLORS.muted } }, '计划还没写（用 learn_plan 画依赖 DAG）。'),
        topic.recent?.length
          ? h('div', { style: { marginTop: 10, fontSize: 12, color: COLORS.muted } },
              `最近：${topic.recent.map((entry) => `${entry.nodeId ?? entry.kind}${entry.correct === true ? '✓' : entry.correct === false ? '✗' : '·'}`).join('  ')}`)
          : null,
      ]);
    }

    function StatusCard(props) {
      const { toolName, callId, phase } = props;
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        getJson('/api/learnharness/state').then((value) => {
          if (alive) setState(value);
        });
        return () => { alive = false; };
      }, [toolName, callId, phase]);

      const topic = state?.topic;
      if (!topic) return box([label('学习状态'), h('div', { style: { color: COLORS.muted } }, '还没有学习主题。')]);

      return box([
        label(`学习状态 · ${topic.phase}`),
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, topic.goal),
        h('div', { style: { fontSize: 13, color: COLORS.muted } },
          [
            topic.progress ? `进度 ${topic.progress.done}/${topic.progress.total}` : null,
            topic.current ? `当前 ${topic.current}` : null,
            topic.answered ? `已作答 ${topic.answered}` : null,
            topic.pending ? `未作答：${topic.pending.question}` : null,
          ].filter(Boolean).join(' · ')),
      ]);
    }





    /* ───────────── 右侧边缘浮层（作答卡，不依赖页签注册） ───────────── */

    function QuestionOverlay(props) {
      const [pending, setPending] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          const value = await getJson('/api/learnharness/state');
          if (!alive) return;
          const next = value?.topic?.pending ?? null;
          setPending((current) => {
            if (!current && !next) return current;
            if (current && next && current.callId === next.callId) return current;
            if (next) setCollapsed(false);
            return next;
          });
        };
        tick();
        const timer = setInterval(tick, 2000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      if (!pending) return null;

      const frame = {
        position: 'fixed',
        right: 16,
        top: 72,
        bottom: 96,
        width: 400,
        maxWidth: '42vw',
        zIndex: 9000,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 14,
        border: `1px solid ${COLORS.accent}`,
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'inherit',
        boxShadow: '0 18px 48px rgba(0,0,0,.32)',
        overflow: 'hidden',
      };

      const bar = {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', borderBottom: `1px solid ${COLORS.line}`, fontSize: 12,
      };

      if (collapsed) {
        return h('div', { style: { ...frame, top: 'auto', bottom: 96, width: 180, height: 'auto' } },
          h('button', {
            type: 'button',
            onClick: () => setCollapsed(false),
            style: {
              padding: '10px 12px', border: 'none', background: 'transparent', color: COLORS.accent,
              cursor: 'pointer', fontSize: 13, fontWeight: 600,
            },
          }, '学习 · 待作答 ▴'));
      }

      return h('div', { style: frame }, [
        h('div', { key: 'bar', style: bar }, [
          h('span', { key: 't', style: { fontWeight: 600 } }, '学习 · 待作答'),
          h('span', { key: 's', style: { flex: 1 } }),
          h('button', {
            key: 'c',
            type: 'button',
            onClick: () => setCollapsed(true),
            style: { border: 'none', background: 'transparent', color: COLORS.muted, cursor: 'pointer', fontSize: 12 },
          }, '收起'),
        ]),
        h('div', { key: 'body', style: { flex: 1, overflowY: 'auto', padding: '12px 14px' } },
          h(QuestionCard, {
            callId: pending.callId,
            toolName: pending.kind === 'quiz' ? 'learn_quiz' : pending.kind === 'explain' ? 'learn_explain' : 'learn_probe_question',
            phase: 'start',
            useDisclosure: undefined,
            onAnswered: () => {
              setPending(null);
              try { props.send?.('答完了，继续'); } catch (err) {
                console.error('[learnharness] 触发新回合失败：', err?.message || err);
              }
            },
            onDismiss: () => {
              setPending(null);
              post('/api/learnharness/dismiss', { callId: pending.callId });
            },
          })),
      ]);
    }


    /** 作答时间：今天只显示时分，其余显示月-日 时:分。 */
    const formatWhen = (iso) => {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
    };

    /** 一条作答记录：默认只占一行（问题 | 时间 | 判定），点开看细节。 */
    function HistoryRow({ entry, index }) {
      const [open, setOpen] = React.useState(false);

      const verdict = entry.dontKnow
        ? { text: '不知道', color: COLORS.muted }
        : entry.correct === true
          ? { text: '对', color: COLORS.ok }
          : entry.correct === false
            ? { text: '错', color: COLORS.bad }
            : { text: '—', color: COLORS.muted };

      const summary = h('button', {
        type: 'button',
        onClick: () => setOpen((value) => !value),
        title: entry.question,
        style: {
          display: 'flex', alignItems: 'baseline', gap: 6, width: '100%',
          padding: '3px 6px', border: 'none', borderRadius: 6, cursor: 'pointer',
          background: open ? COLORS.soft : 'transparent', color: 'inherit',
          font: 'inherit', fontSize: 12, lineHeight: 1.5, textAlign: 'left',
        },
      }, [
        h('span', { key: 'i', style: { flex: 'none', width: 20, fontSize: 11, color: COLORS.muted, fontVariantNumeric: 'tabular-nums' } }, `${index}.`),
        h('span', { key: 'q', style: {
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        } }, entry.question || '（无题目）'),
        h('span', { key: 't', style: { flex: 'none', fontSize: 11, color: COLORS.muted, fontVariantNumeric: 'tabular-nums' } }, formatWhen(entry.answeredAt)),
        h('span', { key: 'v', style: { flex: 'none', width: 28, textAlign: 'right', fontSize: 11, fontWeight: 600, color: verdict.color } }, verdict.text),
      ]);

      if (!open) return summary;

      const answer = (entry.selected ?? []).length ? entry.selected.join(' / ') : (entry.text ?? '（未作答）');
      return h('div', {
        style: { border: `1px solid ${COLORS.line}`, borderRadius: 10, marginBottom: 4 },
      }, [
        summary,
        h('div', { key: 'detail', style: { padding: '2px 8px 8px', fontSize: 12 } }, [
          h('div', { key: 'q', style: { whiteSpace: 'pre-wrap', marginBottom: 6 } }, entry.question),
          h('div', { key: 'a', style: { fontSize: 12, marginBottom: 4 } }, [
            h('span', { key: 'l', style: { color: COLORS.muted } }, '你的作答：'),
            h('span', { key: 'v' }, answer),
            entry.confidence !== null && entry.confidence !== undefined
              ? h('span', { key: 'c', style: { color: COLORS.muted } }, `　置信度 ${entry.confidence}`)
              : null,
          ].filter(Boolean)),
          entry.nodeId
            ? h('div', { key: 'n', style: { fontSize: 11, color: COLORS.muted, marginBottom: 4 } }, `节点 ${entry.nodeId}`)
            : null,
          entry.thinking
            ? h('div', {
                key: 't',
                style: { fontSize: 12, color: COLORS.muted, borderLeft: `2px solid ${COLORS.line}`, paddingLeft: 8, margin: '6px 0' },
              }, `思路：${entry.thinking}`)
            : null,
          entry.explanation
            ? h('div', {
                key: 'e',
                style: { fontSize: 12, background: COLORS.soft, borderRadius: 8, padding: '6px 8px', marginTop: 6 },
              }, entry.explanation)
            : null,
        ].filter(Boolean)),
      ]);
    }

    /** 已答题记录（左侧学习面板与右侧学习页签共用）：默认全收起，一行一条。 */
    function HistoryList({ items }) {
      const all = items ?? [];
      const rows = [...all].reverse();
      if (!rows.length) {
        return h('div', { style: { fontSize: 12, color: COLORS.muted } }, '还没有作答记录。');
      }
      const total = all.length;
      const firstNumber = 1; // 全量展示，编号从第 1 题开始
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
        rows.map((entry, index) => h(HistoryRow, {
          key: `${index}-${entry.callId ?? entry.answeredAt ?? index}`,
          entry,
          index: firstNumber + (rows.length - 1 - index),
        })));
    }

    /* ───────────── 右侧栏「学习」页签（作答卡在这里） ───────────── */

    const PANE_ID = 'learnharness-question';
    const PANE_KIND = 'learnharness-question';

    function QuestionPaneTitle() {
      return '学习';
    }

    /** 右侧栏页签主体：有未答题就渲染作答卡，没有就给一句空态。 */
    function QuestionPane(props) {
      const sessionId = props?.sessionId ?? props?.mountedSession?.() ?? null;
      const [pending, setPending] = React.useState(null);
      const [state, setState] = React.useState(null);
      const [sendFailed, setSendFailed] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
        const tick = async () => {
          const value = await getJson(`/api/learnharness/state${query}`);
          if (!alive) return;
          setState(value);
          const next = value?.topic?.pending ?? null;
          setPending((current) => {
            if (!current && !next) return current;
            if (current && next && current.callId === next.callId) return current;
            return next;
          });
        };
        tick();
        const timer = setInterval(tick, 2000);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId]);

      if (!pending) {
        const unbound = state && state.bound === false;
        return h('div', { style: { padding: '14px 14px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } }, [
          h('div', { key: 'h', style: { fontSize: 12, color: COLORS.muted, marginBottom: 8 } },
            unbound
              ? '本对话还没有学习主题。在对话里说「教我 X」或「我想真正理解 X」就会建一个。'
              : (state?.topic ? '当前没有待作答的题。' : '还没有学习主题。')),
          h('div', { key: 'l', style: { fontSize: 11, letterSpacing: '.04em', color: COLORS.muted, marginBottom: 8 } }, '作答记录'),
          h(HistoryList, { key: 'hist', items: state?.topic?.history }),
        ]);
      }

      return h('div', { style: { padding: '12px 14px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } }, [
        sendFailed
          ? h('div', {
              key: 'sendfail',
              style: { fontSize: 12, color: COLORS.bad, marginBottom: 8 },
            }, '已记录，但自动继续失败——请在对话里发一句「继续」。')
          : null,
        h(QuestionCard, { key: 'card',
          callId: pending.callId,
          toolName: pending.kind === 'quiz' ? 'learn_quiz' : pending.kind === 'explain' ? 'learn_explain' : 'learn_probe_question',
          phase: 'start',
          useDisclosure: undefined,
          onAnswered: async () => {
            setPending(null);
            const ok = await props.send?.('答完了，继续', sessionId);
            setSendFailed(ok === false);
          },
          onDismiss: () => {
            setPending(null);
            post('/api/learnharness/dismiss', { callId: pending.callId, session: sessionId });
          },
        }),
        h('div', { key: 'hist-head', style: { fontSize: 11, letterSpacing: '.04em', color: COLORS.muted, margin: '14px 0 8px' } }, '作答记录'),
        h(HistoryList, { key: 'hist', items: state?.topic?.history }),
      ]);
    }

    /** 常驻监视器：一出现未答题就把右侧栏「学习」页签打开（不渲染任何东西）。 */
    function PendingWatcher(props) {
      React.useEffect(() => {
        let alive = true;
        let openedFor = null;
        const tick = async () => {
          const sessionId = props.mountedSession?.() ?? null;
          if (!sessionId) return; // 没有在屏会话就不开页签
          const value = await getJson(`/api/learnharness/state?session=${encodeURIComponent(sessionId)}`);
          if (!alive) return;
          const pending = value?.topic?.pending ?? null;
          if (!pending) { openedFor = null; return; }
          if (openedFor === pending.callId) return;
          try {
            if (typeof props.isExpanded === 'function' && !props.isExpanded()) props.toggleExpanded?.();
            props.openTab?.(PANE_KIND);
            openedFor = pending.callId; // 只有成功才记住，失败下一轮重试
            fetch('/api/learnharness/selfcheck', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ openTab: 'ok' }),
            }).catch(() => {});
          } catch (err) {
            console.error('[learnharness] 打开学习页签失败：', err?.message || err);
            fetch('/api/learnharness/selfcheck', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ openTab: `error: ${err?.message || err}` }),
            }).catch(() => {});
          }
        };
        tick();
        const timer = setInterval(tick, 2000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      return null;
    }

    /* ───────────── 输入框上方的作答 dock（原生问题卡的位置） ───────────── */

    /**
     * 工具调用行在"正在调用工具"分组里默认折叠，题目藏在里面没人看得见。
     * 所以作答界面挂在 conversation.composer.dock（session 作用域、list 槽）：
     * 有未答题就渲染，答完自动消失。卡片本身仍由 tool.call.toolview 提供（作历史记录）。
     */
    function QuestionDock(props) {
      const sessionId = props?.sessionId ?? props?.session?.id ?? null;
      const [pending, setPending] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
        const tick = async () => {
          const value = await getJson(`/api/learnharness/state${query}`);
          if (!alive) return;
          setState(value);
          const next = value?.topic?.pending ?? null;
          setPending((current) => {
            if (!current && !next) return current;
            if (current && next && current.callId === next.callId) return current;
            return next;
          });
        };
        tick();
        const timer = setInterval(tick, 2000);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId]);

      if (!pending) return null;

      return h('div', {
        style: {
          margin: '0 0 8px', padding: '10px 12px', borderRadius: 12,
          border: `1px solid ${COLORS.accent}`,
          background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit',
          boxShadow: '0 6px 20px rgba(0,0,0,.16)',
        },
      }, h(QuestionCard, {
        callId: pending.callId,
        toolName: pending.kind === 'quiz' ? 'learn_quiz' : pending.kind === 'explain' ? 'learn_explain' : 'learn_probe_question',
        phase: 'start',
        useDisclosure: undefined,
        onAnswered: () => {
          setPending(null);
          // 作答已落盘 → 发一条消息触发新回合，模型用 learn_status 取回
          try {
            props.send?.('答完了，继续');
          } catch (err) {
            console.error('[learnharness] 触发新回合失败：', err?.message || err);
          }
        },
        onDismiss: () => {
          setPending(null);
          post('/api/learnharness/dismiss', { callId: pending.callId, session: sessionId });
        },
      }));
    }

    /* ───────────────────────── 学习面板（左侧栏入口 → 主区） ───────────────────────── */

    const PHASE_LABEL = { probe: '探针', plan: '规划', teach: '教学', practice: '练习' };

    function LearnIcon({ size = 18, active }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2 : 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block' },
      }, [
        h('path', { key: 'book', d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z' }),
        h('path', { key: 'spine', d: 'M19 18v3H6.5A2.5 2.5 0 0 1 4 18.5' }),
        h('path', { key: 'l1', d: 'M8 7.5h7' }),
        h('path', { key: 'l2', d: 'M8 11h5' }),
      ]);
    }

    function LearnPanel({ openConversation }) {
      const [state, setState] = React.useState(null);
      const [slug, setSlug] = React.useState(null);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        const query = slug ? `?slug=${encodeURIComponent(slug)}` : '';
        const tick = async () => {
          const value = await getJson(`/api/learnharness/state${query}`);
          if (!alive) return;
          if (value && value.ok === false) setError(value.error ?? '读取失败');
          else setError(null);
          setState(value);
        };
        tick();
        const timer = setInterval(tick, 3000);
        return () => { alive = false; clearInterval(timer); };
      }, [slug]);

      const topic = state?.topic ?? null;
      const topics = state?.topics ?? [];
      const phase = topic ? (PHASE_LABEL[topic.phase] ?? topic.phase) : null;
      const progress = topic?.progress ?? null;
      const nodes = topic?.plan?.nodes ?? [];
      const visited = new Set(topic?.visited ?? []);

      const chip = (name) => h('button', {
        key: name,
        type: 'button',
        onClick: () => setSlug(name === (topic?.slug ?? '') ? null : name),
        style: {
          padding: '3px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 12,
          border: `1px solid ${COLORS.line}`, background: 'transparent', color: 'inherit',
          opacity: topic && topic.slug === name ? 1 : 0.65,
          fontWeight: topic && topic.slug === name ? 600 : 400,
        },
      }, name);

      return h('div', {
        style: {
          height: '100%', overflowY: 'auto', boxSizing: 'border-box',
          padding: '18px 24px 32px', fontSize: 14, lineHeight: 1.65,
        },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
        }, [
          h('div', { key: 't', style: { fontSize: 17, fontWeight: 600 } }, '学习'),
          h('div', { key: 'spacer', style: { flex: 1 } }),
          openConversation
            ? h('button', {
                key: 'back',
                type: 'button',
                onClick: () => openConversation(),
                style: {
                  padding: '4px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
                  border: `1px solid ${COLORS.line}`, background: 'transparent', color: 'inherit',
                },
              }, '回到对话')
            : null,
        ]),

        error ? h('div', { key: 'err', style: { color: COLORS.bad, fontSize: 13, marginBottom: 10 } }, error) : null,

        topics.length > 1
          ? h('div', { key: 'chips', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 } }, topics.map(chip))
          : null,

        !topic
          ? h('div', { key: 'empty', style: { color: COLORS.muted } }, [
              h('div', { key: 'a', style: { marginBottom: 8 } }, '还没有学习主题。'),
              h('div', { key: 'b' }, '在对话里说「教我 X」或「我想真正理解 X」，模型会先测量你的理解边界、画出依赖图，然后一轮一个推理步地教。'),
            ])
          : h('div', { key: 'body' }, [
              h('div', { key: 'goal', style: { fontSize: 16, fontWeight: 600, marginBottom: 6 } }, topic.goal),
              h('div', {
                key: 'meta',
                style: { display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: COLORS.muted, marginBottom: 12 },
              }, [
                h('span', { key: 'phase', style: {
                  padding: '1px 8px', borderRadius: 999, border: `1px solid ${COLORS.line}`, color: COLORS.accent,
                } }, phase),
                progress ? h('span', { key: 'p' }, `进度 ${progress.done}/${progress.total}`) : null,
                topic.current ? h('span', { key: 'c' }, `当前节点 ${topic.current}`) : null,
                topic.answered ? h('span', { key: 'a' }, `已作答 ${topic.answered}`) : null,
                h('span', { key: 's', opacity: 0.7 }, topic.slug),
              ].filter(Boolean)),

              progress && progress.total
                ? h('div', { key: 'bar', style: { height: 4, borderRadius: 2, background: COLORS.soft, marginBottom: 16, overflow: 'hidden' } },
                    h('div', {
                      style: {
                        width: `${Math.round((progress.done / progress.total) * 100)}%`,
                        height: '100%', background: COLORS.accent, transition: 'width .3s',
                      },
                    }))
                : null,

              topic.pending
                ? h('div', {
                    key: 'pending',
                    style: {
                      border: `1px solid ${COLORS.accent}`, borderRadius: 10,
                      padding: '10px 12px', marginBottom: 16, fontSize: 13,
                    },
                  }, [
                    h('div', { key: 'l', style: { fontSize: 11, letterSpacing: '.04em', color: COLORS.accent, marginBottom: 4 } }, '等你作答'),
                    h('div', { key: 'q', style: { whiteSpace: 'pre-wrap' } }, topic.pending.question),
                    h('div', { key: 'h', style: { color: COLORS.muted, marginTop: 6, fontSize: 12 } },
                      '回到对话里那张卡片上作答（这里只是镜像，不能提交）。'),
                  ])
                : null,

              nodes.length
                ? h('div', { key: 'plan', style: { marginBottom: 16 } }, [
                    h('div', { key: 'l', style: { fontSize: 11, letterSpacing: '.04em', color: COLORS.muted, marginBottom: 8 } }, '依赖图'),
                    ...nodes.map((node, index) => {
                      const done = visited.has(node.id);
                      const current = topic.current === node.id;
                      return h('div', {
                        key: node.id,
                        style: {
                          display: 'flex', gap: 10, alignItems: 'baseline',
                          padding: '5px 10px', borderRadius: 8, marginBottom: 2,
                          background: current ? COLORS.soft : 'transparent',
                          opacity: done && !current ? 0.55 : 1,
                        },
                      }, [
                        h('span', {
                          key: 'm',
                          style: {
                            width: 16, flex: 'none', textAlign: 'center', fontSize: 11,
                            color: current ? COLORS.accent : done ? COLORS.ok : COLORS.muted,
                          },
                        }, current ? '▶' : done ? '✓' : `${index + 1}`),
                        h('span', { key: 't', style: { fontWeight: current ? 600 : 400 } }, node.title),
                        h('span', { key: 'i', style: { fontSize: 11, color: COLORS.muted } }, node.id),
                      ]);
                    }),
                  ])
                : h('div', { key: 'noplan', style: { color: COLORS.muted, marginBottom: 16 } }, '计划还没画出来（探针结束后由模型生成依赖图）。'),

              h('div', { key: 'hist', style: { marginTop: 8 } }, [
                h('div', { key: 'l', style: { fontSize: 11, letterSpacing: '.04em', color: COLORS.muted, marginBottom: 8 } }, '作答记录'),
                h(HistoryList, { key: 'list', items: topic.history }),
              ]),
            ]),
      ]);
    }

    /* ───────────────────────── 注册 ───────────────────────── */

    function apply(ctx) {
      const errors = [];
      const ok = [];
      const report = () => {
        try {
          fetch('/api/learnharness/selfcheck', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ok, errors, panel: PANEL_ID, href: location.href,
              slotsService: !!ctx.slots, layoutService: !!ctx.layout,
              at: new Date().toISOString(),
            }),
          }).catch(() => {});
        } catch { /* 自检上报失败不影响功能 */ }
      };

      const register = (toolName, Component) => {
        try {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key: toolName,
            inject: () => ({}),
          }, Component));
          ok.push(toolName);
        } catch (err) {
          errors.push(`${toolName}: ${err?.message || err}`);
          console.error(`[learnharness] 注册 ${toolName} 卡片失败：`, err?.message || err);
        }
      };

      for (const toolName of QUESTION_TOOLS) register(toolName, QuestionCard);
      for (const toolName of PLAN_TOOLS) register(toolName, PlanCard);
      for (const toolName of STATUS_TOOLS) register(toolName, StatusCard);

      // 调试挂载：页面加 ?lhdebug=<callId> 时，把题目卡真渲染到浮层上（不影响正常使用）
      try {
        const debugCallId = new URLSearchParams(location.search).get('lhdebug');
        if (debugCallId) {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'learnharness.debug',
            order: 999,
          }, () => h('div', {
            style: {
              position: 'fixed', right: 16, top: 16, width: 440, zIndex: 9999,
              pointerEvents: 'auto', borderRadius: 12, padding: 12,
              border: `1px solid ${COLORS.line}`,
              background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit',
              boxShadow: '0 12px 32px rgba(0,0,0,.28)',
            },
          }, [
            h('div', { key: 'h', style: { fontSize: 11, color: COLORS.muted, marginBottom: 6 } }, `debug: ${debugCallId}`),
            h(QuestionCard, { key: 'c', callId: debugCallId, toolName: 'learn_quiz', phase: 'start' }),
          ])));
        }
      } catch (err) {
        console.error('[learnharness] 调试挂载失败：', err?.message || err);
      }

      // 左侧栏入口 + 它打开的主区面板（同一个 id 对应）
      const openConversation = () => {
        try {
          ctx.layout.selectPanel(null);
        } catch (err) {
          console.error('[learnharness] 回到对话失败：', err?.message || err);
        }
      };

      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ openConversation }),
        }, LearnPanel));
        ok.push('main');
      } catch (err) {
        errors.push(`main: ${err?.message || err}`);
        console.error('[learnharness] 主面板注册失败：', err?.message || err);
      }

      /**
       * 让指定会话自动继续一轮。
       * 关键：conversation.send 是"作用域寻址"的——必须在 session 作用域的 ctx 上调用，
       * 根 ctx 调用会抛 "requires a session scope"（这正是之前"答完不继续"的原因）。
       */
      const sendToSession = async (text, sessionId) => {
        try {
          const sessions = ctx.get?.('sessions') ?? ctx.sessions;
          const scoped = sessionId ? sessions?.scope?.(sessionId) : null;
          const conversation = scoped?.get?.('conversation') ?? scoped?.conversation
            ?? ctx.get?.('conversation');
          if (!conversation?.send) {
            console.error('[learnharness] 拿不到 conversation.send（缺 session 作用域？）');
            return false;
          }
          await conversation.send(text);
          return true;
        } catch (err) {
          console.error('[learnharness] 自动继续失败：', err?.message || err);
          return false;
        }
      };

      // 右侧栏页签：先注册类型，再注册主体与标题（三者 key 一致）
      try {
        ctx.effect(
          () => ctx.sidebarRightTabs.register({
            id: PANE_ID,
            kind: PANE_KIND,
            priority: 'extension',
            title: () => '学习',
            guide: [{
              id: 'learnharness-guide',
              order: 40,
              title: () => '学习',
              description: () => '待作答的学习题',
              icon: LearnIcon,
            }],
          }),
          'learnharness.tab-kind',
        );
        ok.push('tab-kind');
      } catch (err) {
        errors.push(`tab-kind: ${err?.message || err}`);
        console.error('[learnharness] 页签类型注册失败：', err?.message || err);
      }

      try {
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PANE_ID,
          inject: () => ({
            send: sendToSession,
            mountedSession: () => ctx.sidebarRight.mounted?.getSnapshot?.() ?? null,
          }),
        }, QuestionPane));
        ok.push('sidebar.right.pane.tab');
      } catch (err) {
        errors.push(`sidebar.right.pane.tab: ${err?.message || err}`);
        console.error('[learnharness] 页签主体注册失败：', err?.message || err);
      }

      try {
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: PANE_ID,
        }, QuestionPaneTitle));
        ok.push('sidebar.right.pane.tab.title');
      } catch (err) {
        errors.push(`tab-title: ${err?.message || err}`);
        console.error('[learnharness] 页签标题注册失败：', err?.message || err);
      }

      // 顺便试着自动打开右侧栏「学习」页签（成功更好，失败不影响作答）
      try {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'learnharness-watcher',
          order: 901,
          inject: () => ({
            openTab: (kind) => ctx.sidebarRight.openTab(kind),
            isExpanded: () => ctx.sidebarRight.isExpanded(),
            toggleExpanded: () => ctx.sidebarRight.toggleExpanded(),
            mountedSession: () => ctx.sidebarRight.mounted?.getSnapshot?.() ?? null,
          }),
        }, PendingWatcher));
        ok.push('watcher');
      } catch (err) {
        errors.push(`watcher: ${err?.message || err}`);
      }

      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => '学习',
        }, LearnIcon));
        ok.push('sidebar.panellist');
      } catch (err) {
        errors.push(`sidebar.panellist: ${err?.message || err}`);
        console.error('[learnharness] 左侧栏入口注册失败：', err?.message || err);
      }

      report();

      // 可观测痕迹：排查"卡片没出现"时先看这里
      try {
        window.__learnharness = {
          ok,
          errors,
          registered: [...QUESTION_TOOLS, ...PLAN_TOOLS, ...STATUS_TOOLS],
          panel: PANEL_ID,
          components: { QuestionCard, PlanCard, StatusCard, LearnPanel, LearnIcon },
          at: new Date().toISOString(),
        };
      } catch { /* 忽略 */ }
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});
