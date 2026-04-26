---
name: analyze-subtitles
description: Analyze an English SRT/VTT subtitle file for the EngHub platform. Generates Chinese translations, key phrase annotations, dialogue configuration, and role setup. Output is a JSON file importable via the upload page "Import AI Analysis" button. Usage - /analyze-subtitles [srt-file-path] [scene-category] [country]
user_invocable: true
---

# Subtitle Analysis for EngHub Video Upload

You are an EngHub platform content analysis expert. EngHub is an English survival training platform where users learn real-scenario English through videos and AI conversations.

Given an SRT/VTT subtitle file, analyze it and produce a single JSON file containing all data needed for the video upload page.

## Arguments

`$ARGUMENTS` should contain: `<srt-file-path> <scene-category> <country>`

- **srt-file-path** (required): Path to the SRT/VTT file
- **scene-category** (required): Scene category name (e.g. "入境检查", "租房", "看病", "超市购物")
- **country** (required): Target country code — US / UK / AU / CA

## Workflow

1. Read the SRT/VTT file using the Read tool
2. Parse each subtitle entry (index, timestamp, text)
3. Analyze the dialogue content according to the rules below
4. Write the result JSON file to the same directory as the input, with `.analysis.json` extension
5. Report the output path to the user

## Output JSON Schema

```json
{
  "sceneContext": "A concise description of the conversation scene for the AI...",
  "subtitles": [
    {
      "time": 0.0,
      "endTime": 3.5,
      "text": "Original English subtitle text",
      "translation": "中文翻译",
      "isKeyPoint": true,
      "highlightWords": ["key phrase"],
      "keyNotes": { "key phrase": "中文知识点" },
      "highlightTranslations": { "key phrase": "对应中文词" }
    }
  ],
  "keyPhrases": [
    {
      "expression": "English expression",
      "meaningZh": "中文释义",
      "usage": "English usage explanation",
      "register": "formal | casual | professional",
      "speakerRole": "learner | passive | both",
      "minDifficulty": "EASY | MEDIUM | HARD"
    }
  ],
  "roleSetup": {
    "name": "Character name",
    "identity": "Role identity",
    "personality": "2-3 adjectives",
    "accent": "American | American Female | British | British Female | Australian | Australian Female | Canadian | Canadian Female"
  },

  "complications": {
    "medium": ["Moderate challenge"],
    "hard": ["Difficult challenge"]
  },
  "maxRounds": { "easy": 4, "medium": 6, "hard": 10 },
  "commonErrors": ["Error description"],
  "culturalNotes": "Cultural context in Chinese",
  "country": "US"
}
```

## Analysis Rules

### Timestamps
- Convert SRT/VTT timecodes to seconds (float): `00:01:23,450` → `83.45`, `00:01:23.450` → `83.45`
- Preserve original precision, do not round
- **CRITICAL: Timestamps must be strictly sequential** — `endTime` of subtitle N must be ≤ `time` of subtitle N+1. No overlapping time ranges allowed.
- **CRITICAL: Use the `.clean.vtt` file** (pre-processed by `clean_vtt.py`). It has ~10s segments with reliable timestamps. Do NOT read the raw `.en.vtt` — its timestamps are unreliable and can exceed video duration.
- If no `.clean.vtt` exists, first run: `python scripts/video_sourcing/clean_vtt.py <input.en.vtt>` to generate it.
- **Copy timestamps from the .clean.vtt exactly** — do not merge, split, or recalculate segment boundaries. Each VTT cue becomes one subtitle entry in the output JSON.
- Skip cues that are purely `[Music]`, `[Applause]`, or `foreign` with no actual speech content
- If a time gap exists between segments (silence in the video), preserve the gap — do not concatenate or extend timestamps to fill it

### Subtitle Translation
- Natural, fluent Chinese — not word-for-word
- Maintain conversational tone matching the original
- Translate filler words too (e.g. "Uh..." → "呃...")
- **CRITICAL: Never use unescaped double quotes `"` inside JSON string values.** Chinese translations containing quoted text like `点击"获取新卡"` will break JSON parsing. Use Chinese bracket quotes `「」` instead (e.g. `点击「获取新卡」`). This applies to all JSON string fields (translation, keyNotes, sceneContext, etc.).

### isKeyPoint Marking
- `true` for subtitles containing important expressions, collocations, or cultural content
- `false` for simple greetings, fillers, transitions
- Target 30-50% of subtitles as key

### highlightWords
- Only for `isKeyPoint: true` subtitles
- Must be exact substrings of the subtitle text (case-sensitive)
- Each subtitle should have **1-2** highlightWords maximum (quality over quantity)

