# Changelog

## 0.3.2 — 2026-11-13

- 修复：作答历史被截断到 12 条 → 现在**有多少给多少**（`/state` 全量返回，前端全量渲染）
- 修复：学习记录串台 —— 右侧栏「学习」页签按**会话严格绑定**，未绑定的对话不再退回
  「最近修改的主题」，并显示「本对话还没有学习主题」提示
- 测试新增：`历史不截断`、`未绑定会话看不到任何学习记录`、`bound:false` 标记

## 0.3.1 — 2026-11-12

- 修复 web boot 启动失败：0.3.0 改包名后 `lib/client.js` 仍以旧 id `@local/dsh-learnharness` 注册，与 boot graph 的 row id `dsh-learnharness` 不一致，回退重放时触发 `duplicate factory registration` → `1 entry did not activate`。注册 id 已改为 `dsh-learnharness`。
- 从 0.3.0 直接升级即可，无需再手工打补丁。

## 0.3.0 — 2026-11-12

首个公开版本。

- 包名从 `@local/dsh-learnharness` 改为 `dsh-learnharness`（便于分发）
- 作答历史改为**默认收起**：`序号 · 题目 · 时间 · 判定`，点击展开细节
- 作答后**自动继续**：`ctx.sessions.scope(sessionId).conversation.send()`
- 题目**绑定会话**（别的会话看不到），未作答 12 小时自动作废
- 会话归档（`workspaceRegistry.archivedSessionIds`）后主题自动隐藏
- 作答历史进 `/state`（最近 12 条），左右两处学习界面共用
- 右侧栏「学习」页签：作答卡 + 历史；左侧栏「学习」面板：目标/阶段/进度/依赖图/历史
- 修正：`clientReport` 未声明导致自检路由 500/400
- 修正：`output.schema` 需用值 DSL 写法（真 `defineTool` 路径）
- 附带 `skills/learnharness/` 技能（可单独复制到 `~/.dsh/skills/` 使用）

## 0.2.0

- 左侧栏「学习」入口 + 主区学习面板
- 作答卡自动展开

## 0.1.0

- 初版：8 个工具、自建作答路由、对话流内卡片
