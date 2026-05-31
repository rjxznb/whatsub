# whatsub AI 私教模式 设计

> 2026-05-31 · 分支 `feat/ai-agent`

## 一句话愿景

**一个知道你水平、用你自己选的视频来教、并且逼你开口练、还记得你每次错在哪的私教。**

当下 agent 缺三件东西：**知道你**、**逼你产出**、**记得**。本设计围绕这三个缺口，把 22 个零散工具收敛成**一个学习闭环 + 两个产出模式 + 一份本地档案**。

## V1 范围

**包含**：
- 学习者模型（Learner Model，本地持久化）
- 精讲模式（Guided Lesson，全屏接管）
- 角色扮演（Role-play，全屏接管，文本输入）
- 触发型专项练习（Triggered Remediation，3 分钟）
- Token 透明度 UI（每次 LLM 入口都先估算 + 实际用量在结课屏对账）

**明确排除**（理由已在讨论中说清）：
- 跟读发音教练（whisper 不是音素评分器，留 v2）
- 麦克风采集 / 语音输入（先用文本跑通体验，留 v2）
- 间隔复习 SRS 闪卡（需档案先有数据，留 v2）
- 主动推送 / OS 通知（留存风险，留 v3）
- 固定剧本场景（删除原 "18 scenes" 概念，场景由当前视频驱动）

## 系统分层

```
┌───────────────────────────────────────────────────────────┐
│ Presentation                                              │
│   LessonOverlay · RoleplayOverlay · RemediationOverlay   │
│   (全屏 portal, mounted from Player or AgentRoot)         │
├───────────────────────────────────────────────────────────┤
│ Runtime                                                   │
│   lessonRuntime · roleplayRuntime · remediationRuntime   │
│   (各自的状态机，不走通用 ReAct loop)                      │
├───────────────────────────────────────────────────────────┤
│ Learner Model                                             │
│   useLearnerProfile (TS hook)                            │
│   learner_profile_* Tauri commands                        │
│   learner_profile.json  (本地文件)                        │
├───────────────────────────────────────────────────────────┤
│ Existing: agent runtime · player state · settings · LLM  │
└───────────────────────────────────────────────────────────┘
```

**关键架构决策**：精讲/RP/专项**不复用 agent runtime 的 ReAct loop**。它们是有限状态机，每一步是一次 LLM 调用。理由：(1) ReAct 的 5-tool-per-turn 上限和工具调用语义不匹配「按教学节奏推进」的需求；(2) 状态机更容易做 resume + token 估算；(3) 解耦让 agent 工具调用 `start_lesson` 之后就「交棒」，runtime 各自跑。

## 学习者模型 (Learner Model)

### 存储

`%APPDATA%/whatsub/learner_profile.json`（路径走 `core/paths.rs`，遵循「测试用 `temp_dir()`、不打生产路径」规则）。**纯本地，不上云**。用户可在设置页「导出学习档案」生成一个 JSON 备份。

### Schema

