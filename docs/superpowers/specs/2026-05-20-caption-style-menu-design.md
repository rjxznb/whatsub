# Caption Style Menu Redesign

Date: 2026-05-20
Scope: `client/` (Tauri desktop app)
Touches: `src/types/settings.ts`, `src/store/settings.ts`, `src/components/VideoPlayer.tsx`, `src/components/CaptionOverlay.tsx`, `src/pages/Player.tsx`

## Motivation

播放器底部齿轮按钮（`VideoPlayer.tsx:446-479`）当前只能调播放速度。字幕背景在某些亮场景里会遮挡画面，用户想要 YouTube 风格的字幕样式控制（字体颜色、字号、背景色、背景不透明度、字体不透明度），并希望和速度合并在同一个齿轮菜单下。

## Non-goals

- 字体家族选择
- 文字描边/阴影
- 自定义颜色取色器
- 字幕位置拖动（已在讨论中放弃）
- 同步修改右侧 `SubtitleList` 的样式 —— 本设计只影响视频上方的 `CaptionOverlay`，右侧学习面板保持不变

## Data model

`src/types/settings.ts` 新增 6 个字段，全部可选（兼容老 settings.json）：

```ts
interface Settings {
  // ... existing ...

  /** 字幕字体颜色 hex（不含 alpha）。默认 "#FFFFFF" */
  captionFontColor?: string;
  /** 字幕字号档位：0.75 / 1 / 1.25 / 1.5。默认 1 */
  captionFontScale?: number;
  /** 是否显示重点短语高亮。默认 true */
  captionHighlightsEnabled?: boolean;
  /** 字幕背景颜色 hex（不含 alpha）。默认 "#000000" */
  captionBackgroundColor?: string;
  /** 字幕背景不透明度 0–1。默认 0.7 */
  captionBackgroundOpacity?: number;
  /** 字幕文字不透明度 0–1。默认 1 */
  captionFontOpacity?: number;
}
```

`DEFAULT_SETTINGS` 加上对应默认值。`store/settings.ts::mergeWithDefaults` 当前已有逐字段覆盖逻辑（顶层 `{...DEFAULT_SETTINGS, ...raw}`），新字段自动被覆盖，老 settings.json 缺这些字段时落回默认。

## UI: 三视图菜单

复用现有齿轮按钮 (`Settings` icon @ `VideoPlayer.tsx:447-454`)。把单层 popover 改成三视图：

```
view = "root"                  view = "speed"                    view = "captions"

┌──────────────────┐           ┌──────────────────┐              ┌────────────────────────┐
│ 播放速度  1x  ▸  │           │ ◂ 播放速度        │              │ ◂ 字幕设置              │
│ 字幕设置     ▸  │           │  0.5x            │              │                          │
└──────────────────┘           │  0.75x           │              │  字体颜色                │
                                │  1x         ✓    │              │  ⬤⬤⬤⬤⬤⬤⬤⬤              │
                                │  1.25x           │              │                          │
                                │  1.5x            │              │  字号                    │
                                │  2x              │              │  [小][中][大][特大]      │
                                └──────────────────┘              │                          │
                                                                   │  字体不透明度    100%    │
                                                                   │  [══════════●]           │
                                                                   │                          │
                                                                   │  重点高亮     [开/关]    │
                                                                   │  ─────────────────────   │
                                                                   │                          │
                                                                   │  背景颜色                │
                                                                   │  ⬤⬤⬤⬤⬤⬤⬤⬤              │
                                                                   │                          │
                                                                   │  背景不透明度    70%     │
                                                                   │  [═══════●─────]         │
                                                                   │                          │
                                                                   │  [    重置字幕设置    ]    │
                                                                   └────────────────────────┘
```

**视图状态**：`menuView: "root" | "speed" | "captions"`，替换现有 `showSpeed: boolean`。

**容器样式**：`absolute bottom-full right-0 mb-2 rounded-xl border border-white/10 bg-black/80 backdrop-blur-md shadow-lg z-10 w-[280px] max-h-[70vh] overflow-y-auto`。

**导航**：root 行点击 → 设置对应 view；submenu 顶部 `◂` 行点击 → 回 root。

**关闭**：
- 点菜单外任意位置 → 关菜单，view reset 到 root
- 选中速度档位 → 关菜单（保留现有 UX）
- 字幕子菜单内的改动不关菜单 —— 用户要连续调多个值

