# CLAUDE.md — workflow-cli/console/

## Design System

**Always read `DESIGN.md` before making any visual or UI decisions.**

All font choices, colors, spacing, aesthetic direction, and component patterns are defined in `DESIGN.md`. Do not deviate without explicit user approval.

核心摘要（完整规范见 [`DESIGN.md`](./DESIGN.md)）：

- **风格**：Pastel Neubrutalism（粉彩新粗野主义）
- **核心签名**：3px 深色粗边（`#2D3748`）+ 硬偏移阴影（`Npx Npx 0 #2D3748`，零 blur）
- **字体**：Fredoka（heading）+ DM Sans（body）+ JetBrains Mono（data）
- **圆角**：8/12/16/20px（不用 0 不用 24+）
- **色板**：pastel 蜜桃/婴儿蓝/薄荷/丁香/暖黄 + CTA 鲜绿
- **光模式**：浅色优先（v1 不做深色）

### 禁用清单

- ❌ 渐变背景（linear/radial gradient）—— 破坏实体感
- ❌ `backdrop-filter: blur()` —— 那是 Glassmorphism
- ❌ Drop shadow with blur ≥ 4px —— Neu 只用硬偏移
- ❌ 圆角 > 20px 或 0px
- ❌ Inter / Roboto / Arial 作为主字体
- ❌ Layout animation（数据抖动）
- ❌ 状态只靠颜色区分（必须带 icon 或文字）

### 必遵守规则

- ✅ 所有交互元素带 `:focus-visible` 样式
- ✅ 按钮 hover = translate(-1,-1) + shadow 扩大；active = translate(2,2) + shadow 缩小
- ✅ 所有 button / icon-button 有 `aria-label`
- ✅ `prefers-reduced-motion` 下 transition → 0.01ms
- ✅ 数据区（log table / worker table）采用"容器 Neu 化、内容扁平化"策略

### Tailwind 配置

参考 `DESIGN.md` 末尾的实施清单，直接复制到 `console/tailwind.config.ts`。

### 视觉参考

- 活页预览：[`../../../docs/design/console-preview-neo.html`](../../../docs/design/console-preview-neo.html)
- 灵感来源：[uupm.cc/demo/educational-platform](https://www.uupm.cc/demo/educational-platform)

---

## QA / Review 规则

- QA 模式下发现任何和 `DESIGN.md` 不符的代码，**必须标注并建议修改**。
- Code review 时发现 inline `style={}` 覆盖 token、未用 Tailwind 类、硬编码色号 —— block。
- 任何新增组件 / 新增样式前，先在 DESIGN.md 的 "未覆盖" 章节找对应项；没有就补一条 decision log。