```ts
interface LearnerProfile {
  version: 1;
  createdAt: number;
  updatedAt: number;

  // 推断出的水平估计（随 errorEvents 累积更新）
  estimate: {
    cefr: "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | null;
    vocabSize: number | null;       // 估算词汇量
    listeningLevel: "low" | "mid" | "high" | null;
    confidence: number;             // 0-1, 数据量越多越高
  };

  // 错误事件时间轴 —— 核心数据，永不删除（用户重置除外）
  errorEvents: ErrorEvent[];

  // 派生的掌握度索引（缓存，从 errorEvents 计算，可重建）
  masteryIndex: {
    weakPatterns: WeakPattern[];   // 跨课累积的薄弱类别
    knownWords: string[];          // 在视频里没问、没查的词
    weakWords: string[];           // 多次错的词
  };

  goals: string[];                  // 用户目标，v1 用空数组（未来扩展）
}

interface ErrorEvent {
  id: string;                       // sha256(now_secs || now_nanos)[..10]
  ts: number;
  source: {
    type: "lesson" | "roleplay" | "remediation";
    videoId: string | null;         // 错误关联的视频
    cueIdx: number | null;          // 视频内的 cue index
    questionId: string | null;      // lesson/remediation 题目 id
  };
  pattern: ErrorPattern;            // 受控词表（见下）
  detail: string;                   // 人类可读: "说了 'I goed' 应该是 'I went'"
  userInput: string;
  correction: string;
  resolved: boolean;                // 是否在专项里改对过
  resolvedAt: number | null;
}

interface WeakPattern {
  pattern: ErrorPattern;
  occurrences: number;
  lastSeenAt: number;
  sampleErrorIds: string[];         // 最近 5 条 errorEvent.id
  lastRemediatedAt: number | null;  // 控制专项触发的冷却
}

// 受控词表 —— 必须用 enum，否则聚合不出趋势
type ErrorPattern =
  // 语法
  | "past_tense_irregular"          // I goed → I went
  | "past_tense_regular"            // I walk → I walked
  | "third_person_singular"         // he go → he goes
  | "article_missing"               // I'm student → I'm a student
  | "article_wrong"                 // a apple → an apple
  | "preposition_wrong"             // in Monday → on Monday
  | "subject_verb_agreement"
  | "present_perfect_vs_past"
  | "modal_verb_wrong"
  | "conditional_form"
  // 词汇 / 表达
  | "chinglish_directness"          // I very like → I really like
  | "chinglish_word_order"
  | "false_friend"                  // sympathetic ≠ 同情心好
  | "register_too_formal"           // furthermore in casual speech
  | "register_too_casual"
  | "word_choice_unnatural"
  // 发音（v2 才会真的产生事件）
  | "pronunciation_th"
  | "pronunciation_final_consonant_drop"
  | "pronunciation_vowel_confusion"
  // 听力
  | "listening_missed_keyword"
  | "listening_misheard_homophone"
  // Fallback
  | "other";
```

**为什么 errorEvents 是事件时间轴而不是「能力分数表」**：能力分数（"过去式 60%"）抽象到无法定位，用户不信。事件带视频 id + cue idx + 原话，**可以让 agent 在下次精讲到类似 cue 时说**：「上次你在《入境》3:42 也错了这个」——这是 ChatGPT memory 永远做不到的。这条规则不能让步。

### 派生索引重建

`masteryIndex` 是缓存，可以从 `errorEvents` 完全重算：
- `weakPatterns`: groupBy(pattern) → 出现次数排序 → 取 top 10 未 resolved 的
- `weakWords`: errorEvents 里被多次纠错的实际词（detail 字段抽 NER）
- `knownWords`: 这是负数据 —— 用户在视频里浏览过但**没**点 highlight、没问、没加到生词本的词。需要 player 侧埋点（cue 显示后停留 ≥3s 且无交互），写入索引。

### Rust commands

```rust
// src-tauri/src/commands/learner_profile.rs
learner_profile_load(app) -> LearnerProfile
learner_profile_log_event(app, event: ErrorEvent) -> Result<()>
learner_profile_resolve_events(app, ids: Vec<String>) -> Result<()>
learner_profile_export(app) -> Result<String>  // 返回写入的文件路径
learner_profile_reset(app) -> Result<()>       // 需用户在设置里二次确认

// 派生索引重建（每次写后触发，debounced 1s）
learner_profile_rebuild_index(app) -> Result<()>
```

测试用 `learner_profile_load_from(path)` / `learner_profile_save_to(path, profile)` 注入临时路径，跟 `settings_save_to` 同模式。

## 精讲模式 (Guided Lesson)

### 触发入口

1. Player 页面右上角 **「📖 来一节精讲」** 按钮（新用户高亮一周）
2. AI agent 对话里：用户说「教我精讲这个视频」→ 工具 `start_lesson(videoId)` 被调用

### 阶段 1：Plan（开课前 1 次 LLM 调用）

输入给 LLM：
- 当前视频的 `analysis.json`（cues + highlights + meaning）
- 当前 `LearnerProfile.estimate` + `masteryIndex.weakPatterns`（top 10）