实现方式：菜单打开时在全屏渲染一层 `fixed inset-0 z-[5]` 透明捕获层 onClick 关菜单；菜单本身 `z-10` 高于它，stopPropagation 阻止冒泡。

## 字幕子菜单各控件

### 字体颜色 / 背景颜色

8 个 24×24 圆形色块横向排列：

```
白 #FFFFFF    黄 #FFEB3B    青 #00BCD4    绿 #4CAF50
蓝 #2196F3    品红 #E91E63   红 #F44336    黑 #000000
```

当前选中色块加 `ring-2 ring-white`。点击 → 立即写入对应字段并 `save()`。两个色板独立。

### 字号

4 个离散按钮 `[小 75%] [中 100%] [大 125%] [特大 150%]`，映射 `captionFontScale = 0.75 / 1 / 1.25 / 1.5`。当前档位高亮（`bg-white/20`）。点击 → 写入 + save。

### 重点高亮开关

一行带 toggle switch，开/关状态 → `captionHighlightsEnabled = true/false`。关闭时：

- `CaptionOverlay.renderEnglish` 跳过 `renderWithSpans`，直接返回 `s.text`
- `CaptionOverlay.renderTranslation` 跳过，直接返回 `s.translation`
- 右侧 `SubtitleList` 不受影响 —— 那里是学习面板，高亮是核心功能

### 背景不透明度 / 字体不透明度

两个 0–100% range slider，右侧实时显示百分比（`%-format`）。

落盘策略：拖动过程中（`onChange`）调用 `onChangeCaptionStyle({ captionBackgroundOpacity: v })` —— store 通过 `save()` 异步写盘，但 UI 立即基于新 store 值重渲染。每次 onChange 触发一次磁盘写入（settings.json 体量小、`invoke("save_settings")` ms 级），不需要节流；如未来发现性能问题再加 debounce。

### 重置按钮

底部一个全宽按钮 `重置字幕设置`，点击 → 把上述 6 个字段（5 个样式 + 1 个高亮开关）一次性写回 DEFAULT_SETTINGS 对应值并 `save()`。重置不关菜单，用户能立刻看效果。

## CaptionOverlay 渲染改造

`CaptionOverlay.tsx` 当前的硬编码：

```tsx
<div className="max-w-[90%] rounded-md bg-black/70 px-4 py-2 text-center backdrop-blur-sm shadow-lg">
  <div className="text-white text-xl leading-snug font-medium">...</div>
  <div className="text-zinc-200 text-base leading-snug mt-1">...</div>
</div>
```

改为通过 props + inline style 驱动：

```tsx
interface Props {
  subtitle: Subtitle | null;
  style: CaptionStyle;  // 从 settings store 派生
}

interface CaptionStyle {
  fontColor: string;        // hex
  fontScale: number;        // 0.75 / 1 / 1.25 / 1.5
  fontOpacity: number;      // 0..1
  bgColor: string;          // hex
  bgOpacity: number;        // 0..1
  highlightsEnabled: boolean;
}

const bgAlpha = Math.round(style.bgOpacity * 255).toString(16).padStart(2, "0");
const bgStyle = { backgroundColor: `${style.bgColor}${bgAlpha}` };
const textStyle = { color: style.fontColor, opacity: style.fontOpacity };
const englishStyle = { ...textStyle, fontSize: `${1.25 * style.fontScale}rem` };  // 当前 text-xl = 1.25rem
const chineseStyle = { ...textStyle, fontSize: `${1 * style.fontScale}rem` };     // 当前 text-base = 1rem
```

- 字幕背景 alpha：把 0–1 opacity 转成两位 hex 拼到色后面（e.g. `#000000B3` for 70%）
- 移除 `bg-black/70` 类名，保留 `backdrop-blur-sm`（背景模糊辅助低 opacity 时的可读性，跟 user 的颜色无关）
- 移除 `text-white` / `text-zinc-200`，用 inline style 覆盖
- 字号基线：英文 `text-xl` (1.25rem) × scale；中文 `text-base` (1rem) × scale —— 比例保留
- 高亮 spans 当 `highlightsEnabled === false` 时整段不渲染 span 包装，回退到纯文本

## Player.tsx 接线

