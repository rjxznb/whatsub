# 任意单词 / 短语收藏到词汇本 — 设计

## 目标

视频播放页右栏字幕里，用户当前只能通过「重点短语」tab 收藏 LLM 预先标注好的短语。让用户能从字幕原文里**任意拖蓝**一个单词或短语，可选地调用 LLM 拿到中文释义和用法，然后收藏到词汇本。

## 用户流程

```
[字幕里拖蓝 "apparently"]
        │
        ▼
判断 expression 是否已在 vocab
        │
        ├── 未收藏（第一次见）
        │      └─→ 气泡淡入折叠态: apparently  [🔍 查词] [⭐]
        │           ├─ 点 ⭐（直接收藏，inputs 都为空）
        │           │     └─→ vocab 写入（meaningZh="", usage="", cueText=cue原文）
        │           │          气泡消失，清掉草稿（如有）
        │           │
        │           ├─ 点 🔍 查词
        │           │     ├─→ 气泡向下展开 inputs 区，显示 loading
        │           │     ├─→ LLM 返回 → 填入 meaningZh / usage 输入框
        │           │     ├─→ 用户可直接编辑输入框（草稿态：改动不自动入库）
        │           │     ├─→ 用户再次点 🔍：
        │           │     │     ├─ 输入框都为空 → 直接覆盖填入
        │           │     │     └─ 输入框非空   → 弹「AI 建议」浮卡：
        │           │     │                       [替换]  ← hover 时输入框预览替换后内容
        │           │     │                       [追加]  ← hover 时输入框预览追加后内容
        │           │     │                       松开 hover 恢复用户原值；点击才真正写入
        │           │     └─→ 点 ⭐ 收藏（带当前 inputs 值）→ 清草稿
        │           │
        │           └─ 点击气泡和选区之外
        │                ├─ 输入框被改动过 → 写草稿到 localStorage
        │                └─ 气泡淡出消失
        │
        └── 已收藏（第二次见）
               └─→ 气泡淡入并立即展开 inputs，预填 vocab 里的现存值，⭐ 实心
                    ├─ 编辑输入框 → debounce 500ms → 自动 upsert 写回 vocab，⭐ 保持实心
                    ├─ 点 🔍 重新查 → 复用「AI 建议」浮卡 / 替换 / 追加（同未收藏路径）
                    │      改动后同样 debounce upsert
                    ├─ 点 ⭐ 实心 → cancel 掉 debounce → vocab_remove → ⭐ 变空心
                    │      （此时还在气泡展开态，inputs 仍显示，可继续编辑；
                    │       继续编辑则进入「未收藏 + 草稿」流程，需再点 ⭐ 重新入库）
                    └─ 点击气泡和选区之外 → 直接关闭（最后一次 debounce 已落盘，
                                              没有「未保存」概念，所以不写草稿）
```

**重选已收藏的词**：气泡淡入后**立即展开 inputs**，预填该词在 vocab 里现存的 `meaningZh / usage`，⭐ 实心。用户可以直接编辑输入框，**改动 debounce 500ms 后自动 upsert 写回 vocab**（⭐ 保持实心，无须再点）。点 ⭐ 实心 → 取消收藏（同时 cancel 掉未触发的 debounce，避免覆写出条目）。

**重选未收藏但有草稿的词**：气泡淡入后立即展开 inputs，预填草稿。inputs 改动**不**自动写 vocab（草稿态），需点 ⭐ 才入库。

## 组件清单

### 新建

- `src/components/SubtitleSelectionBubble.tsx` — 气泡组件
- `src/llm/lookupExpression.ts` — 单次查词的 LLM 调用封装
- `src/store/vocabDraft.ts` — localStorage 草稿读写（极薄 wrapper，不需要 zustand store，纯函数 `loadDraft / saveDraft / clearDraft`）

### 改动

- `src/components/SubtitleList.tsx` —
  - 渲染时套上 `SubtitleSelectionBubble`，传入 listRef 和 videoId/videoTitle
  - `renderEnglishWithHighlights` 增加「已收藏的词加虚线下划线」一层
  - 监听 selection 变化（mouseup + selectionchange），把当前选区信息传给气泡组件