输出（JSON-schema constrained，3 个 vendor 都得稳定出）：

```ts
interface LessonPlan {
  videoId: string;
  estimateTokens: number;          // 用于 token 透明度显示
  overview: string;                // 100 字以内：本节课主旨
  anchors: TeachingAnchor[];       // 5-8 个
}

interface TeachingAnchor {
  cueIdx: number;                   // 在哪一句停
  topic: string;                    // "I'm here for X 句式" / "现在完成时"
  whyThisOne: string;               // "你刚在《GP》视频也错过这个 pattern"
  targetPatterns: ErrorPattern[];  // 可能命中的错误类别（用于 step 5 反馈引导）
}
```

**Anchor 选择启发式**（写进 system prompt）：
- 必选：命中 `weakPatterns` top 5 的 cue
- 必选：highlight 密集 + 有 ≥2 个不熟词的 cue
- 排除：相邻 < 15 秒的两个 anchor
- 上限：视频长度 ≤ 3 min → 3 anchor，≤ 6 min → 5，≤ 10 min → 7，否则 8

### 阶段 2：Pre-Class 屏（Token 透明度）

全屏 overlay，**接管 Player 页面但不接管整个 app**（用户可点右上 ✕ 取消）：

```
┌───────────────────────────────────────┐
│  准备开课 · Immigration Vlog 3:42       │
│                                         │
│  本节课重点：                            │
│    • I'm here for X（入境最自然说法）   │
│    • 现在完成时 vs 一般过去时             │
│    • customs declaration                │
│                                         │
│  5 个教学点 · 预计 ~3200 tokens         │
│  ≈ DeepSeek ¥0.02 · GPT-4o ¥0.5        │
│  ✓ 当前 LLM: DeepSeek (BYOK)          │
│                                         │
│  [开始上课]              [取消]         │
└───────────────────────────────────────┘
```

### 阶段 3：Lesson Loop（每个 anchor 5 步）

启动时：暂停视频 → 全屏 `LessonOverlay` portal → 关闭 ChatBar → seek 到 `anchors[0].cueIdx`。

每个 anchor 5 步：

| Step | 内容 | 是否 LLM | UI |
|---|---|---|---|
| 1 | 引入「这一段你听到了什么？先试试看」+ 重播 cue 按钮 + 「试试理解」按钮 | ❌（模板话） | 重播按钮 + 双按钮 |
| 2 | 讲解：高亮原文 + 翻译 + agent 解释 + 文化/语用背景 | ✅ 1 次 | 流式 markdown |
| 3 | 提问：开放题 / 转述题 / 造句题（agent 决定） | ✅ 1 次（可与 step 2 合并） | 问题卡 |
| 4 | 用户答（textarea，v1 文本） | — | 输入框 + 提交 |
| 5 | 反馈：判对/纠错 + 错误事件写入 profile + 「继续」按钮 | ✅ 1 次 | 流式 markdown + Continue |

**总 LLM 调用 = 1 (plan) + anchors × (2~3) + 1 (结课总结) ≈ 15-25 次**。

### 错误处理（v1 必须包含）

`错次数` 在**当前 anchor 内**计：
- 错 1 次 → agent 给提示："想想是 *come* 还是 *here*?"
- 错 2 次 → 直接给答案 + 完整解释：":hint: 答案 *I'm here for 3 months of studies*. 因为入境官员问的是「目的」..."
- 同 pattern 跨课累积 ≥3 次（查 `masteryIndex.weakPatterns`）→ 结课屏弹"专项练习"邀约

每次错误**无条件**生成一个 `ErrorEvent` 写入 profile（即使用户最终答对了）。这是 Learner Model 价值的基石。

### 阶段 4：结课屏

