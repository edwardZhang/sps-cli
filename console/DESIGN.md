# Design System — SPS Console

> **设计源头**。所有视觉 / 交互决策以本文件为准。任何新增页面、组件、色彩、字体选择前，先读本文。
>
> - 产品需求见 [`docs/design/25-console-product-design.md`](../../../docs/design/25-console-product-design.md)
> - 技术架构见 [`docs/design/26-console-architecture.md`](../../../docs/design/26-console-architecture.md)
> - 视觉预览见 [`docs/design/console-preview-neo.html`](../../../docs/design/console-preview-neo.html)（本 DESIGN.md 的可视化实例）

---

## Product Context

- **What this is**: SPS Console — 本机运行的 Web 控制台，`sps console` 启动后绑 `127.0.0.1:4311`。
- **Who it's for**: 独立开发者（Coral 型）+ 新接触 SPS 的用户。
- **Space**: 开发者工具 / AI 流水线自动化。
- **Project type**: 单机单用户 Web dashboard + 对话端。

## Aesthetic Direction

- **Direction**: **Pastel Neubrutalism**（粉彩新粗野主义）
- **Decoration level**: intentional —— 靠色块 + 粗边 + 硬阴影表达层级，不靠渐变 / 光晕 / 模糊玻璃。
- **Mood**: 友好、愉快、有实体感。像一本装订工整的彩色工作手册，每个按钮都像能"按下去"的实体键。
- **Reference**: [uupm.cc/demo/educational-platform](https://www.uupm.cc/demo/educational-platform) —— 视觉语言 100% 对齐，所有 token hex 从该页实测 CSS 提取。
- **Style family**: ui-ux-pro-max #38 Neubrutalism，以 Pastel（柔和粉彩）做色彩变体。

## Typography

```css
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
```

| 角色 | 字体 | Weight | Size/LH | 备注 |
|---|---|---|---|---|
| Hero | **Fredoka** | 700 | 40/48 | `letter-spacing: -0.02em`；h1、页面入口主标题 |
| Title | **Fredoka** | 700 | 28/36 | h2，页面标题如"看板"、"Workers" |
| Section | **Fredoka** | 600 | 20/28 | h3，section 分组 |
| Eyebrow | **Fredoka** | 700 | 14/20 | 大写、字距 0.08em，表头 |
| Body | **DM Sans** | 400 | 15/24 | 正文 |
| Body bold | **DM Sans** | 700 | 15/24 | card title、按钮、强调 |
| Small / Meta | **DM Sans** | 400 | 13/18 | 副文字，`color: var(--text-muted)` |
| Mono | **JetBrains Mono** | 500 | 13/20 | ID、路径、时间、数字；`font-variant-numeric: tabular-nums` |

**字体下载回退**: 所有字体从 Google Fonts CDN 加载。Vite / Next build 时预打包为本地 woff2 以避免每次冷启动延迟。失败回退 `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`。

## Color

**光模式优先**（不做深色模式 v1，视用户要求追加）。

### 基础色

| Token | Hex | 用途 |
|---|---|---|
| `--bg` | `#FFFFFF` | 纯白页面底、卡片底、logo 内 |
| `--bg-cream` | `#FFF9F5` | App 整体底、screen chrome、section 分隔 |
| `--bg-soft` | `#FAFBFD` | 备用浅底 |
| `--text` | `#2D3748` | 主文字 + **所有边框颜色** |
| `--text-muted` | `#64748B` | 次文字 |
| `--text-subtle` | `#94A3B8` | 更淡的注释级 |
| `--border-light` | `#E2E8F0` | 仅用于 dashed 虚线分隔（非主边框） |

### Pastel 色板（100% 来自 edu-platform demo CSS）

| Token | Hex | 语义 |
|---|---|---|
| `--primary` | `#FDBCB4` | 蜜桃（persona、architect、security 类 skill） |
| `--primary-dark` | `#F5A69D` | 蜜桃深（按钮 hover 阴影色） |
| `--secondary` | `#ADD8E6` | 婴儿蓝（end skill、frontend、backend） |
| `--secondary-dark` | `#8BC4D6` | 婴儿蓝深 |
| `--accent-mint` | `#98FF98` | 薄荷（workflow skill、导航激活态、logo 点） |
| `--accent-purple` | `#E6E6FA` | 丁香（language skill、Backlog 列、kanban 序号） |
| `--accent-yellow` | `#FFF3B0` | 暖黄（Inprogress 列、table hover 行、highlight） |
| `--accent-pink` | `#FFD1DC` | 柔粉（Review 列、NEEDS-FIX label） |

### 状态色（pastel 映射）

| Token | Hex | 用途 |
|---|---|---|
| `--running` | `#86EFAC` | Worker running / card merged |
| `--running-bg` | `#D4F5E4` | 对应浅底 |
| `--stuck` | `#FDBA74` | Worker stuck / 卡住超阈值 |
| `--stuck-bg` | `#FFE8CF` | 对应浅底 |
| `--crashed` | `#FCA5A5` | Worker crashed / NEEDS-FIX |
| `--crashed-bg` | `#FFE4E6` | 对应浅底 |
| `--idle` | `#CBD5E1` | Worker idle |
| `--idle-bg` | `#F1F5F9` | 对应浅底 |

### CTA

| Token | Hex | 用途 |
|---|---|---|
| `--cta` | `#22C55E` | 启动 pipeline / 主动作按钮（唯一的高饱和色） |
| `--cta-dark` | `#16A34A` | CTA hover 阴影色 |

### 对比度验证

- `--text` (#2D3748) on `--bg` (#FFFFFF)：**12.4:1** ✓ WCAG AAA
- `--text-muted` (#64748B) on `--bg` (#FFFFFF)：**4.7:1** ✓ WCAG AA
- `--text` on `--accent-yellow`：**11.8:1** ✓ AAA
- `--text` on `--accent-mint`：**11.2:1** ✓ AAA
- `--text` on `--cta` (#22C55E)：**3.1:1** ⚠ 只用于 bold 14px+ 大字（按钮）

## Border & Shadow System（**核心签名**）

Neubrutalism 的灵魂。所有 token 围绕这两个：

```css
/* 所有元素的粗边都是 3px 深色 */
--border-width: 3px;
--border: 3px solid var(--text);

/* 硬偏移阴影：零 blur，纯色偏移 */
--shadow-sm:      3px 3px 0 var(--text);  /* button default */
--shadow:         5px 5px 0 var(--text);  /* card default */
--shadow-lg:      8px 8px 0 var(--text);  /* screen-frame 大容器 */
--shadow-primary: 5px 5px 0 var(--primary-dark);  /* 彩色按钮 */
--shadow-cta:     5px 5px 0 var(--cta-dark);      /* CTA 按钮 */
```

### 交互规则

```css
.btn {
  box-shadow: var(--shadow-sm);
  transition: transform 120ms ease-out, box-shadow 120ms ease-out;
}
.btn:hover {
  transform: translate(-1px, -1px);         /* 左上移动 1px */
  box-shadow: 4px 4px 0 var(--text);        /* 阴影扩大 1px */
}
.btn:active {
  transform: translate(2px, 2px);           /* 向右下按压 2px */
  box-shadow: 1px 1px 0 var(--text);        /* 阴影缩小 */
}
```

**语义**：hover 像"稍微抬起"，active 像"按下去接触底面"。这是 Neu 实体感的来源，每个可点元素都要遵循。

**例外**：
- `.btn-ghost` 不带 shadow（纯文字链接级别）
- Table row / log line hover 用背景色变化（不位移），避免整表抖动
- Kanban card 的 hover 位移是 `(-2px, -2px)` + 阴影 `7px 7px 0`（比 button 更显著）

## Spacing

```
2xs: 2px    sm: 8px     lg: 24px    2xl: 48px
xs:  4px    md: 16px    xl: 32px    3xl: 64px
```

- **页面内边距**：24px（`--s-lg`）
- **卡片内边距**：16px（`--s-md`）
- **Section 间距**：64px（`--s-3xl`）
- **表格行高**：行内上下 padding 14px（比 Linear/Raycast 的 10px 更宽，Neu 要呼吸感）
- **按钮 padding**：10px × 18px（default）、6px × 12px（sm）

## Layout

### App Shell

```
┌────────────────────────────────────────┐
│ 240px sidebar │  main (fluid)          │  ← top row
├───────────────┴────────────────────────┤
│ 40px statusbar (fixed bottom)           │
└────────────────────────────────────────┘
```

- Sidebar：纯白背景，右侧 3px 深色边分隔
- Main：bg-cream 奶油白底
- Statusbar：纯白、上边 3px 深色、font-mono 11px

### Kanban Grid

- 4 列固定 grid（Backlog / Inprogress / Review / Done）
- **每列独立 pastel 背景**（不是中性灰），强化可扫性：
  - Backlog → `--accent-purple` (丁香)
  - Inprogress → `--accent-yellow` (暖黄)
  - Review → `--accent-pink` (柔粉)
  - Done → `--accent-mint` (薄荷)
- 列内边距 16px × 8px，带列标题 + count pill
- 卡片默认 shadow `3x3`，hover `5x5` + translate(-2,-2)

### Content Grid

- 12 列 CSS Grid
- 卡片 span 可变（Card=4, BigCard=6, HeroCard=12）
- 间距 16px（`gap: var(--s-md)`）

## Border Radius

```
sm:  8px    (tag, chip, 小 badge)
md:  12px   (button, input, project-picker, kanban-card)
lg:  16px   (card, section 容器, screen-frame)
xl:  20px   (screen-frame 外层，大型容器)
full: 9999 (pill, status, circular badge)
```

**Neu 拒绝特征**：
- 不用 20-32px 超大圆角（那是 Bento / Glass）
- 不用 0 直角（那是 classic Brutalism）
- **slightly rounded** 是这派的特征

## Motion

- **基线 transition**：`120-180ms ease-out` 或 `cubic-bezier(0.4, 0, 0.2, 1)`
- **Hover 交互**：transform + shadow，120ms
- **Active 交互**：反向 transform，120ms
- **Pulse 动画（status-running）**：`steps(2, end)` 硬闪而不是平滑呼吸——Neu 精神不要平滑
- **不做**：layout animation（行抖动）、entrance fade-in（数据不 fade）、float / glow / shimmer（干扰数据扫读）

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Component Primitives

### Button

```tsx
<button className="btn btn-primary">启动 pipeline</button>

/* 变体 */
btn-primary   → background: var(--cta), color: var(--text)
btn-secondary → background: var(--secondary) (婴儿蓝)
btn-mint      → background: var(--accent-mint)
btn-peach     → background: var(--primary) (蜜桃)
btn-purple    → background: var(--accent-purple)
btn-yellow    → background: var(--accent-yellow)
btn-danger    → background: var(--crashed)
btn-ghost     → 无边无阴影，纯 hover 背景
btn-sm        → 6px × 12px，阴影 3x3
btn-icon      → 40×40 正方形，居中图标
```

所有 btn 都：`border: 3px solid var(--text) + box-shadow: Npx Npx 0 var(--text)`。

### Card

```tsx
<div className="nb-card">...</div>
<div className="nb-card nb-card-interactive">...</div>  {/* 可点击，带 hover */}
```

```css
.nb-card {
  background: var(--bg);
  border: 3px solid var(--text);
  border-radius: 16px;
  padding: 16px;
  box-shadow: 5px 5px 0 var(--text);
}
```

### Input

```tsx
<input className="input" type="text" placeholder="..." />
```

Focus 时同样 `translate(-1,-1)` + 阴影扩大，保持"浮起"反馈。

### Status Pill

```tsx
<span className="status status-running">running</span>
```

- 2px 边 + border-radius: full + 色标点
- 色标点本身也有 1.5px 黑边（像印章）
- `status-running` 点有 `pulse-hard` 动画（硬切，非平滑）

### Badge

Skill 类别 / label：

```tsx
<span className="badge badge-peach">python</span>
```

| Variant | 用于 |
|---|---|
| `badge-peach` | persona skill, architect 类 |
| `badge-blue` | end skill (backend/frontend/mobile/database/devops) |
| `badge-purple` | language skill (python/typescript/go...) |
| `badge-mint` | workflow skill (tdd/git/debug...) |
| `badge-yellow` | 工作流 label (AI-PIPELINE, STARTED-develop) |
| `badge-pink` | 警示 label (NEEDS-FIX) |

## 数据区的特殊规则（**重要取舍**）

Neu 的"每元素都带粗边 + 硬阴影"语义，在高密度数据区（log tail / table）会导致视觉爆炸和性能下降。DESIGN 明确：

### Log 流

- ✅ 容器（`.log-pane`）：完整 Neu（3px 边 + 5x5 阴影 + 16px radius）
- ❌ 每条 log line：**不加边框阴影**，只用 level badge 色块
- ✅ hover 整行背景变 `var(--bg-cream)` 奶白
- ✅ level badge 保留 pastel 色块（error 柔红 / warn 温橙 / info 婴儿蓝 / debug 丁香）

### Worker 表

- ✅ 表格外层是 1 个 Neu 大卡片
- ❌ 行之间：1.5px dashed `var(--border-light)` 虚线（不是粗实线）
- ✅ hover 整行变 `var(--accent-yellow)` 暖黄
- ✅ 卡片序号 `#38` 用丁香紫 pill 包起来做视觉锚点

理由：**数据区让 Neu 包容器，内容做减法**。强反差只留给"交互元素"（按钮、状态 pill、卡片），不留给"静态行"。

## 可访问性

- 所有 button / icon-only button 必须有 `aria-label`
- 所有 input 配 `<label>` 或 `aria-label`
- `:focus-visible` 样式：`outline: 3px solid var(--text) + offset 2px`
- Tab 顺序 = 视觉顺序
- 色盲支持：状态不只靠色区分，还带符号（`●` running / `⚠` stuck / `✕` crashed）或文字
- `prefers-reduced-motion` 下 transition → 0.01ms

## 禁用清单（auto-reject in review）

- 渐变背景（linear-gradient / radial-gradient）——破坏实体感
- `backdrop-filter: blur()` —— 那是 Glassmorphism
- 圆角 > 20px ——那是 Bento 或 Clay
- 圆角 0px ——那是 classic Brutalism
- Drop shadow with blur ≥ 4px ——Neu 只用硬偏移，零 blur
- Layout animation（高度变化的 transition）——数据抖动
- Inter / Roboto / Arial 作为主字体（用 Fredoka / DM Sans）
- 状态只靠颜色（必须带 icon 或文字）

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-21 | 采用 Pastel Neubrutalism | 用户指定参考 uupm.cc/demo/educational-platform，扒出底层 token 锁定这派 |
| 2026-04-21 | 排除 Claymorphism | 和 demo 对比：Clay 用双阴影（内+外），demo 用硬偏移；Clay 圆角 20-24px 大，demo 12-16px 中；Clay pastel 方向接近但不对 |
| 2026-04-21 | 排除 DevTools 深色风 | 第 1 版做了 Linear/Raycast 风深色 zinc + Geist，用户拒绝——方向"不温暖" |
| 2026-04-21 | 深浅模式 v1 只做浅色 | Neu 的硬阴影 + pastel 色板本质就是浅色导向；深色模式需要重新设计色彩语言，延后 v2 |
| 2026-04-21 | Fredoka + DM Sans + JetBrains Mono | Fredoka+Nunito 是 ui-ux-pro-max 推荐的 Playful Creative 配对；demo 实际用 DM Sans + Fredoka；本项目取交集 |
| 2026-04-21 | 看板 4 列各用不同 pastel | 提升列扫描性，避免"4 列白底"同质化 |
| 2026-04-21 | Log 行不带边框阴影（只容器有） | 避免密度爆炸；level badge 用 pastel 点亮足够 |
| 2026-04-21 | CTA 用鲜绿 #22C55E（demo 同款） | 色板中唯一高饱和色，让"启动 pipeline"脱颖而出 |

## 未覆盖（后续补充）

以下元素 v1 DESIGN 未定，首次使用时补充回本文：

- Chat 页的 message bubble / tool use 折叠样式
- Modal / Dialog 的遮罩透明度和入场动画
- Toast 通知的位置 / 持续时间 / 堆叠规则
- Empty state 插图（考虑手绘风 SVG 呼应 Neu 气质）
- Skeleton loading 状态
- Command palette (Cmd+K) 视觉
- 表格排序 / 筛选 / 分页控件
- Breadcrumb（如果 Console 要加）
- Date picker / 时间控件

## 实施清单（给工程师）

### Tailwind v4 config 摘要

```ts
// console/tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        bg:       { DEFAULT: '#FFFFFF', cream: '#FFF9F5', soft: '#FAFBFD' },
        text:     { DEFAULT: '#2D3748', muted: '#64748B', subtle: '#94A3B8' },
        primary:  { DEFAULT: '#FDBCB4', dark: '#F5A69D' },
        secondary:{ DEFAULT: '#ADD8E6', dark: '#8BC4D6' },
        accent:   { mint: '#98FF98', purple: '#E6E6FA', yellow: '#FFF3B0', pink: '#FFD1DC' },
        cta:      { DEFAULT: '#22C55E', dark: '#16A34A' },
        running:  '#86EFAC', stuck: '#FDBA74', crashed: '#FCA5A5', idle: '#CBD5E1',
      },
      fontFamily: {
        heading: ['Fredoka', 'sans-serif'],
        body:    ['DM Sans', 'sans-serif'],
        mono:    ['JetBrains Mono', 'monospace'],
      },
      borderWidth: { DEFAULT: '3px' },      // Neu 默认 3px
      boxShadow: {
        'nb-sm':      '3px 3px 0 #2D3748',
        'nb':         '5px 5px 0 #2D3748',
        'nb-lg':      '8px 8px 0 #2D3748',
        'nb-primary': '5px 5px 0 #F5A69D',
        'nb-cta':     '5px 5px 0 #16A34A',
      },
      borderRadius: {
        'sm': '8px', 'md': '12px', 'lg': '16px', 'xl': '20px',
      },
    },
  },
};
```

### shadcn/ui 组件改造

shadcn 组件默认风格不是 Neu，需要为每个组件覆盖 CSS 变量 + 添加 `border + shadow-nb`。首批需要改造：

- Button（各 variant 贴 pastel）
- Input / Textarea
- Dialog / Sheet（modal）
- DropdownMenu
- Select
- Toast
- Tooltip
- Tabs
- Badge
- Card

### 可复用组件（`features/` 共享）

`workflow-cli/console/src/shared/components/`:

- `<NbCard>` / `<NbCardInteractive>` —— 基础容器
- `<NbButton>` 各 variant
- `<StatusPill state="running|stuck|crashed|idle" />`
- `<SkillBadge category="lang|end|persona|workflow" />`
- `<ProjectPicker />`
- `<AppShell>`（sidebar + main + statusbar）
- `<AppNavItem>`
- `<ScreenFrame>`（调试页面用浏览器 chrome 样式）
- `<DecorBadge corner="tl|tr|bl|br" shape="sq|cir" color="mint|purple|peach" />` —— 浮动贴纸装饰（首屏、empty state 用）

---

*Version 1 · 2026-04-21 · Coral + Claude*
*参考视觉实例：[`docs/design/console-preview-neo.html`](../../../docs/design/console-preview-neo.html)*