- `src/llm/prompts.ts` — 新增 `buildLookupPrompt(expression, cueText)`
- `src/components/HighlightWord.tsx` — **不动**（黄色 keyNote 高亮独立于本功能）
- `src/pages/Vocab.tsx` — **不动**（编辑能力本期不做）

### 不动

- Rust 端任何文件 — `vocab_*` 命令已经够用
- `src/store/vocab.ts` — `add` 已经是 upsert by id，能直接覆盖更新
- `src/types/vocab.ts` — 类型不变

## 气泡定位与生命周期

### 显示判定

`SubtitleList` 容器上监听 `mouseup` 事件，读取 `window.getSelection()`：

```
显示气泡  ⇔  selection 非折叠
          ∧ selection.toString().trim() 去掉首尾标点后非空
          ∧ anchorNode 和 focusNode 都落在同一个 [data-idx] 元素内
          ∧ editing prop === false
```

跨 cue 选区、空选区、编辑模式下：直接不显示（不报错，静默忽略）。

### 表达式标准化

```
expression = selectionText
    .trim()
    .replace(/^[\s,.!?;:"'(){}[\]]+/, "")
    .replace(/[\s,.!?;:"'(){}[\]]+$/, "")
```

去前后空白和标点，但保留中间所有字符（含连字符、撇号）。

### cue 归属

从 `selection.anchorNode` 向上找最近的 `[data-idx]` ancestor，读 `data-idx`，索引到 `subtitles[idx]`，取 `time` 作 `cueTime`、整段 `text` 作 `cueText`。

### 位置计算

```ts
const rect = selection.getRangeAt(0).getBoundingClientRect();
const bubbleTop = rect.top - bubbleHeight - 8;  // 选区上方 8px
// 若 bubbleTop < 0（选区贴顶部窗口），翻到下方：rect.bottom + 8
const bubbleLeft = clamp(rect.left + rect.width/2 - bubbleWidth/2, 8, viewportWidth - bubbleWidth - 8);
```

气泡用 `position: fixed`（不受字幕容器滚动影响）；selection 改变时通过 ResizeObserver / 监听 `selectionchange` 重算位置；展开 inputs 后高度变化触发位置重算。

### 动画

- 入场：`opacity-0 translate-y-1 scale-95` → `opacity-100 translate-y-0 scale-100`，`transition-all duration-150 ease-out`
- 退场：反向，`duration-100 ease-in`
- 输入区展开/收起：`max-height` + `opacity` 双轨过渡，`duration-200 ease-out`
- AI 建议浮卡：`opacity` + 微 translate，`duration-150`

实现：纯 React `useState` + Tailwind transition class，不引入 framer-motion。

### 关闭触发

- document 级 `mousedown` 监听，target 不在气泡 DOM 树内 → 关闭
- 选区变成 collapsed 或空 → 关闭
- 气泡内点 ⭐ 完成保存 → 关闭
- ESC 键 → 关闭

每种关闭路径都走同一个 `closeBubble(reason)` 函数：先判断要不要存草稿，再触发淡出动画。

## 气泡 UI 状态

### 状态枚举

```ts
type BubbleState =
  | "collapsed"        // 横条，未收藏 + 还没点 🔍 + 没草稿
  | "lookup-loading"   // 点了 🔍，等 LLM 返回
  | "expanded"         // inputs 区展开（已收藏预填 / 草稿恢复 / LLM 结果 / 用户手输）
  | "lookup-error"     // LLM 失败，inputs 区显示 retry
  | "ai-suggestion";   // 用户已写过、再次点 🔍，显示替换/追加浮卡

// 派生：是否已在 vocab 里 → 决定 ⭐ 填充状态、inputs 编辑是否触发 debounce upsert
const saved = useVocabulary().has(expression);
```

### 折叠态布局

```
┌────────────────────────────────────────┐
│  apparently        🔍 查词    ⭐       │
└────────────────────────────────────────┘
```

宽度按 expression 文本自适应，最小 240px、最大 480px。

**只在以下情况是折叠态**：未收藏 + 没草稿 + 用户没主动点过 🔍。已收藏的词重选时直接进入展开态（预填 vocab 现存值）。

### 展开态布局