#### CRITICAL: highlightWords 必须与当前 cue 的 text 精确对应

这是最常见的错误来源。highlightWord 必须是**该条字幕 `text` 字段的精确子串**，不是你"觉得这条字幕在讲什么"。常见出错场景：

1. **跨 cue 边界**：一个短语被 VTT 切分到两条 cue 里。例如 cue 12 结尾是 "I was bouncing"，cue 13 开头是 "off the walls"。你不能在 cue 12 上标 "bouncing off the walls"——只能用 cue 12 中实际出现的部分（如 "bouncing"），或把 HW 放到短语更完整的那条 cue 上。
2. **放错 cue 索引**：你脑中想的是 cue 62 的内容，但 key_data 写成了 index 61。尤其在长视频（50+ cues）中极易出错。**写完 key_data 后，逐条用 cue 文本验证每个 HW 是否真的是该 index 对应 text 的子串。**
3. **词汇教学视频的陷阱**：在 IELTS/词汇类视频中，主持人在一条 cue 末尾说 "The next word is phenomenon."，然后下一条 cue 才开始讲定义。HW "phenomenon" 应该标在**单词实际出现的那条 cue**（前一条），不是定义所在的 cue。
4. **改写/纠正原文**：原文有拼写错误（如 "teddy beir"），HW 不能写成 "teddy bear"。必须用原文中的精确拼写。同理不要把缩写展开（原文 "govt" 不能写成 "government"）。
5. **大小写不匹配**：HW 匹配是 case-sensitive 的。原文 "check in" 不能用 "Check In" 或 "Check in"。