```
┌───────────────────────────────────────┐
│ ✓ 完成 · Immigration Vlog              │
│                                         │
│ 你今天学了                              │
│   📚 3 个短语：I'm here for, customs… │
│   ⚙️ 2 个语法点：be here for 句式      │
│                                         │
│ 答题表现：4 / 5 题答对                  │
│                                         │
│ ⚠️  本周第 4 次错「过去式不规则」       │
│     来 3 分钟专项？ [立即开始]          │
│                                         │
│ 想巩固一下？                            │
│   [角色扮演（你当旅客）]                 │
│                                         │
│ [回主页]                                │
└───────────────────────────────────────┘
```

### Resume（中途退出）

用户中途点 ✕ 或切到 Library → 状态写 `app_data/lesson_state.json`：

```ts
interface LessonState {
  videoId: string;
  startedAt: number;
  plan: LessonPlan;
  currentAnchorIdx: number;     // 当前在第几个 anchor
  currentStep: 1 | 2 | 3 | 4 | 5;
  history: AnchorRecord[];       // 已完成 anchor 的对话历史 (供 LLM context)
  errorsThisSession: string[];   // 已写入的 errorEvent.id 集合（防重）
}
```

下次打开同 video → Player 顶 banner：「上次精讲到 3/5，继续？[继续] [重新开始] [关掉]」。**不自动恢复全屏接管**，避免突袭感（这是我们讨论里定的）。

## 角色扮演 (Role-play)

### 触发入口

1. 精讲结课屏「角色扮演」按钮
2. agent 对话里：用户说「来角色扮演」→ 工具 `start_roleplay(scenarioHint?, sourceVideoId?)`

### 场景推导（1 次 LLM 调用）

输入：当前/最近视频 analysis.json + LearnerProfile（用于难度调档）。

输出 1-3 个候选场景：

```
推荐场景：
  ① 你当旅客，我当海关（基于刚才视频）  [难度 ★★]
  ② 你当顾客，我当店员（你这周看了 2 个点餐视频）  [难度 ★]
  ③ 自定义场景：[__________________________]
```

### RP 全屏接管

类似 LessonOverlay：
- 顶部：角色卡（"你: 国际学生 · 我: 海关官员"）+ 场景设定一句话
- 中：对话流（用户 bubble + agent bubble）
- 底：textarea + 「说完了」按钮 + 「结束并复盘」
- 限制：单次会话 ≤ 20 轮（防 token 失控）+ 提示「继续要消耗 ~X tokens」

每个用户 turn → LLM 流式回复 + **同时**用一个 silent system instruction 让 LLM 在每轮最后吐一段 JSON：

```json
{"observed_errors": [{"pattern": "chinglish_directness", "user_text": "...", "correction": "...", "detail": "..."}]}
```

观察到的错误**不打断对话**，只缓存到 `RoleplaySessionErrors[]`，留到复盘期再说。这是 RP 不破坏沉浸感的关键。

### Forensic Report（复盘屏）

RP 结束 → 1 次大 LLM 调用（含所有 turn 历史 + 缓存的 observed_errors） → 出报告：

```
┌───────────────────────────────────────┐
│ 复盘 · 你当旅客我当海关 (14 轮 · 6:32) │
│                                         │
│ ✅ 5 句很自然                           │
│ 📝 4 句中式英语                         │
│    "I very like" → "I really like"     │
│    "I think this is..." → ...          │
│ ⏰ 3 句过去式滑铁卢（本月第 9 次）       │
│    "I goed there" → "I went there"     │
│ 💡 2 句太书面                          │
│    "Furthermore" → "Also"              │
│                                         │
│ 全部错误已记录到学习档案                 │
│                                         │
│ [再来一轮] [开专项] [回主页]            │
└───────────────────────────────────────┘
```

所有错误写入 `errorEvents`，source.type = `"roleplay"`，videoId 是触发视频。

**降级路径**：用户选了便宜小模型（如 GPT-4o-mini / Gemini Flash）时，如果复盘 LLM 调用回包格式错误或 truncate，fallback 简化版报告（只列原始错误 + correction，不做风格分类、不算趋势）。UI 顶端提示「使用更强模型可看趋势分析」。判断**不 hardcode 模型 ID**，只看实际返回质量做 graceful fallback。