```
┌────────────────────────────────────────┐
│  apparently        🔍 重新查    ⭐    │
├────────────────────────────────────────┤
│ 📖 中文释义                             │
│ ┌────────────────────────────────────┐ │
│ │ 显然；看起来                        │ │
│ └────────────────────────────────────┘ │
│ 💬 用法                                 │
│ ┌────────────────────────────────────┐ │
│ │ 口语里表达"听上去像那么回事"        │ │
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

输入框是 textarea（2 行起、可拉伸）。

**展开态来源**：(1) 用户点 🔍 查词后展开；(2) 重选有草稿的未收藏词；(3) 重选已收藏的词。

**编辑→自动保存（仅已收藏态）**：当前 expression 已在 vocab 时，inputs 的 onChange 会触发 500ms debounce，最后一次改动后调用 `vocab_add(updatedEntry)` 直接 upsert（保持原 `addedAt`，更新 `meaningZh / usage`，其他字段不动）。组件用 `useRef` 持有 timer 句柄；点 ⭐ 取消收藏 / 关闭气泡 / 切换 expression 时都要 cancel。

### AI 建议态（用户已写过、再点 🔍）

输入区下方浮一张半透明浮卡：

```
┌────────────────────────────────────────┐
│ 📖 中文释义                             │
│ [用户已写的内容]                       │
│ 💬 用法                                 │
│ [用户已写的内容]                       │
├ AI 建议 ──────────────────────────────┤
│ 📖 LLM 给的：明显地；显而易见          │
│ 💬 LLM 给的：常用于不太确定的语气...   │
│                                        │
│         [替换]      [追加]             │
└────────────────────────────────────────┘
```

**Hover 预览**：

- hover 在「替换」按钮上 → 输入框临时变成 LLM 给的内容（淡灰边框 + 半透明背景表示「预览」）
- hover 在「追加」按钮上 → 输入框临时变成 `用户内容\n\nLLM 内容`
- 鼠标移开按钮 → 输入框立刻恢复用户原值
- 点击才真正写入并清掉建议浮卡

实现：组件持有 `userText` state；展示用 `previewText`，hover 时 set，move 时 unset。点击按钮时 `setUserText(previewText)` + 清浮卡。

## 草稿机制

### 存储

`localStorage` key：`whatsub:vocab-draft:${makeVocabId(expression)}`
value（JSON 序列化）：

```ts
interface VocabDraft {
  expression: string;       // 原文（保留大小写）
  meaningZh: string;
  usage: string;
  cueText: string;          // 写草稿时的 cue 上下文
  cueTime: number;
  videoId: string;          // 写草稿时所在视频
  videoTitle: string;
  updatedAt: string;        // ISO
}
```

### 何时写草稿

气泡关闭时（任何关闭路径），同时满足：

- 用户改动过 inputs 区（`meaningZh` 或 `usage` 至少一个非空，或与最初的 LLM 结果不同）
- 当前 expression **未在** vocab（已在则不存草稿，因为 vocab 才是 source of truth）

### 何时清草稿

- 用户在气泡里点 ⭐ 成功收藏 → 清掉对应 key
- 用户在气泡里点 ⭐ 取消收藏 → **不清**草稿（草稿可能记录了用户对该词的笔记，下次再选还能用）

### 何时读草稿

打开气泡时：
- vocab 已存 → 忽略草稿，气泡**展开 inputs，预填 vocab 现存值**，⭐ 实心
- vocab 未存 + 有草稿 → 气泡展开 inputs，预填草稿值
- vocab 未存 + 无草稿 → 气泡折叠

### 草稿过期

不主动清理。条目本身只占几百字节；如果将来发现 localStorage 体积问题，可以加一个「保留最近 200 个 / 30 天前清理」策略。本期不做。

## LLM 查询管线

### Prompt

`src/llm/prompts.ts` 新增：

```ts
export function buildLookupPrompt(expression: string, cueText: string): string {
  return `请给出下面英文单词或短语的中文释义和简短中文用法说明。结合上下文判断在这一句里的具体含义。

单词/短语：${expression}

上下文：${cueText}

输出严格的 JSON 对象，只能包含两个字段，不要任何其他文字、Markdown 代码块、注释：

{"meaningZh": "中文释义（10-30 字）", "usage": "中文用法说明（30-80 字，举一个简单例子或描述使用语境）"}`;
}
```

### 调用

`src/llm/lookupExpression.ts`：

```ts
export async function lookupExpression(
  expression: string,
  cueText: string,
  provider: LlmProvider,        // 现成的 getProvider(settings)
  signal: AbortSignal
): Promise<{ meaningZh: string; usage: string }> {
  const messages = [
    { role: "user", content: buildLookupPrompt(expression, cueText) },
  ];
  // 复用现有 provider.stream() — 不用流式渲染，把所有 chunk 拼起来一次解析
  let buffer = "";
  for await (const chunk of provider.stream(messages, { signal })) {
    buffer += chunk;
  }
  // 容错：模型有时会包一层 ```json ... ```
  const jsonStr = extractJson(buffer);
  const parsed = JSON.parse(jsonStr);
  return {
    meaningZh: String(parsed.meaningZh || "").trim(),
    usage: String(parsed.usage || "").trim(),
  };
}
```

`extractJson` 实现：strip 掉 markdown code fence（`` ```json `` / `` ``` ``）和首尾空白，然后取第一个 `{` 到最后一个 `}` 之间的字串。LLM 偶尔加前置文字（"好的，结果是："）或代码块包裹，这两步覆盖大部分情况。

### 错误处理

- 网络失败 → 气泡进入 `lookup-error` 状态，显示「查询失败 [重试]」
- JSON 解析失败 → 同上，控制台 warn 原始 buffer
- 超时（15s）→ 同上
- 用户点 🔍 期间再次点 🔍 → AbortController 取消上一次

## 字幕里「已收藏」虚线下划线

`SubtitleList` 渲染英文行时多一层切片：

```ts
function renderEnglishWithHighlights(
  s: Subtitle,
  vocabSetForVideo: Set<string>   // 当前视频内已收藏的 expression（lowercased）
): ReactNode {
  // 1. 先按 LLM highlightWords 切（黄色 + keyNote）
  // 2. 在剩余的纯文本片段里，扫描 vocabSetForVideo 的每一项做非重叠切片
  //    匹配命中 → <span className="border-b border-dashed border-zinc-500"
  //                       data-highlight="true" title="已收藏">{...}</span>
  // 3. 黄色和虚线优先级：黄色（LLM 高亮）覆盖虚线
}
```

`vocabSetForVideo` 在 Player 页面用 `useMemo` 算：`new Set(entries.filter(e => e.videoId === videoId).map(e => e.id))`。

`data-highlight="true"` 跟 LLM 黄色高亮共用，确保 hover 同样能 freeze auto-scroll。

## 滚轮禁用

气泡 visible 时，在 `SubtitleList` 容器上：

```ts
useEffect(() => {
  if (!bubbleVisible) return;
  const list = listRef.current;
  if (!list) return;
  const block = (e: WheelEvent | TouchEvent) => e.preventDefault();
  list.addEventListener("wheel", block, { passive: false });
  list.addEventListener("touchmove", block, { passive: false });
  return () => {
    list.removeEventListener("wheel", block);
    list.removeEventListener("touchmove", block);
  };
}, [bubbleVisible]);
```

`{ passive: false }` 是为了能 `preventDefault`。视频区独立容器，不受影响。

## 兼容性 / 边界

| 情况 | 行为 |
|------|------|
| 跨 cue 拖选 | 不显示气泡 |
| 选区只剩空白/标点 | 不显示气泡 |
| 编辑模式开启 | 不显示气泡（避免和 textarea 选区冲突） |
| 选区落在 LLM 黄色 HighlightWord 子串上 | 正常显示气泡，按选中文字保存 |
| 选中已在 vocab 的子串 | 气泡**展开**、⭐ 实心、inputs 预填 vocab 现存值。编辑会 debounce 自动 upsert |
| 已收藏的词编辑后 500ms 内点 ⭐ 取消 | cancel 掉 pending debounce upsert，再调 vocab_remove。不会出现「先 remove 再 upsert 又把条目重建出来」的竞态 |
| 同一 expression 重复点 ⭐ | toggle（先存→点变取消，先无→点变存）；编辑 inputs 不动 ⭐ 状态 |
| 气泡显示时拖动视频时间轴 | 视频区独立，不影响气泡；气泡仍然挂在原选区上方 |
| 选区跨越多个 LLM 高亮（黄色） | 选中的整段文字作为 expression，LLM 高亮的 keyNote tooltip 临时被气泡遮住，关闭气泡后恢复 |
| LLM provider 未配置（用户没填 API key） | 🔍 按钮 disabled + tooltip「请先在设置里配置 AI 翻译服务」；⭐ 直接收藏 仍然可用 |
| 同一 expression 在不同 cue / 不同视频再次保存 | vocab 按 `id = lower(expression)` 全局去重；后端 `vocab_add` 是纯 upsert，所有字段（cueTime / cueText / videoId / videoTitle / addedAt）都用最新值覆盖。这跟现有 KeyPhraseList 的 ⭐ 行为一致 |

## 测试

### Vitest 单测

- `lookupExpression.test.ts`：mock provider，验证 prompt 内容、JSON 解析、容错（带 ```json``` wrapper、带前后噪声字符）
- `vocabDraft.test.ts`：load/save/clear 的边界（空 expression、特殊字符、覆盖、读不存在）
- `SubtitleList.test.ts`：renderEnglishWithHighlights 在 vocab/highlight 同时存在时优先级正确

### 手动验收

1. 拖蓝单词 → 气泡淡入 → 直接 ⭐ → 词汇本里出现条目（meaningZh 空、cueText 有值）
2. 拖蓝短语 → 🔍 查词 → 看到中英结果 → 改一个字 → ⭐ → 词汇本条目是改后的值
3. 已收藏的词再选 → 气泡**展开 + 预填 vocab 现存值 + ⭐ 实心** → 改一行字 → 等 500ms → 词汇本里该条目对应字段更新；继续在气泡里点 ⭐ → 词汇本条目消失、⭐ 变空心，inputs 仍保留刚才编辑的内容（用户可以重新点 ⭐ 重新入库）
4. 选词 → 写一半 → 点页面其他位置 → 气泡淡出 → 重新选同一词 → 气泡展开预填上次写的内容
5. 写一半 → ⭐ 收藏 → 重新选同一词 → 气泡**展开 + ⭐ 实心 + inputs 预填的是刚保存进 vocab 的值**（不是 localStorage 草稿，草稿应已被清掉）
6. 已写过 inputs 后再点 🔍 → 浮卡出现 → hover 替换/追加按钮 → 输入框实时预览 → 移开恢复 → 点击才真正写入
7. 跨两条 cue 拖选 → 气泡不出现
8. 编辑模式下拖蓝 → 气泡不出现
9. 字幕里已收藏的词 → 看到虚线下划线 → hover → auto-scroll 暂停（沿用现有 freeze 机制）
10. 气泡显示时滚轮 → 字幕不滚动；关闭气泡后滚轮恢复正常
11. LLM 配置缺失时 → 🔍 disabled，⭐ 仍可用

## 不做的事（YAGNI）

- 词汇本页面的编辑能力（用户明确推迟）
- 多选拖蓝、连续多个气泡
- 翻译/释义本地缓存（每次 🔍 都新调，简单）
- 离线词典 fallback（IPA 词典只有音标无释义，留空就行）
- 全局快捷键加词
- 草稿过期清理
- 同一 expression 在不同视频里分别记录 cueTime / cueText（vocab 当前是 by expression 全局唯一，沿用）

## 文件改动一览

```
新增:
  src/components/SubtitleSelectionBubble.tsx       (~250 行)
  src/llm/lookupExpression.ts                      (~40 行)
  src/store/vocabDraft.ts                          (~30 行)
  src/components/SubtitleSelectionBubble.test.tsx  (可选)
  src/llm/lookupExpression.test.ts
  src/store/vocabDraft.test.ts

改动:
  src/components/SubtitleList.tsx
    - import + 渲染 SubtitleSelectionBubble
    - renderEnglishWithHighlights 多一层 vocab 虚线切片
    - 接收新 prop: videoId, videoTitle（从 Player 透传）
  src/llm/prompts.ts
    - 新增 buildLookupPrompt
  src/pages/Player.tsx
    - 透传 videoId, videoTitle 给 SubtitleList

不动:
  Rust 端全部
  src/store/vocab.ts
  src/types/vocab.ts
  src/components/HighlightWord.tsx
  src/pages/Vocab.tsx (词汇本编辑能力本期不做)
  src/components/StarButton.tsx (重点短语 tab 仍用)
  src/components/KeyPhraseList.tsx
```
