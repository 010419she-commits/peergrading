# 品牌网站 · 视觉方向 A 样稿（第 4 版）

## 一、定位与范围

本版是**方向 A：深色、暖白、浅金的完整视觉样稿**，用于讨论构图、字体、留白与页面节奏。

验收分为两层：

- **样稿自身质量**：本版提供完整实现，修正已发现的静态代码问题；实际呈现与交互仍需浏览器验证。
- **原网站改版完成度**：尚不能判断，当前没有真实网站、业务资料与品牌资产。本版不代表已经完成原网站改版。

### 站点理解表

| 需要了解的内容 | 当前状态 | 对设计的影响 |
|---|---|---|
| 网站地址或页面截图 | 未提供 | 确定修改范围和现有问题 |
| 业务、产品与主要受众 | 未提供 | 确定视觉气质和内容优先级 |
| 最重要的用户操作 | 未提供 | 确定主要入口及页面顺序 |
| 品牌标志、颜色与字体规范 | 未提供 | 确定应保留的识别元素 |
| 实际文案、图片与项目资料 | 未提供 | 确定排版密度及图片构图 |
| 技术栈与设备支持范围 | 未提供 | 确定实现和兼容要求 |
| 用户不满意的具体位置 | 未提供 | 确定首轮精修重点 |

### 示例内容边界

页面采用连贯的示例文案，不展示真实商业经历。没有公司名称、客户姓名、数字业绩、客户证言、地址、电话、邮箱或备案号。

“团队背景”“合作方式”等仍属于**未经确认的示例字段**，正式使用前必须核实或重写。视觉探索区为 CSS 概念构图，不作为商业项目展示。

页面保留顶部演示提示，以及联系区的一句渠道说明；其余状态信息集中在本文档中。

## 二、设计系统

| 角色 | 变量或选择器 | 取值 |
|---|---|---|
| 页面背景 | `--bg` | `#10141b` |
| 分区背景 | `--surface` | `#171d27` |
| 悬停背景 | `--surface-soft` | `#1d2632` |
| 标题与正文 | `--ink` | `#f3f0e9` |
| 次级文字 | `--muted` | `#b7bfcc` |
| 强调色 | `--accent` | `#d6ba81` |
| 主按钮悬停色 | `--accent-soft` | `#e6cea0` |
| 装饰分隔线 | `--line` | `#353f4d` |
| 控件边框 | `--control-line` | `#8994a5` |
| 标题字体 | `--serif` | Noto Serif SC 500，加系统衬线回退 |
| 正文字体 | `--sans` | 系统无衬线字体 |
| H1 | `h1` | `clamp(36px, 5.6vw, 72px)`，行高 1.2 |
| H2 | `h2` | `clamp(28px, 3.4vw, 48px)`，行高 1.3 |
| H3 | `h3` | `clamp(19px, 1.8vw, 23px)`，行高 1.5 |
| 正文 | `body` | 16px，行高 1.8 |
| 引导段落 | `.lead` | 16–18px，行高 1.9 |
| 小字 | 副标、标签、页脚 | 最小 13px |
| 组件间距 | 各组件 | 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64 / 72px |
| 分区留白 | `--section-space` | `clamp(72px, 9vw, 128px)` |
| 内容宽度 | `--wrap` | 最大 1184px |
| 页面侧边距 | `--gutter` | `clamp(20px, 5vw, 72px)` |
| 封面比例 | `.cover` | 本样稿统一 4:5 |
| 按钮圆角 | `.button` | 3px |
| 边框 | 各组件 | 1px |
| 焦点轮廓 | `:focus-visible` | 2px，偏移 3px |
| 动效曲线 | `--ease` | `cubic-bezier(.2,.7,.2,1)` |
| 悬停过渡 | `--t` | `.4s` |
| 正文进场 | `rise` | 位移 14px，不改变透明度 |
| 装饰进场 | `settle` | 位移 24px，可淡入 |

颜色对比度尚未计算。待检查的组合包括正文和次级文字对两种背景、强调文字对两种背景、主按钮文字对按钮背景，以及控件边框和焦点轮廓对实际相邻背景。

## 三、完整代码