## 触发型专项练习 (Triggered Remediation)

### 触发条件

某 pattern 满足全部：
- `WeakPattern.occurrences ≥ 3`
- `Date.now() - WeakPattern.lastRemediatedAt > 3 天`（或 null）
- 当前不在 lesson/RP 中

### 触发时机

- 精讲结课屏：邀约（用户可拒绝）
- 用户主动：agent 对话里说「来个专项」或 Library 顶 banner
- **不**做 OS push（v3 才考虑）

### 形态

3 分钟全屏 `RemediationOverlay`，5-8 道该 pattern 的题。无视频。

题型按 pattern 而定：
```
[过去式不规则]
  Q1. 她昨天买了一本书。 [______]
  Q2. He __ the coffee.  (drank / drinked / drunk)
  Q3. 改错：I goed to the shop yesterday.
  ...
```

题目从一个 hard-coded 题库（每 pattern × 20 题）取 + LLM 现场生成 2 题（套用用户最近的错误事件做素材）。

全部答对且**没有新错** → 该 pattern 的 `lastRemediatedAt = now` + 对应 errorEvent 批量标 `resolved = true`。

至少答对 70% 也算成功，但不全 batch resolve（只 resolve 答对那几个事件）。

### LLM 用量

- 题目 LLM 生成：2 次（5 + 5 题），总 ~1000 tokens
- 答题判分：每题 1 次小调用，总 ~500 tokens
- 总预算 ~1500 tokens

## Token 透明度

每个会发起 LLM 调用的入口**都**先估算 + 显示：

| 入口 | 估算公式（heuristic, hard-coded） |
|---|---|
| Lesson | `500 (plan) + anchors × 500 + 500 (结课) ≈ 3000-4500` |
| RP | `1000 (推荐场景) + planned_minutes × 800 + 1500 (复盘) ≈ 5000-15000` |
| Remediation | `1500` |

实际用量在 runtime 累加（用 vendor 报的 `usage.total_tokens`，没有的 vendor 按 `chars / 4` 近似），结课/复盘屏显示「实际用量 vs 估算」。**多次估算偏差大就调系数**。

设置页加一个「私教默认 LLM」选择器，独立于翻译用的 LLM —— 让用户为不同用途选不同模型（如翻译用便宜的、私教用更强的，或反之），自己权衡 token 成本 vs 质量。所有 LLM 调用都走用户的 BYOK，whatsub 不补贴 token。

## 工具注册表变化

### 删除（精讲已涵盖）
- `explain_passage` ← 精讲 step 2 的子集
- `generate_quiz` ← 精讲 step 3 的子集
- `translate_phrase` ← 精讲 step 2 的子集
- `mark_liaisons` ← 留 v2 跟读模式

→ 注册表从 22 个工具变 18 个。**旧对话历史里包含这些工具调用的消息仍正常渲染**（ToolCallCard 已通用化），只是 agent 不能新发起这些调用。

### 新增
- `start_lesson(videoId: string)` — 启动精讲（HIGH 风险等级，要 inline 确认 token 估算）
- `start_roleplay(scenarioHint?: string, sourceVideoId?: string)` — 启动 RP（HIGH 风险）
- `start_remediation(pattern: ErrorPattern)` — 启动专项（MEDIUM，因为短）
- `query_learner_profile(field?: "summary"|"weak"|"recent")` — 读 profile（讨论模式用，不直接进 runtime）

→ 最终注册表 22 个工具：18 保留 + 4 新增。

### 保留不变

`corpus_browse` / `corpus_phrase_detail` / `list_library` / `list_vocab` / `youtube_search` / `open_video` / `open_page` / `seek_to_time` / `jump_to_cue` / `vocab_add` / `vocab_remove` / `vocab_update_note` / `sync_to_cloud` / `materialize_from_cloud` / `import_video` / `delete_video` / `unsync_from_cloud` / `retranscribe_video`

## UI 变化清单

### 新建组件（src/components/tutor/）