```tsx
const { settings, save } = useSettings();

const captionStyle: CaptionStyle = {
  fontColor: settings.captionFontColor ?? "#FFFFFF",
  fontScale: settings.captionFontScale ?? 1,
  fontOpacity: settings.captionFontOpacity ?? 1,
  bgColor: settings.captionBackgroundColor ?? "#000000",
  bgOpacity: settings.captionBackgroundOpacity ?? 0.7,
  highlightsEnabled: settings.captionHighlightsEnabled ?? true,
};

const onChangeCaptionStyle = useCallback((patch: Partial<Settings>) => {
  save({ ...settings, ...patch });
}, [settings, save]);

<VideoPlayer
  // ... existing props
  captionStyle={captionStyle}
  onChangeCaptionStyle={onChangeCaptionStyle}
/>
```

`VideoPlayer` 用 `captionStyle` 双重：

1. 透传给 `CaptionOverlay` 驱动渲染
2. 驱动菜单本身的「当前选中态」UI —— 哪个色块加 `ring-2`、哪个字号按钮高亮、slider 的当前值、toggle 的开关位

菜单内的色块/slider/按钮调用 `onChangeCaptionStyle({ captionFontColor: "#FFEB3B" })` 这种局部更新；重置按钮调用 `onChangeCaptionStyle({ captionFontColor: "#FFFFFF", captionFontScale: 1, ... })` 一次性 patch 全 6 字段。

`menuView` 状态（root / speed / captions）是 `VideoPlayer` 内部 `useState`，替换现有的 `showSpeed: boolean`。不进 settings —— 菜单每次重开都从 root 开始。

## 高亮锁定决定

字幕中的重点短语（黄底 `bg-amber-300 text-black`）是 whatsub 的核心学习视觉。当用户改 `captionFontColor` 时：

- 高亮 span 仍渲染原 `bg-amber-300 text-black px-0.5 rounded font-semibold` 类
- 翻译高亮仍渲染 `bg-amber-300/30 text-amber-100`
- 用户的 `fontColor` 只作用于**非高亮文本**

这是有意决定 —— 若高亮跟随用户色，用户调成相近色（比如黄字配黄高亮）会让高亮完全消失。提供 `captionHighlightsEnabled` 开关给确实不想要高亮的用户作为逃生口。

## 边界

- `captionBackgroundOpacity = 0` + `captionFontOpacity = 0`：理论上字幕完全不可见。不阻止，用户的选择。
- 老用户 settings.json 没有这 6 个字段：`mergeWithDefaults` 兜底返回默认值，CaptionOverlay 视觉完全等同于改动前。
- 重置按钮把字段写回默认（而非 `delete` 字段）——保持 settings.json 的字段一致。
- 字号 `特大 150%` 在小窗模式下可能撑得超过容器：`CaptionOverlay` 外层已有 `max-w-[90%]`，文字自动换行。

## Testing

新增/调整 vitest case（`CaptionOverlay.render.test.tsx` 若不存在则新建；当前已有 `SubtitleList.render.test.tsx` 同模式）：

- bg color + opacity 渲染成 `style.backgroundColor` 含 alpha 的 8 位 hex
- `highlightsEnabled = false` 时输出不含 `<span class="bg-amber-300">`
- `fontScale = 1.5` 时英文行 inline `fontSize === "1.875rem"`（1.25 × 1.5）
- 老 settings.json（缺新字段）→ 渲染产物与基线快照一致

人工 UI 测试清单（dev mode 跑）：
- [ ] 齿轮按钮打开菜单，root 显示「播放速度」「字幕设置」两行
- [ ] 进入速度子菜单，选中档位 → 菜单关闭，下次打开再次显示 root
- [ ] 进入字幕子菜单，调整每个控件 → CaptionOverlay 实时变化
- [ ] 关闭重点高亮 → CaptionOverlay 不再有黄底高亮，SubtitleList 不变
- [ ] 重置按钮 → 6 字段全部回默认，菜单保留打开
- [ ] 点菜单外 → 菜单关闭并 reset 到 root
- [ ] 退出 app 重启 → 设置保留
- [ ] settings.json 手动删掉新字段重启 → 字幕显示和改动前完全一致

## Out of scope (后续可加)

- 字幕预览：菜单内显示一行模拟字幕预览当前样式
- 字幕位置拖动
- 字体家族
- 文字描边/阴影
- 同步修改右侧 SubtitleList 样式