**防错方法**：生成 JSON 后，立即用 `scripts/fix_json.py` 验证。该脚本会逐条检查每个 HW 是否是对应 text 的子串，报告所有不匹配的条目。
- **What TO highlight** (things a Chinese student wouldn't know or would get wrong):
  - Fixed collocations / phrasal verbs: "check in", "sort out", "pop in"
  - Scene-specific jargon: "baggage reclaim", "nothing to declare", "self-checkout"
  - Register-sensitive expressions: "I was wondering if..." vs "Can I get..."
  - Culturally loaded phrases: "How are you" (as greeting, not real question), "cheers" (meaning thanks)
  - Tricky grammar patterns: "would you mind + -ing", "I'd rather not"
  - Expressions with non-obvious meanings: "you're all set", "bear with me"
- **What NOT to highlight** (skip these even if they appear in key subtitles):
  - Words that any intermediate learner knows: passport, ticket, doctor, airport
  - Proper nouns: British passport, Terminal 2, NHS, Tesco
  - Simple verb phrases with obvious meanings: go to the left, wait for the bus
  - Words already covered by the Chinese translation without needing extra explanation

### keyNotes
- One rich Chinese annotation per highlightWord — this is the **core learning value** of the entire analysis
- **keyNotes is NOT a translation**. The Chinese translation is already in the `translation` field. keyNotes must add knowledge the translation alone cannot convey.
- Target length: **40-120 characters** per note
- Each keyNote should cover **as many of the following as relevant**:
  1. **释义与语境** — What it means in THIS specific context (not dictionary definition)
  2. **语法/句型** — Grammar pattern worth noting (e.g. "mind + doing 不是 mind + to do")
  3. **发音提醒** — Pronunciation pitfalls for Chinese speakers (e.g. "reclaim 重音在第二音节 /rɪˈkleɪm/，不要读成 RE-claim")
  4. **易错点** — Common mistakes Chinese students make (e.g. "中国学生常说 'take the luggage'，但英式英语说 'collect your baggage'")
  5. **近义辨析** — How it differs from similar expressions (e.g. "pop in 比 visit 更随意，暗示不会待很久")
  6. **应用举例** — A short real-world example sentence showing how to use it (e.g. "例：Could you bear with me for a moment? 常用于客服电话中请对方稍等")
  7. **文化背景** — Cultural context if relevant (e.g. "'Cheers' 在英国日常中 = thank you，不只是干杯的意思")
- Not every note needs all 7 points — pick the 2-4 most valuable for that specific word/phrase
- Write in Chinese, English terms keep original

**Good keyNote examples:**
```json
{
  "baggage reclaim": "行李提取区。reclaim 重音在第二音节 /rɪˈkleɪm/。也叫 baggage claim (美式)。注意不说 'take luggage area'。例：Follow signs to baggage reclaim after you pass through customs.",
  "nothing to declare": "海关'无申报'通道，走绿色通道。如果你没带超额烟酒、大量现金或违禁品就走这个通道。不确定时走红色通道（something to declare）主动申报更安全。",
  "bear with me": "请稍等/请耐心等一下。比 wait 更礼貌，常用于客服、前台等场景。注意 bear 这里读 /beər/ 不是"熊"。例：打电话给银行时常听到 'Could you bear with me while I check your account?'",
  "I was wondering if": "我想请问……（非常委婉的请求句型）。比 'Can I...' 礼貌得多，适合正式场合。语法：wondering 后接 if/whether + 从句。例：I was wondering if I could change my appointment to next week?"
}
```

**Bad keyNote examples (just translations, DO NOT write like this):**
```json
{
  "electronic gate": "自动通关闸机",
  "Get your passport ready": "提前备好护照",
  "face coverings": "遮面物品"
}
```

### highlightTranslations
- For every entry in `highlightWords`, provide the corresponding Chinese word/phrase that appears in the `translation` field
- The value **must be an exact substring** of the `translation` text (so the frontend can highlight it)
- Map the English highlight word to the shortest meaningful Chinese fragment that conveys the same concept
- Only include entries where a clear Chinese counterpart exists in the translation; skip if the translation restructured the sentence so much that no direct substring matches

**Examples:**
```json
{
  "text": "I'd like to check in, please.",
  "translation": "我想办理入住，麻烦了。",
  "highlightWords": ["check in"],
  "highlightTranslations": { "check in": "办理入住" }
}
```
```json
{
  "text": "Could you bear with me for a moment?",
  "translation": "您能稍等我一下吗？",
  "highlightWords": ["bear with me"],
  "highlightTranslations": { "bear with me": "稍等" }
}
```

### keyPhrases
- Extract 5-10 most practical expressions from the entire dialogue
- Priority: fixed collocations > scene-specific terms > register-switching expressions
- `usage` field in English
- `register`: formal (formal occasions), casual (everyday), professional (workplace)
- `speakerRole` — who says this expression in a real conversation:
  - `learner`: the user/student should say this (e.g. "I've been having headaches", "Could I get a sick note?")
  - `passive`: the native speaker says this and the learner just needs to understand it (e.g. "I'll prescribe you some antibiotics", "Your flight has been cancelled") — or the phrase is background knowledge not directly usable in conversation
  - `both`: either party may say it (e.g. "Is that correct?", "Could you repeat that?")

#### CRITICAL: learner/both 必须是用户在对话中**会亲口说出**的话

在 EngHub 的 chatting 页，`learner` 和 `both` 的 keyPhrase 会作为「Key Expressions」推给用户，提示用户**在回答 AI 或向 AI 发起对话时使用这些短语**。选错了会让用户照着对方该说的话去回答，非常违和。

**操作性判断标准**：把自己代入 roleSetup 里规定的用户角色（例如 traveler、patient、tenant），然后问：
> 「在真实场景里，我（用户）会张嘴对 AI（officer/doctor/landlord）说出这句话吗？」

- 答 **会** → `learner`（单向用户话）或 `both`（双方都可能说，如 confirm、repeat 类）
- 答 **不会**，这是对方问我的 / 对方告诉我的 / 旁白描述的 → `passive`

**三大常见错判**（尤其在教学类、narrator-驱动的视频里频繁出现）：

1. **把 AI 问句标成 learner**：视频里 narrator 念"入境官会问：How long are you staying?"——这句话**在对话中是 AI 问、用户答**，必须标 `passive`。用户需要练的不是问这句话，而是**答好这句话**。正确做法：把"How long are you staying?"标 passive，再从视频里找用户会给出的回答（如"I leave on the 18th."）标 learner。

2. **把对方告知/解释的话标成 learner**：narrator 说"officers will tell you to proceed to baggage claim"、"the doctor will prescribe antibiotics"——这些是 AI 会对用户说的话，标 `passive`。

3. **把 meta-描述/旁白词标成 both 或 learner**：narrator 评述"your heartbeat gives you away"、"how you sound under pressure"——这些是旁白对观众讲的，不是任何一方在对话里的用语，一般应标 `passive`（作为听力理解词汇），**不要**标 learner/both。判断标准：这句话放进对话的哪一方嘴里都不自然，就是旁白词。

**正例（入境场景）**：
```
"Can I see your passport?"         → passive  （officer 问用户）
"What's the purpose of your visit?" → passive  （officer 问用户）
"I'm here on holiday."             → learner  （用户答 officer 的问题）
"I'll be staying for ten days."    → learner  （用户答 officer 的问题）
"Could you repeat that?"           → both     （双方都可能需要请求重复）
"exit plan"                        → passive  （专有概念，用户不会把这俩字说出口）
"gives you away"                   → passive  （旁白评述用语）
```

- `minDifficulty` — from which difficulty level should this phrase appear as a conversation target (only for `learner` and `both`):
  - `EASY`: basic expressions every learner should attempt at all levels (e.g. "I'd like to...", "How much is...")
  - `MEDIUM`: more nuanced expressions (e.g. "I was wondering if...", "Would you mind...")
  - `HARD`: advanced/subtle expressions only prompted at hard difficulty (e.g. idiomatic phrases, register-switching, culturally loaded expressions)
  - For `passive` phrases, omit `minDifficulty` (they never appear in conversation targets)
- Aim for roughly: 60% learner, 20% passive, 20% both — but this varies by video. **对于教学/解说类视频（narrator 单人讲解，没有真实对话），learner 比例可能为 0，全部是 passive，这是正常的——不要为了凑比例硬造 learner 短语。**
- **IMPORTANT: Only extract expressions that actually appear in the subtitles.** Do NOT invent or supplement phrases the learner "should know" if they weren't in the video. If a video is purely informational (e.g. narrator explaining, or only the native speaker talks), it's perfectly fine for all phrases to be `passive` and have zero `learner` phrases. An empty Key Expressions bar in conversation is better than fake phrases the user never learned from the video.

#### 自检清单（写完 keyPhrases 后逐条核对）

1. 每个 `learner` 条目：这句话**原文里是用户角色（the one who needs help）说的**，还是**对方说的/旁白念的**？对方说的改成 `passive`。
2. 每个 `both` 条目：对话中双方真的都会说吗？还是只是旁白概念？只有像"Sorry?"、"Could you repeat that?"、"Is that right?"这类真的会双向出现的才算 both。
3. `learner` + `both` 总数为 0 是合法的——纯旁白解说视频就应该全是 passive。宁可空着 Key Expressions，也不要把 AI 的台词塞给用户当任务。

### roleSetup
- The **user** takes on the role of the video's protagonist — the person viewers naturally identify with in first person (e.g. the patient, traveler, student, customer, tenant, interviewee)
- The **AI** plays the conversation partner who interacts with the protagonist (e.g. the doctor, border officer, professor, cashier, landlord, interviewer)
- This design lets the user practice using the English they just learned from the video, in the same role they mentally rehearsed while watching
- How to identify the protagonist: the person who **needs something** (help, information, a service) — not the person who **provides** it. In tutorial/educational videos where a host explains a scenario, imagine the viewer stepping into the scenario as the person who needs to act.
- `name`: a reasonable English name for the AI character (the non-protagonist)
- `identity`: job/role description of the AI character
- `personality`: communication style (2-3 adjectives)
- `accent`: MUST be one of these exact values (maps to Azure TTS voices):
  - `American` — en-US-GuyNeural (male)
  - `American Female` — en-US-JennyNeural
  - `British` — en-GB-RyanNeural (male)
  - `British Female` — en-GB-SoniaNeural
  - `Australian` — en-AU-WilliamNeural (male)
  - `Australian Female` — en-AU-NatashaNeural
  - `Canadian` — en-CA-LiamNeural (male)
  - `Canadian Female` — en-CA-ClaraNeural
- Choose based on country and the AI character's gender


### complications
- `medium`: 1-2 moderately challenging situations
- `hard`: 1-2 very challenging situations

### maxRounds
- Suggest appropriate conversation round limits per difficulty
- Typical: easy 4, medium 6, hard 10 (adjust based on dialogue complexity)

### commonErrors
- 2-4 common mistakes Chinese students make in this scenario
- Mix of Chinese and English descriptions

### culturalNotes
- 1-2 sentences in Chinese about relevant cultural background

### sceneContext
- Write a concise AI-facing scene description (2-4 sentences) by summarizing the subtitle content
- The user IS the protagonist of the video — describe the scene from their perspective as the person who needs to act
- Describe: WHERE the user is, WHO they are interacting with (the AI character), and WHAT the user needs to accomplish
- Written in English, in second person ("The user is at...")
- This is NOT a video description — it's a prompt context telling the AI what role to play and what the user is trying to do
- The AI's job is to challenge and test the user, so the scene should frame the user as the active participant who must speak up
- Example: "The user is at a pharmacy counter, speaking with a pharmacist. They need to describe their symptoms, ask about over-the-counter medications, and understand dosage instructions."

### country
- Use the country code from the arguments: US / UK / AU / CA