以下内容可保存为 `index.html`。除标题字体外，无外部资源请求。

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#10141b">
  <meta name="robots" content="noindex, nofollow">
  <meta
    name="description"
    content="品牌网站视觉方向样稿。页面采用示例文案与概念构图，用于讨论视觉方向。"
  >
  <title>品牌网站 · 视觉方向 A 样稿</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@500&display=swap"
  >

  <style>
    /* 1. Design tokens */
    :root {
      color-scheme: dark;

      --bg: #10141b;
      --surface: #171d27;
      --surface-soft: #1d2632;
      --ink: #f3f0e9;
      --muted: #b7bfcc;
      --accent: #d6ba81;
      --accent-soft: #e6cea0;
      --line: #353f4d;
      --control-line: #8994a5;

      --serif: "Noto Serif SC", "Source Han Serif SC",
        "Songti SC", "STSong", "SimSun", serif;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
        sans-serif;

      --wrap: 1184px;
      --gutter: clamp(20px, 5vw, 72px);
      --section-space: clamp(72px, 9vw, 128px);
      --ease: cubic-bezier(.2, .7, .2, 1);
      --t: .4s;
    }

    /* 2. Base */
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    html {
      scroll-behavior: smooth;
      scroll-padding-top: var(--anchor-offset, 112px);
      -webkit-text-size-adjust: 100%;
    }

    body {
      margin: 0;
      color: var(--ink);
      background: var(--bg);
      font-family: var(--sans);
      font-size: 16px;
      font-weight: 400;
      line-height: 1.8;
      -webkit-font-smoothing: antialiased;
    }

    body.menu-open {
      overflow: hidden;
    }

    a {
      color: inherit;
      text-underline-offset: .25em;
    }

    a,
    button {
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    button {
      color: inherit;
      font: inherit;
    }

    [hidden] {
      display: none !important;
    }

    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
    }

    ::selection {
      color: var(--bg);
      background: var(--accent);
    }

    h1,
    h2,
    h3,
    p,
    ol,
    dl,
    dd {
      margin: 0;
    }

    h1,
    h2 {
      font-family: var(--serif);
      font-weight: 500;
      overflow-wrap: anywhere;
    }

    h1 {
      max-width: 12.5em;
      font-size: clamp(36px, 5.6vw, 72px);
      line-height: 1.2;
      letter-spacing: .01em;
    }

    h2 {
      max-width: 16em;
      font-size: clamp(28px, 3.4vw, 48px);
      line-height: 1.3;
    }

    h3 {
      font-size: clamp(19px, 1.8vw, 23px);
      font-weight: 500;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    p,
    dt,
    dd {
      overflow-wrap: anywhere;
    }

    /* 3. Shared layout */
    .wrap {
      width: min(
        var(--wrap),
        calc(100% - var(--gutter) - var(--gutter))
      );
      margin-inline: auto;
    }

    .section {
      padding-block: var(--section-space);
    }

    /* 这些目标仅通过脚本或锚点获得焦点，不进入 Tab 顺序。 */
    .section:focus,
    main:focus {
      outline: none;
    }

    .eyebrow {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      color: var(--accent);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: .14em;
    }

    .eyebrow::before {
      flex: 0 0 28px;
      height: 1px;
      background: currentColor;
      content: "";
    }

    .lead {
      max-width: 36em;
      color: var(--muted);
      font-size: clamp(16px, 1.3vw, 18px);
      line-height: 1.9;
    }

    .section-head {
      display: grid;
      gap: 24px;
      margin-bottom: 48px;
    }

    /* 4. Controls */
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      min-height: 48px;
      max-width: 100%;
      padding: 12px 24px;
      border: 1px solid var(--control-line);
      border-radius: 3px;
      color: var(--ink);
      background: transparent;
      font-size: 15px;
      font-weight: 500;
      line-height: 1.5;
      text-align: center;
      text-decoration: none;
      overflow-wrap: anywhere;
      cursor: pointer;
      transition:
        background-color var(--t) var(--ease),
        border-color var(--t) var(--ease),
        color var(--t) var(--ease);
    }

    .button svg {
      flex: 0 0 18px;
      width: 18px;
      height: 18px;
      transition: transform var(--t) var(--ease);
    }

    .button-primary {
      border-color: var(--accent);
      color: var(--bg);
      background: var(--accent);
    }

    .text-link {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      max-width: 100%;
      border-bottom: 1px solid var(--control-line);
      color: var(--ink);
      font-size: 15px;
      text-decoration: none;
      overflow-wrap: anywhere;
      transition:
        border-color var(--t) var(--ease),
        color var(--t) var(--ease);
    }

    .text-link svg {
      flex: 0 0 16px;
      width: 16px;
      height: 16px;
      transition: transform var(--t) var(--ease);
    }

    .skip-link {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 100;
      max-width: calc(100% - 24px);
      padding: 12px 18px;
      color: var(--bg);
      background: var(--ink);
      transform: translateY(-200%);
    }

    .skip-link:focus {
      transform: none;
    }

    /* 5. Demonstration notice and header */
    .demo-note {
      padding: 9px var(--gutter);
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      background: var(--surface);
      font-size: 13px;
      text-align: center;
    }

    .site-header {
      position: sticky;
      top: 0;
      z-index: 20;
      border-bottom: 1px solid var(--line);
      background: var(--bg);
    }

    @supports (backdrop-filter: blur(1px)) or
      (-webkit-backdrop-filter: blur(1px)) {
      .site-header {
        background: rgba(16, 20, 27, .82);
        -webkit-backdrop-filter: blur(14px);
        backdrop-filter: blur(14px);
      }
    }

    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      min-height: 84px;
    }

    .brand {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: baseline;
      align-content: center;
      gap: 4px 12px;
      min-height: 48px;
      min-width: 0;
      padding-block: 8px;
      text-decoration: none;
      transition: color var(--t) var(--ease);
    }

    .brand-name {
      font-family: var(--serif);
      font-size: 24px;
      font-weight: 500;
      line-height: 1.4;
      letter-spacing: .12em;
      overflow-wrap: anywhere;
    }

    .brand-caption {
      color: var(--muted);
      font-size: 13px;
      letter-spacing: .16em;
      text-transform: uppercase;
    }

    .primary-nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 4px 28px;
    }

    .primary-nav a {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      padding: 8px 2px;
      color: var(--muted);
      font-size: 14px;
      letter-spacing: .04em;
      text-decoration: none;
      transition: color var(--t) var(--ease);
    }

    .menu-toggle {
      display: none;
      flex: 0 0 auto;
    }

    /* 无脚本或缺少 dialog 能力时，保留普通导航。 */
    @media (max-width: 859px) {
      .header-inner {
        flex-wrap: wrap;
        gap: 4px 16px;
        padding-block: 12px;
      }

      .primary-nav {
        justify-content: flex-start;
        width: 100%;
        gap: 4px 20px;
      }

      .menu-ready .header-inner {
        flex-wrap: nowrap;
      }

      .menu-ready .primary-nav {
        display: none;
      }

      .menu-ready .menu-toggle {
        display: inline-flex;
      }
    }

    /* 6. Mobile modal navigation */
    .menu-dialog:not([open]) {
      display: none;
    }

    .menu-dialog {
      position: fixed;
      inset: 0;
      width: 100%;
      max-width: none;
      height: 100%;
      height: 100dvh;
      max-height: none;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      border: 0;
      color: var(--ink);
      background: var(--bg);
      overscroll-behavior: contain;
    }

    /* 需与 --bg 同步，避免依赖 backdrop 的变量继承。 */
    .menu-dialog::backdrop {
      background: #10141b;
    }

    .menu-shell {
      display: flex;
      flex-direction: column;
      min-height: 100%;
      padding:
        max(24px, env(safe-area-inset-top))
        max(24px, env(safe-area-inset-right))
        max(32px, env(safe-area-inset-bottom))
        max(24px, env(safe-area-inset-left));
    }

    .menu-top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .menu-title {
      color: var(--muted);
      font-family: var(--sans);
      font-size: 13px;
      font-weight: 500;
      line-height: 1.5;
      letter-spacing: .14em;
    }

    .dialog-nav {
      display: grid;
      gap: 8px;
      width: min(100%, 560px);
      margin: auto;
      padding-block: 56px;
    }

    .dialog-nav a {
      display: flex;
      align-items: baseline;
      gap: 20px;
      min-height: 56px;
      padding: 14px 8px;
      border-bottom: 1px solid var(--line);
      font-family: var(--serif);
      font-weight: 500;
      font-size: clamp(26px, 5vw, 38px);
      line-height: 1.4;
      text-decoration: none;
      overflow-wrap: anywhere;
      transition: color var(--t) var(--ease);
    }

    .dialog-nav a small {
      flex: 0 0 auto;
      color: var(--accent);
      font-family: var(--sans);
      font-size: 13px;
      letter-spacing: .1em;
    }

    .menu-caption {
      color: var(--muted);
      font-size: 13px;
    }

    /* 7. Hero
       仅外层承担最小高度；正文不设裁切或继承最小高度。 */
    .hero {
      display: flex;
      flex-direction: column;
      min-height: min(48rem, 86svh);
      padding-block:
        clamp(64px, 8vw, 112px)
        clamp(32px, 4vw, 48px);
    }

    .hero-layout {
      flex: 1;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(180px, 1fr) auto;
      gap: 40px;
    }

    .hero-copy {
      min-width: 0;
    }

    .hero h1 span {
      color: var(--accent);
    }

    .hero .lead {
      margin-top: 28px;
    }

    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 20px 32px;
      margin-top: 40px;
    }

    .hero-bottom {
      display: flex;
      flex-wrap: wrap;
      align-self: end;
      grid-column: 1 / -1;
      gap: 16px 32px;
      color: var(--muted);
      font-size: 13px;
      letter-spacing: .06em;
    }

    .hero-bottom > span {
      flex: 1 1 200px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
    }

    /* 构图占据自己的网格区域。
       外层控制最终透明度与裁切，内层承担进场动画。 */
    .hero-art {
      position: relative;
      min-width: 0;
      min-height: 180px;
      overflow: hidden;
      opacity: .55;
      pointer-events: none;
    }

    .hero-art-inner {
      position: absolute;
      inset: 0;
      opacity: 1;
    }

    .hero-art .glow {
      position: absolute;
      inset: -20%;
      background: radial-gradient(
        ellipse at 60% 45%,
        rgba(214, 186, 129, .18),
        transparent 62%
      );
    }

    .hero-art .grid-lines {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(var(--line) 1px, transparent 1px),
        linear-gradient(90deg, var(--line) 1px, transparent 1px);
      background-size: 80px 80px;
      opacity: .3;
      -webkit-mask-image:
        radial-gradient(ellipse at center, #000, transparent 75%);
      mask-image:
        radial-gradient(ellipse at center, #000, transparent 75%);
    }

    .hero-art .ring {
      position: absolute;
      left: 50%;
      top: 48%;
      width: 72%;
      aspect-ratio: 1;
      border: 1px solid rgba(214, 186, 129, .46);
      border-radius: 50%;
      transform: translate(-50%, -50%);
    }

    .hero-art .ring-2 {
      left: 60%;
      top: 62%;
      width: 44%;
      border-color: rgba(243, 240, 233, .2);
    }

    .hero-art .bar {
      position: absolute;
      left: 50%;
      top: 8%;
      bottom: 8%;
      width: 1px;
      background: linear-gradient(
        to bottom,
        transparent,
        var(--accent) 35%,
        var(--accent) 65%,
        transparent
      );
    }

    .hero-art .dot {
      position: absolute;
      left: 50%;
      top: 48%;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      transform: translate(-50%, -50%);
    }

    /* 8. Introduction */
    .intro {
      border-top: 1px solid var(--line);
      background: var(--surface);
    }

    .intro-grid {
      display: grid;
      gap: 32px;
    }

    .intro-copy {
      display: grid;
      align-content: start;
      gap: 20px;
    }

    .principles {
      display: grid;
      gap: 32px 28px;
      margin-top: 64px;
      padding: 0;
      list-style: none;
    }

    .principle {
      min-width: 0;
      padding-top: 24px;
      border-top: 1px solid var(--line);
    }

    .principle-number {
      display: block;
      margin-bottom: 16px;
      color: var(--accent);
      font-family: var(--serif);
      font-size: 15px;
      font-weight: 500;
      letter-spacing: .08em;
    }

    .principle p {
      margin-top: 12px;
      color: var(--muted);
    }

    /* 9. Visual studies */
    .case-grid {
      display: grid;
      gap: 48px 28px;
    }

    .case-card {
      min-width: 0;
    }

    .cover {
      position: relative;
      isolation: isolate;
      overflow: hidden;
      aspect-ratio: 4 / 5;
      border: 1px solid var(--line);
      background: var(--surface);
    }

    .cover::before,
    .cover::after {
      position: absolute;
      content: "";
    }

    .cover-a {
      background: linear-gradient(165deg, #1c2535, #10141b 70%);
    }

    .cover-a::before {
      left: 50%;
      top: 58%;
      width: 120%;
      aspect-ratio: 1;
      border: 1px solid rgba(214, 186, 129, .5);
      border-radius: 50%;
      transform: translateX(-50%);
    }

    .cover-a::after {
      left: 12%;
      right: 12%;
      top: 34%;
      height: 1px;
      background: rgba(243, 240, 233, .35);
    }

    .cover-b {
      background: linear-gradient(200deg, #141a24, #10141b);
    }

    .cover-b::before {
      left: -20%;
      right: 30%;
      top: 20%;
      bottom: -10%;
      background: linear-gradient(
        135deg,
        rgba(214, 186, 129, .22),
        transparent 70%
      );
      transform: skewY(-12deg);
    }

    .cover-b::after {
      left: 68%;
      top: 12%;
      bottom: 12%;
      width: 1px;
      background:
        linear-gradient(to bottom, transparent, var(--accent), transparent);
    }

    .cover-c {
      background:
        radial-gradient(ellipse at 30% 20%, #1e2736, #10141b 70%);
    }

    .cover-c::before {
      inset: 18%;
      border: 1px solid rgba(243, 240, 233, .22);
    }

    .cover-c::after {
      inset: 30%;
      border: 1px solid rgba(214, 186, 129, .55);
      background: rgba(214, 186, 129, .04);
    }

    .cover-index {
      position: absolute;
      left: 20px;
      bottom: 16px;
      z-index: 1;
      color: var(--muted);
      font-family: var(--serif);
      font-size: 14px;
      font-weight: 500;
      letter-spacing: .14em;
    }

    .case-content {
      padding-top: 22px;
    }

    .case-kicker {
      margin-bottom: 8px;
      color: var(--accent);
      font-size: 13px;
      letter-spacing: .1em;
    }

    .case-description {
      margin-top: 12px;
      color: var(--muted);
    }

    /* 所有 dt/dd 共用同一个网格，标签允许换行。 */
    .case-meta {
      display: grid;
      grid-template-columns: 4.5em minmax(0, 1fr);
      gap: 10px 16px;
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
      font-size: 14px;
    }

    .case-meta dt,
    .case-meta dd {
      min-width: 0;
    }

    .case-meta dt {
      color: var(--muted);
    }

    @media (max-width: 399px) {
      .case-meta {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 4px;
      }

      .case-meta dd:not(:last-child) {
        margin-bottom: 12px;
      }
    }

    /* 10. Method */
    .method {
      border-top: 1px solid var(--line);
      background: var(--surface);
    }

    .steps {
      display: grid;
      padding: 0;
      border-top: 1px solid var(--line);
      list-style: none;
    }

    .step {
      display: grid;
      gap: 12px 40px;
      padding-block: 32px;
      border-bottom: 1px solid var(--line);
    }

    .step-number {
      color: var(--accent);
      font-family: var(--serif);
      font-size: clamp(28px, 3vw, 40px);
      font-weight: 500;
      line-height: 1.2;
    }

    .step p {
      max-width: 40em;
      color: var(--muted);
    }

    /* 11. Contact and footer */
    .contact {
      border-top: 1px solid var(--line);
    }

    .contact-panel {
      display: grid;
      gap: 32px;
      padding: clamp(28px, 5vw, 64px);
      border: 1px solid var(--line);
      background:
        radial-gradient(
          ellipse at 100% 0%,
          rgba(214, 186, 129, .1),
          transparent 55%
        ),
        var(--surface);
    }

    .contact-panel > div {
      min-width: 0;
    }

    .contact-panel h2 {
      max-width: 12em;
    }

    .contact-copy {
      display: grid;
      justify-items: start;
      gap: 20px;
      max-width: 36em;
      color: var(--muted);
    }

    .site-footer {
      padding-block: 32px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
      letter-spacing: .04em;
    }

    /* 12. Responsive layout */
    @media (min-width: 600px) {
      .principles,
      .case-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .hero-art {
        min-height: 240px;
      }

      .step {
        grid-template-columns: 5rem minmax(0, 1fr);
      }

      .step-number {
        grid-row: 1 / span 2;
      }
    }

    @media (min-width: 1000px) {
      .hero-layout {
        grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
        grid-template-rows: minmax(auto, 1fr) auto;
        column-gap: clamp(32px, 3vw, 48px);
        row-gap: 64px;
      }

      .hero-copy {
        align-self: center;
        grid-column: 1;
        grid-row: 1;
      }

      .hero-art {
        grid-column: 2;
        grid-row: 1;
        min-height: 320px;
        opacity: 1;
      }

      .hero-bottom {
        grid-row: 2;
      }

      .intro-grid,
      .section-head {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 72px;
      }

      .section-head {
        align-items: end;
      }

      .principles,
      .case-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .step {
        grid-template-columns:
          7rem minmax(0, 1fr) minmax(0, 1.4fr);
        align-items: start;
        gap: 12px 48px;
      }

      .step-number {
        grid-row: auto;
      }

      .step h3 {
        padding-top: 6px;
      }

      .contact-panel {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: center;
        gap: 64px;
      }
    }

    /* 13. Pointer feedback */
    @media (hover: hover) and (pointer: fine) {
      .primary-nav a:hover,
      .dialog-nav a:hover,
      .brand:hover {
        color: var(--accent);
      }

      .button:hover {
        border-color: var(--accent);
        background: var(--surface-soft);
      }

      .button:hover svg,
      .text-link:hover svg {
        transform: translateX(4px);
      }

      .button-primary:hover {
        border-color: var(--accent-soft);
        color: var(--bg);
        background: var(--accent-soft);
      }

      .text-link:hover {
        border-color: var(--accent);
        color: var(--accent);
      }

      .back-top:hover svg {
        transform: translateY(-3px);
      }
    }

    /* 14. Entrance motion
       正文保持正常透明度；只有装饰内层淡入。 */
    @media (prefers-reduced-motion: no-preference) {
      @keyframes rise {
        from { transform: translateY(14px); }
        to { transform: none; }
      }

      @keyframes settle {
        from {
          opacity: 0;
          transform: translateX(24px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }

      .hero .eyebrow {
        animation: rise .7s var(--ease) backwards;
      }

      .hero h1 {
        animation: rise .9s var(--ease) backwards;
      }

      .hero .lead {
        animation: rise 1.1s var(--ease) backwards;
      }

      .hero-actions {
        animation: rise 1.3s var(--ease) backwards;
      }

      .hero-art-inner {
        animation: settle 1.4s var(--ease) backwards;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      html {
        scroll-behavior: auto;
      }

      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
      }
    }

    @media (forced-colors: active) {
      .button,
      .cover,
      .contact-panel,
      .text-link {
        border-color: ButtonText;
      }

      :focus-visible {
        outline-color: Highlight;
      }
    }
  </style>
</head>

<body>
  <a class="skip-link" href="#main">跳到主要内容</a>

  <aside class="demo-note" aria-label="样稿说明">
    视觉方向样稿 · 页面文案为示例，品牌资料与联系渠道尚未接入
  </aside>

  <header class="site-header" id="site-header">
    <div class="wrap header-inner">
      <a
        class="brand"
        href="#main"
        aria-label="品牌名称，返回主要内容开头"
      >
        <span class="brand-name">品牌名称</span>
        <span class="brand-caption">Studio</span>
      </a>

      <nav class="primary-nav" id="primary-nav" aria-label="主导航">
        <a href="#approach">理念</a>
        <a href="#works">视觉探索</a>
        <a href="#method">方法</a>
        <a href="#contact">联系</a>
      </nav>

      <button
        class="button menu-toggle"
        id="menu-toggle"
        type="button"
        aria-haspopup="dialog"
        aria-controls="mobile-menu"
        aria-expanded="false"
        hidden
      >菜单</button>
    </div>
  </header>

  <main id="main" tabindex="-1">
    <section class="hero" aria-labelledby="hero-title">
      <div class="wrap hero-layout">
        <div class="hero-copy">
          <p class="eyebrow">品牌 · 空间 · 数字体验</p>
          <h1 id="hero-title">
            以克制与秩序，<br>
            构建<span>长久</span>的价值。
          </h1>

          <p class="lead">
            我们相信真正的高级感来自删减而非堆叠。
            每一个决定都应当有必要的理由，
            每一处留白都应当承担明确的职责。
          </p>

          <div class="hero-actions">
            <a class="button button-primary" href="#works">
              查看视觉探索
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M3 10h13M11 5l5 5-5 5"></path>
              </svg>
            </a>

            <a class="text-link" href="#approach">
              了解我们的理念
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M2 8h11M9 4l4 4-4 4"></path>
              </svg>
            </a>
          </div>
        </div>

        <div class="hero-art" aria-hidden="true">
          <div class="hero-art-inner">
            <div class="grid-lines"></div>
            <div class="glow"></div>
            <div class="ring"></div>
            <div class="ring ring-2"></div>
            <div class="bar"></div>
            <div class="dot"></div>
          </div>
        </div>

        <div class="hero-bottom">
          <span>策略 · 识别 · 空间 · 数字</span>
          <span>小规模团队，长周期合作</span>
          <span>深度参与每一个关键节点</span>
        </div>
      </div>
    </section>

    <section
      class="section intro"
      id="approach"
      tabindex="-1"
      aria-labelledby="approach-title"
    >
      <div class="wrap">
        <div class="intro-grid">
          <div>
            <p class="eyebrow">理念</p>
            <h2 id="approach-title">
              好的设计，<br>
              让价值被看见。
            </h2>
          </div>

          <div class="intro-copy">
            <p class="lead">
              我们从关系出发：品牌与人、空间与光、信息与注意力。
              每一个项目都从厘清问题开始，
              最终留下的，应当经得起时间。
            </p>
            <p class="lead">
              策略、空间、平面与交互彼此协同，
              让每一个局部决定回到整体，
              让每一种表达具有清楚的依据。
            </p>
          </div>
        </div>

        <ol class="principles">
          <li class="principle">
            <span class="principle-number" aria-hidden="true">01</span>
            <h3>层级先于装饰</h3>
            <p>
              先确定什么最重要，再安排形式。
              让标题、说明与操作各自承担清晰职责。
            </p>
          </li>

          <li class="principle">
            <span class="principle-number" aria-hidden="true">02</span>
            <h3>形式回应内容</h3>
            <p>
              根据内容选择构图与比例，
              保留主体，不为了统一表面而损失信息。
            </p>
          </li>

          <li class="principle">
            <span class="principle-number" aria-hidden="true">03</span>
            <h3>细节建立秩序</h3>
            <p>
              从一行文字到一个转折，
              以一致的尺度与节奏，让整体自然成立。
            </p>
          </li>
        </ol>
      </div>
    </section>

    <section
      class="section"
      id="works"
      tabindex="-1"
      aria-labelledby="works-title"
    >
      <div class="wrap">
        <div class="section-head">
          <div>
            <p class="eyebrow">视觉探索</p>
            <h2 id="works-title">在抽象中寻找秩序。</h2>
          </div>

          <p class="lead">
            三组概念画面，探索线、面与光在深色基底上的关系。
            它们是视觉语法练习，不代表商业项目。
          </p>
        </div>

        <div class="case-grid">
          <article class="case-card" aria-labelledby="work-1">
            <div
              class="cover cover-a"
              role="img"
              aria-label="深色渐变背景上，一条水平细线与从下方展开的浅金弧线"
            >
              <span class="cover-index" aria-hidden="true">I</span>
            </div>

            <div class="case-content">
              <p class="case-kicker">概念 · 弧与线</p>
              <h3 id="work-1">地平线之上</h3>
              <p class="case-description">
                大尺度的弧线暗示空间边界，
                一条水平线确立视线高度。
              </p>

              <dl class="case-meta">
                <dt>主题</dt>
                <dd>空间与光</dd>
                <dt>元素</dt>
                <dd>弧线、水平线、渐变面</dd>
                <dt>表达</dt>
                <dd>舒展与延伸</dd>
              </dl>
            </div>
          </article>

          <article class="case-card" aria-labelledby="work-2">
            <div
              class="cover cover-b"
              role="img"
              aria-label="深色背景上，一块斜向的暖金渐变面与一条竖直细线"
            >
              <span class="cover-index" aria-hidden="true">II</span>
            </div>

            <div class="case-content">
              <p class="case-kicker">概念 · 面与轴</p>
              <h3 id="work-2">斜切的光</h3>
              <p class="case-description">
                倾斜的暖色面向上展开，
                一条竖线让动态回到稳定的轴心。
              </p>

              <dl class="case-meta">
                <dt>主题</dt>
                <dd>动态与稳定</dd>
                <dt>元素</dt>
                <dd>斜面、竖线、暖色渐变</dd>
                <dt>表达</dt>
                <dd>方向与平衡</dd>
              </dl>
            </div>
          </article>

          <article class="case-card" aria-labelledby="work-3">
            <div
              class="cover cover-c"
              role="img"
              aria-label="深色背景上，两个同心矩形框，内框为浅金色并带微弱暖光"
            >
              <span class="cover-index" aria-hidden="true">III</span>
            </div>

            <div class="case-content">
              <p class="case-kicker">概念 · 框与心</p>
              <h3 id="work-3">双重边界</h3>
              <p class="case-description">
                两层边框引导视线向内，
                在边界之间留下安静的中心。
              </p>

              <dl class="case-meta">
                <dt>主题</dt>
                <dd>聚焦与克制</dd>
                <dt>元素</dt>
                <dd>同心矩形、细线、微光</dd>
                <dt>表达</dt>
                <dd>边界与核心</dd>
              </dl>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section
      class="section method"
      id="method"
      tabindex="-1"
      aria-labelledby="method-title"
    >
      <div class="wrap">
        <div class="section-head">
          <div>
            <p class="eyebrow">方法</p>
            <h2 id="method-title">三个阶段，一种节奏。</h2>
          </div>

          <p class="lead">
            以明确的问题开始，以可评判的成果推进。
            每一轮讨论，都落实为具体的调整。
          </p>
        </div>

        <ol class="steps">
          <li class="step">
            <span class="step-number" aria-hidden="true">01</span>
            <h3>理解</h3>
            <p>
              通过访谈、观察与资料梳理，
              明确品牌、受众和核心需求，再决定表达方式。
            </p>
          </li>

          <li class="step">
            <span class="step-number" aria-hidden="true">02</span>
            <h3>定义</h3>
            <p>
              确立信息架构、视觉系统与关键页面，
              用一个完整页面检验方向和尺度。
            </p>
          </li>

          <li class="step">
            <span class="step-number" aria-hidden="true">03</span>
            <h3>精修</h3>
            <p>
              逐项调整字体、间距、图片裁切与操作反馈，
              在真实设备上验证阅读和使用。
            </p>
          </li>
        </ol>
      </div>
    </section>

    <section
      class="section contact"
      id="contact"
      tabindex="-1"
      aria-labelledby="contact-title"
    >
      <div class="wrap">
        <div class="contact-panel">
          <div>
            <p class="eyebrow">联系</p>
            <h2 id="contact-title">让我们从一次对话开始。</h2>
          </div>

          <div class="contact-copy">
            <p>
              从目标、现状与期待出发，
              一起找到值得认真展开的问题。
            </p>
            <p>正式联系渠道将在品牌资料确认后接入此处。</p>

            <a class="text-link back-top" href="#main">
              回到主要内容开头
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M8 14V3M4 7l4-4 4 4"></path>
              </svg>
            </a>
          </div>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="wrap">品牌名称 · 视觉方向 A 样稿</div>
  </footer>

  <dialog
    class="menu-dialog"
    id="mobile-menu"
    aria-labelledby="mobile-menu-title"
  >
    <div class="menu-shell">
      <div class="menu-top">
        <h2 class="menu-title" id="mobile-menu-title">导航</h2>
        <button
          class="button"
          id="menu-close"
          type="button"
          autofocus
        >关闭菜单</button>
      </div>

      <nav class="dialog-nav" aria-label="移动端主导航">
        <a href="#approach">
          <small aria-hidden="true">01</small>理念
        </a>
        <a href="#works">
          <small aria-hidden="true">02</small>视觉探索
        </a>
        <a href="#method">
          <small aria-hidden="true">03</small>方法
        </a>
        <a href="#contact">
          <small aria-hidden="true">04</small>联系
        </a>
      </nav>

      <p class="menu-caption">品牌名称 · Studio</p>
    </div>
  </dialog>

  <script>
    (() => {
      "use strict";

      const root = document.documentElement;
      const header = document.getElementById("site-header");

      const updateAnchorOffset = () => {
        const height = Math.ceil(header.getBoundingClientRect().height);
        root.style.setProperty("--anchor-offset", `${height + 24}px`);
      };

      updateAnchorOffset();

      if ("ResizeObserver" in window) {
        const observer = new ResizeObserver(updateAnchorOffset);
        observer.observe(header);
      } else {
        window.addEventListener("resize", updateAnchorOffset, {
          passive: true
        });
      }

      const dialog = document.getElementById("mobile-menu");
      const toggle = document.getElementById("menu-toggle");
      const closeButton = document.getElementById("menu-close");
      const primaryNav = document.getElementById("primary-nav");
      const desktop = window.matchMedia("(min-width: 860px)");

      const dialogSupported =
        typeof window.HTMLDialogElement !== "undefined" &&
        typeof dialog.showModal === "function";

      // 关闭态由 CSS 显式隐藏；普通导航无需脚本即可使用。
      if (!dialogSupported) return;

      const syncClosedState = () => {
        // close 事件可能稍后送达，避免覆盖已重新打开的状态。
        if (dialog.open) return;
        toggle.setAttribute("aria-expanded", "false");
        document.body.classList.remove("menu-open");
      };

      const closeMenu = () => {
        if (dialog.open) dialog.close();
        syncClosedState();
      };

      const openMenu = () => {
        if (desktop.matches || dialog.open) return;

        try {
          dialog.showModal();
          toggle.setAttribute("aria-expanded", "true");
          document.body.classList.add("menu-open");
          closeButton.focus();
        } catch {
          closeMenu();
          root.classList.remove("menu-ready");
          toggle.hidden = true;
          updateAnchorOffset();
          primaryNav.querySelector("a").focus();
        }
      };

      toggle.addEventListener("click", openMenu);
      closeButton.addEventListener("click", closeMenu);
      dialog.addEventListener("close", syncClosedState);

      // Escape 使用原生 dialog 的默认关闭行为。
      // 关闭按钮与 Escape 的焦点恢复交由原生机制处理。
      dialog.querySelectorAll('a[href^="#"]').forEach(link => {
        link.addEventListener("click", event => {
          // 保留组合键或非主按钮点击的原生行为。
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }

          const target = document.getElementById(link.hash.slice(1));
          closeMenu();

          // 不阻止默认锚点导航，不自行改写历史记录。
          if (target) target.focus({ preventScroll: true });
        });
      });

      const onBreakpointChange = event => {
        if (!event.matches) return;

        const activeElement = document.activeElement;
        const needsVisibleFocus =
          dialog.open || activeElement === toggle;

        closeMenu();
        updateAnchorOffset();

        // 桌面下触发按钮隐藏，焦点移至可见导航。
        if (needsVisibleFocus) {
          primaryNav.querySelector("a").focus({ preventScroll: true });
        }
      };

      if (typeof desktop.addEventListener === "function") {
        desktop.addEventListener("change", onBreakpointChange);
      } else {
        desktop.addListener(onBreakpointChange);
      }

      window.addEventListener("pagehide", closeMenu);

      window.addEventListener("pageshow", () => {
        syncClosedState();
        updateAnchorOffset();
      });

      // 完成能力检查与事件绑定后，再启用增强菜单。
      toggle.hidden = false;
      root.classList.add("menu-ready");
      updateAnchorOffset();
    })();
  </script>
</body>
</html>
```

## 四、本轮修正与取舍

### 1. 首屏高度只计算一次

移除内层 `min-height:inherit`，仅 `.hero` 设置最小高度，内层通过 `flex:1` 使用剩余空间。

底部信息放在网格末行；文字增多时页面自然增高。正文不设置 `overflow:hidden`，裁切只应用于装饰区域。

### 2. 正文动画不降低透明度

标题、说明和操作只做 14px 位移，不淡入，不设置延迟。减少动态效果偏好下取消动画。

装饰层可淡入，正文阅读不依赖其动画是否结束。

### 3. 动画与静态透明度分层

`.hero-art` 控制裁切和最终透明度，`.hero-art-inner` 承担位移与淡入。

窄屏外层透明度为 `.55`，桌面为 `1`。动画内层最终回到正常样式，两种动态效果设置下的最终透明度一致。

### 4. 菜单降级不依赖原生隐藏规则

增加：

```css
.menu-dialog:not([open]) {
  display: none;
}
```

脚本未运行或不支持原生模态对话框时，关闭的菜单不会覆盖页面，其内部链接也不会进入正常 Tab 顺序。

普通导航保持显示；仅在能力检查和事件绑定完成后切换为菜单按钮。

### 5. 首屏采用实际列布局

桌面文字和构图共享同一网格，比例为 `7:5`，装饰不会伸入文字列。

没有采用“文字两列网格、装饰另按 `left:56%` 定位”的组合，因为后者不能准确对应容器侧边距、列间距与实际列宽。

移动端构图放在文字下方，保留较低透明度，避免线条穿过正文。标题缩短，上限为 72px；桌面两行为设计目标，移动端和文字放大时允许更多行。

### 6. 案例标签统一列宽

`dt`、`dd` 直接作为 `<dl>` 子元素，共享 `4.5em + 剩余宽度` 两列。移除禁止换行规则；400px 以下改为上下排列。

另外，将第三幅画面的描述从“同心方框”改为“同心矩形框”，与 4:5 容器内按百分比缩进形成的实际图形一致。

### 7. 文档与页面对齐

品牌副标调整至 13px；正文说明不再宣称“首帧即可读”或“长标签不挤压内容”。

页面保留顶部提示及联系区渠道说明，页脚删除“主体信息待接入”。没有新增模块、表单或滚动显现。

## 五、正式内容接入清单

| 位置 | 正式使用前处理 |
|---|---|
| 演示提示 | 完成内容核实后删除 |
| 品牌名称与 Studio 副标 | 替换为实际品牌识别 |
| 首屏标题、简介与服务类别 | 根据实际业务重写 |
| 首屏合作方式短句 | 核实后使用，否则删除或替换 |
| 理念与方法 | 根据品牌实际理念和流程重写 |
| 视觉探索区 | 判断是否保留为概念内容，或替换为真实项目 |
| 项目图片 | 提供真实资源、准确尺寸、响应式版本及替代文本 |
| 案例详情入口 | 有真实详情地址后再加入，保留有效 HTML 结构 |
| 联系区域 | 接入真实邮箱、电话或可用表单 |
| 页脚 | 接入真实版权、主体信息及适用的备案信息 |
| 标题字体 | 根据访问环境决定外部加载、自托管或分包 |
| `noindex` | 根据正式部署与索引策略调整 |

真实作品接入后，应逐张检查比例、完整展示或裁切方式。本样稿统一 4:5，不构成真实图片必须采用该比例的要求。

## 六、验证状态

本轮仅完成文字层面的静态修改，未运行页面。

| 项目 | 当前状态 |
|---|---|
| 完整 HTML、CSS、菜单脚本 | 已提供 |
| 首屏重复高度与正文裁切 | 已修正代码，待实际布局验证 |
| 正文动画透明度 | 已移除透明度变化 |
| 移动端装饰终态 | 已分层处理，待视觉验证 |
| 不支持 dialog、禁用脚本时的导航 | 已提供显式回退，待验证 |
| 菜单打开、关闭、Escape、背景隔离 | 待浏览器与辅助技术验证 |
| 关闭后焦点恢复、导航目标聚焦 | 待验证 |
| 菜单打开或按钮聚焦时切换桌面宽度 | 待验证 |
| 360 / 768 / 1024 / 1440 / 1920px 布局 | 待视觉验证 |
| 矮窗口、横屏、200% 文字放大 | 待验证 |
| 标题字体加载前后换行与布局变化 | 待验证 |
| 外部字体失败及 Windows 回退 | 待验证 |
| 长标签、长英文词和案例列对齐 | 待验证 |
| 颜色、焦点轮廓和控件边框对比度 | 待计算及实测 |
| Safari 锚点、平滑滚动与目标聚焦 | 待实测 |
| 直接访问 hash、前进后退 | 待实测 |
| 减少动态效果、强制颜色模式 | 已提供样式，待验证 |
| 字体请求与首屏性能 | 未测量 |
| 对原网站的理解与实际修改 | 尚未开展，缺少资料 |

## 七、后续完善顺序

1. 根据真实网站与业务资料，确定方向 A 是否适合。
2. 用真实内容完成首屏及一个案例，确认字体、构图和主要操作。
3. 验证响应式、字体加载、菜单、焦点和锚点行为，修正具体问题。
4. 将确认后的规则应用到其余页面，最后评估额外动效。