- `LessonOverlay.tsx`（portal, fullscreen, z-50）
- `LessonPreClass.tsx`（token 透明度 + plan 展示）
- `LessonStepView.tsx`（5 步通用容器，根据 step 渲染不同 sub-component）
- `LessonEnd.tsx`（结课屏）
- `LessonResumeBanner.tsx`（Player 顶部 banner）
- `RoleplayOverlay.tsx`（portal）
- `RoleplayScenarioPicker.tsx`
- `RoleplayReport.tsx`（复盘屏）
- `RemediationOverlay.tsx`（portal）
- `RemediationQuestion.tsx`（题型 dispatch）
- `TokenEstimateBadge.tsx`（共享）

### 修改

- `pages/VideoPlayer.tsx`：右上角加「📖 来一节精讲」按钮 + 检查 `lesson_state.json` → 渲染 ResumeBanner
- `pages/Settings.tsx`：加「私教默认 LLM」+「导出学习档案」+「重置学习档案」三项
- `App.tsx`：mount LessonOverlay/RoleplayOverlay/RemediationOverlay 的 portal root
- `components/agent/AgentRoot.tsx`：精讲/RP/专项 active 时强制 mode=icon（不挡视野）

### Runtime（src/tutor/）

- `lessonRuntime.ts`（状态机：plan → loop[anchor → 5 steps] → end）
- `lessonPlanLLM.ts`（plan LLM call + JSON schema 验证）
- `lessonStepLLM.ts`（每个 step 的 LLM call + 流式）
- `roleplayRuntime.ts`
- `roleplaySceneLLM.ts`
- `roleplayReportLLM.ts`
- `remediationRuntime.ts`
- `tokenEstimator.ts`
- `errorEventEmitter.ts`（统一写入 profile 的入口，自动 dedupe）

## Prompt 设计约束

支持 LLM = 现有 BYOK 的 3 个 protocol（`openai-compatible` / `claude` / `gemini`），具体模型由用户在设置里选（DeepSeek-v3 / GPT-4o / Claude Sonnet / Gemini Flash 等）。Prompt 设计原则：

1. **Lesson plan**：JSON schema 强制约束（vendor 支持就用 strict JSON mode；不支持就走 prompt 里 1-shot 示例 + 文本后处理 JSON repair）。系统 prompt < 2000 token。
2. **Lesson step**：单步 prompt ≤ 1500 token，给 anchor 的 cue 文本和上下文 ±2 句即可，**不要**全文塞 transcript（控 token 成本 + 控注意力）。
3. **Roleplay turn**：system prompt ≤ 800 token，角色卡每轮**重复**注入（防漂移——多轮 RP 是 chinglish 检测最脆弱的环节）。
4. **Forensic report**：是大模型才适合做趋势归纳的工作。小模型回包出问题时 graceful fallback 到简化版（仅列错误），见上文「降级路径」。

每个 LLM 入口必须**对照 3 个 vendor 跑通**：DeepSeek-v3（代表 openai-compatible，最便宜）/ Claude Sonnet（代表 claude，最稳）/ Gemini Flash（代表 gemini + cheap-fast-model 边界）。测试 fixtures 与 agent runtime 一致放在 `__fixtures__/`。

## 数据流图

```
用户点 📖 来一节精讲
       │
       ▼
[lessonRuntime.start(videoId)]
       │
       │ 1. 读 analysis.json + learner_profile.json
       │ 2. LLM call (plan) → LessonPlan
       │ 3. tokenEstimator(plan) → estimate
       │
       ▼
[LessonPreClass 屏] 展示 plan + estimate
       │
       │ ↳ 用户取消 → 退出
       │ ↳ 用户开始
       ▼
[LessonOverlay 全屏] for anchor in plan.anchors:
       │
       │   player.seek(anchor.cueIdx)
       │   step 1: 模板话 + 重播按钮
       │   step 2: LLM call (讲解) → 流式
       │   step 3: LLM call (问题) → 流式（可与 step2 合并）
       │   step 4: 用户输入 (textarea, Enter 提交)
       │   step 5: LLM call (反馈) → 流式
       │            ├ 答错 → emit ErrorEvent → 看是否给提示/答案
       │            └ 答对/给答案 → Continue 按钮
       │
       │  每个 anchor 完成 → 写 lesson_state.json (resume 用)
       │
       ▼
[LessonEnd 屏] 总结 + 触发专项邀约 + RP 邀约
       │
       └─→ learner_profile_rebuild_index (debounced)
```

## 待解决的开放问题（写实现前 spike）

1. **Lesson plan prompt 迭代**：至少 3 轮 prompt-eval 跑通最便宜目标 vendor（Gemini Flash / GPT-4o-mini 级别）稳定出合理 anchor。可能要 1-shot 示例 + JSON repair。**首个实现任务**。
2. **Mid-lesson 切到 Library 后回来**：进 Player 时检查 lesson_state.json → 顶 banner，**不自动接管**（讨论里定的）。但「上次到 3/5」的 N 怎么算 —— 是「已完成 N 个 anchor」还是「当前 step 序号」？决定走前者（用户更易理解）。
3. **错误归一化**：用户答 "I went to shop" 应该匹配 "I went to **the** shop" 还是判错？需要 LLM 反馈层做 fuzzy match：实质对就算对，缺冠词单独 emit `article_missing` event 但不阻塞进度。**这是 step 5 prompt 的设计重点**。
4. **结课屏专项邀约的频次控制**：每节课都弹？还是攒 3 节再弹？倾向「每节课检查一次但 24h 内最多弹一次专项」，加 last shown timestamp 防骚扰。
5. **`knownWords` 埋点**：Player 侧需要新加 cue 停留时长跟踪 + 无交互判定。**这块新增复杂度**，可不可以 v1 跳过 knownWords，只用 errorEvents 反推 → 精讲 plan 暂时只看 weakPatterns？我倾向跳过，v1 简化。
6. **agent_history 与 lesson/RP 历史**：精讲/RP 不入 agent_history.json（不是对话）。但**结课/复盘后**生成一条系统消息「完成精讲 X / 答对 4/5」插到当前 agent 会话，让用户翻 history 能看到。
7. **取消 lesson 但未结课的 errorEvents**：保留还是丢弃？保留 —— 错误事件本身有价值，session 没结束不该丢弃数据。

## 上线成功指标

- **完成率**：lesson started → ended ≥ 60%
- **D7 留存**：用户第一次完成精讲后 7 天再开 ≥ 35%
- **profile 深度**：用户开课 ≥ 3 次后，`errorEvents.length` 中位数 ≥ 15
- **专项命中**：弹出专项邀约的点击率 ≥ 40%（说明用户认这个反馈）
- **token 预算可信**：实际用量 / 估算 落在 [0.7, 1.5] 占比 ≥ 80%

四周后看这五条任意三条不达标 → 回头修 prompt / 流程，不直接扩范围。

## 与现有代码的兼容性

- ✅ 不改 `library.json` schema
- ✅ 不改 `analysis.json` schema（精讲消费它，不写它）
- ✅ 不改 player 核心 + cue 渲染（只加 seek 调用 + 暂停信号）
- ✅ 不动 `agent_history.json`（lesson/RP runtime 自己持久化）
- ⚠️ 改 `registry.ts`：移除 4 工具 + 添加 4 工具
- ⚠️ 新增文件：`learner_profile.json` + `lesson_state.json`
- ⚠️ Settings 加 3 项配置（私教 LLM / 导出 / 重置）
- ⚠️ Player TopBar 加 1 按钮 + 1 banner

## 不包含的隐式约束

- 这份 spec **不**包含跟读 / 麦克风 / 间隔复习 / 通知推送的设计。这些是后续 spec 的工作。
- 这份 spec **不**重新设计 ChatBar / AgentRoot —— 精讲/RP/专项是新 portal，agent 在 active 时静默。
- 这份 spec **不**包含 marketing copy 或定价决策（BYOK 只是技术约束，不是商业决策）。
