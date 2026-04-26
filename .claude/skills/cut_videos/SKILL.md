---
name: video-clip-advisor
description: Analyze video subtitles (SRT/VTT/JSON) and recommend which segments to keep for English learning. Use this skill whenever the user uploads subtitle files, pastes subtitle text, or asks "which parts of this video should I clip", "help me find the best segments", "analyze this subtitle for teaching content", or any request about identifying valuable dialogue segments in video subtitles for language learning purposes. Also triggers when the user mentions Eversay video content, scene video editing, or clip recommendations.
---

# Video clip advisor

Analyze subtitle files from YouTube or other video sources. Identify dialogue segments worth keeping for English language teaching. Output a structured recommendation report that the user reads and manually clips the video themselves.

**You do NOT execute any video cutting.** You only analyze and recommend.

## When to use

- User uploads an SRT, VTT, or JSON subtitle file
- User pastes subtitle text directly
- User asks which parts of a video are worth keeping for teaching
- User provides a video URL and asks for clip analysis (use the analyze-subtitles skill or transcription tools first if needed)

## Input formats accepted

### SRT format
```
1
00:00:01,000 --> 00:00:04,500
Welcome to the UK. Can I see your passport please?

2
00:00:05,200 --> 00:00:08,900
Yes, here you go. I'm here to study at UCL.
```

### VTT format
```
WEBVTT

00:00:01.000 --> 00:00:04.500
Welcome to the UK. Can I see your passport please?

00:00:05.200 --> 00:00:08.900
Yes, here you go. I'm here to study at UCL.
```

### JSON format (from Whisper or YouTube API)
```json
[
  {"start": 1.0, "end": 4.5, "text": "Welcome to the UK. Can I see your passport please?"},
  {"start": 5.2, "end": 8.9, "text": "Yes, here you go. I'm here to study at UCL."}
]
```

### Plain text (user pastes subtitles directly)
If timestamps are missing, analyze content only and skip timing recommendations.

## Sub-scene classification

Every video must be classified into a **sub-scene** within its major scene category. This helps users quickly find the specific situation they need to practice.

### Taxonomy

```
immigration 入境通关
  passport_control    护照检查        Border officer Q&A, passport stamps, entry questions
  customs             海关申报        Customs declaration, red/green channel, prohibited items
  visa_interview      签证面试        Embassy/consulate visa interview, DS-160, document prep
  baggage_claim       行李提取        Lost/delayed/damaged luggage, baggage carousel
  arrival_guide       入境攻略        General arrival tips, what to expect, airport navigation

dining 餐饮
  restaurant          餐厅点餐        Sit-down restaurant ordering, waiter interaction, menu questions
  fast_food           快餐外卖        Fast food, takeout, drive-through, counter service
  food_tour           美食探店        Food tours, restaurant reviews, trying local food
  cafe_bar            咖啡酒吧        Cafe ordering, pub culture, bar conversation
  home_cooking        居家烹饪        Cooking at home, recipe following, grocery ingredients

shopping 日常购物
  grocery             超市购物        Supermarket, produce section, checkout
  mall                商场逛街        Mall shopping, clothing, beauty stores, trying on
  thrift              二手淘宝        Thrift stores, vintage shops, flea markets, estate sales
  online_unboxing     网购开箱        Online shopping, unboxing, product reviews

housing 住房安家
  apartment_viewing   看房选房        Apartment tours, viewing flats, comparing options
  lease_rental        租房签约        Lease terms, deposit, landlord communication, rental scams
  moving_in           搬家入住        Moving in, settling, decorating, furniture
  renovation          装修改造        Home renovation, interior design, remodeling
  neighborhood        社区生活        Neighborhood exploration, local amenities, community

medical 医疗健康
  gp_visit            门诊看病        GP/doctor appointment, describing symptoms, diagnosis
  emergency           急诊就医        ER visit, urgent care, triage
  pharmacy            药房取药        Pharmacy pickup, OTC medication, dosage instructions
  specialist          专科转诊        Specialist referral, hospital procedures, surgery
  health_education    健康知识        Public health, preventive care, health system explainers

campus 校园学习
  class_discussion    课堂讨论        Seminar, tutorial, group discussion, presentations
  office_hours        教授答疑        Professor office hours, academic advising
  study_skills        学习方法        Study strategies, time management, exam prep
  student_life        校园生活        Orientation, clubs, campus facilities, social events
  international       留学适应        International student adjustment, culture shock, language barriers

social 社交日常
  small_talk          闲聊寒暄        Casual small talk, conversation starters, greetings
  making_friends      交友互动        Making friends, dorm life, roommate conversations
  street_interview    街头采访        Street interviews, public opinion, campus voices
  workshop            团队协作        Workshops, icebreakers, group activities, facilitation
  networking          人脉社交        Professional networking, building rapport, elevator pitch

job 求职职场
  interview_skills    面试技巧        Interview preparation, answering behavioral questions
  interview_mistakes  面试避坑        Common mistakes, what not to do/say
  job_search          简历求职        Resume writing, job search strategy, LinkedIn, recruiter tips
  workplace           职场沟通        Workplace culture, email etiquette, meeting participation

driving 驾照开车
  driving_test        路考实录        Actual driving test, mock test with examiner
  driving_lesson      学车练车        Driving lessons, instructor guidance
  written_test        笔试交规        Knowledge test, traffic rules, DMV procedures
  driving_tips        驾驶经验        Road tips, driving culture differences, road safety

transport 交通出行
  subway_bus          地铁公交        Subway, metro, bus, LRT navigation and tickets
  airport_transit     机场交通        Airport to city transport (AirTrain, shuttle, express)
  taxi_rideshare      打车叫车        Taxi, Uber, ride-hailing conversations

vlog 日常生活
  city_life           城市日常        Week in my life, urban routines, city exploration
  road_trip           公路旅行        Road trips, driving adventures, travel vlogs
  study_abroad        留学生活        Study abroad experience, living overseas, cultural comparison
  wellness            健康生活        Sick days, self-care routines, work-life balance

entertainment 娱乐明星
  celebrity_interview 明星访谈        Celebrity interviews, talk show clips
  fan_culture         粉丝文化        Fan encounters, meet & greets, concert experiences
  entertainment_news  娱乐资讯        Gossip, celebrity news, pop culture commentary
  media_review        影视点评        Movie/TV/music reviews, house tours, behind the scenes

podcast 播客访谈
  celebrity_chat      名人对谈        Celebrity podcast interviews, long-form conversations
  relationships       恋爱社交        Dating advice, relationship discussions
  lifestyle           生活分享        Morning routines, lifestyle tips, personal stories
  deep_dive           深度话题        In-depth topical discussions, debates, expert conversations

mental_health 心理健康
  anxiety_coping      焦虑应对        Anxiety management, panic attacks, coping strategies
  stress_trauma       压力创伤        Stress, trauma responses, burnout, resilience
  therapy             心理咨询        Therapy sessions, counseling conversations, seeking help
  wellness_retreat    身心调养        Wellness retreats, mindfulness, meditation, self-care

tech 计算机技术
  career_path         职业规划        Tech career roadmaps, becoming a developer/analyst/designer
  tool_tutorial       工具教程        Software tutorials (Figma, VS Code, Excel, etc.)
  industry            行业见闻        Tech industry culture, startup life, tech news

salon 美容美发
  haircut_service     理发服务        Salon/barbershop visit, stylist-client conversation
  hair_technique      发型技术        Hair cutting/styling/coloring techniques, tutorials
  makeup              美妆教程        Makeup tutorials, beauty product reviews
  fashion             穿搭展示        Fashion hauls, outfit styling, try-on videos

game 游戏
  multiplayer         多人互动        Multiplayer chat, team communication, in-game social
  tutorial            游戏教程        Game tutorials, how-to guides, walkthroughs
  commentary          游戏实况        Solo gameplay commentary, let's play, reactions

travel 旅游度假
  sightseeing         城市观光        City tours, landmarks, sightseeing
  hotel               酒店住宿        Hotel check-in/out, Airbnb, accommodation reviews
  culture             文化体验        Local customs, cultural experiences, etiquette
  travel_tips         旅行攻略        Travel planning, packing, budget tips, safety

maintenance 搬家维修
  diy_repair          自己动手        DIY home repairs, fixing things yourself
  hire_contractor     找工匠          Hiring plumbers, electricians, contractor communication
  moving              搬家整理        Moving house, packing, organizing, logistics

emergency 紧急情况
  er_visit            急诊室          Emergency room experience, hospital emergency
  call_emergency      报警求助        Calling 911/999, reporting incidents
  overseas_crisis     海外突发        Lost passport, insurance claims, consulate contact
```

### Classification rules

1. **Classify based on actual content, not the video title.** A video titled "apartment tour" that's really about renovation → `renovation`, not `apartment_viewing`.
2. **If content spans multiple sub-scenes**, pick the dominant one (>50% of useful content). Mention the secondary sub-scene in the report.
3. **If content doesn't match ANY sub-scene** in the major scene, note the mismatch and suggest a better major scene + sub-scene. Example: a "salon" video that's really a fashion haul → `salon/fashion`.
4. **Misclassified videos**: If the video belongs to a completely different major scene, report: `RECLASSIFY: actual scene = [X], sub-scene = [Y]`.

## Analysis process

### Step 1: Parse and understand the full video

Read the entire subtitle file first. Before recommending any clips, build a mental map of:
- What is the video about overall?
- Who is speaking? How many speakers are there?
- What is the general flow/narrative?
- What language level is the content?

### Step 2: Identify dialogue segments

A "dialogue segment" is a continuous exchange between two or more people on the same topic. The critical rule:

**NEVER cut in the middle of a conversation turn.** A segment must:
- Start at the beginning of a speaker's turn (not mid-sentence)
- End at a natural conversation boundary (topic change, scene change, long pause, or a clear closing like "thank you", "right then", "welcome to the UK")
- Include enough context that a viewer understands what's happening without seeing what came before

Look for these natural boundaries:
- Greetings / farewells ("Good morning" / "Thank you, goodbye")
- Topic shifts ("Now, moving on to..." / "One more thing...")
- Scene changes (location change, new speaker introduced)
- Long pauses (>3 seconds of silence between subtitle entries)
- Completion of a question-answer pair (never cut between a question and its answer)

### Step 3: Score each segment

Rate each identified segment on these criteria:

**Dialogue quality (1-5)**
- 5: Natural back-and-forth conversation, realistic pace, includes hesitations/fillers
- 3: Somewhat scripted or one-sided but still useful
- 1: Monologue, narration, or completely scripted

**Teaching value (1-5)**
- 5: Contains multiple expressions a Chinese student would struggle with + clear context
- 3: Contains 1-2 useful expressions
- 1: Too simple (hello/goodbye) or too specialized (technical jargon)

**Context completeness (1-5)**
- 5: Segment is fully self-contained, viewer needs zero background
- 3: Viewer needs minimal context (a one-sentence setup would help)
- 1: Incomprehensible without watching the full video

**Engagement (1-5)**
- 5: Viewer would find this interesting/relatable/slightly tense
- 3: Informative but not engaging
- 1: Boring, would skip

### Step 4: Generate the recommendation report

## Output format

For each recommended segment, output:

```
═══════════════════════════════════════════════
SEGMENT [number]: [descriptive title]
═══════════════════════════════════════════════

⏱ Time range:     [HH:MM:SS] → [HH:MM:SS]  (duration: X min X sec)
⭐ Overall score:  [X/5]
📊 Scores:         Dialogue [X/5] | Teaching [X/5] | Context [X/5] | Engagement [X/5]
🎯 Difficulty:     EASY / MEDIUM / HARD
🎬 Scene type:     [e.g., border control Q&A, GP consultation, flat viewing]
🏷 Sub-scene:     [sub_scene_key] [中文名] (from the taxonomy above)

WHY KEEP THIS SEGMENT:
[1-2 sentences explaining why this segment is valuable for teaching]

DIALOGUE PREVIEW:
[Show the first 4-6 subtitle lines of the segment so the user can quickly identify it]

KEY EXPRESSIONS FOUND:
  1. "[expression]" — [Chinese explanation] — appears at [timestamp]
  2. "[expression]" — [Chinese explanation] — appears at [timestamp]
  3. ...

CONTEXT NOTE FOR STUDENTS:
[A one-sentence setup that should appear before the video plays,
 e.g., "You've just landed at Heathrow and are walking to passport control."]

CUT POINT NOTES:
  Start: [Why this is a safe start point, e.g., "Officer greets the passenger — clean scene opening"]
  End:   [Why this is a safe end point, e.g., "Officer says 'Welcome to the UK' — natural closing"]
  ⚠ Do NOT start earlier because: [reason, e.g., "previous section is blogger talking to camera, not relevant dialogue"]
  ⚠ Do NOT end later because: [reason, e.g., "next section is unrelated airport B-roll footage"]

═══════════════════════════════════════════════
```

After all segments, output a summary:

```
═══════════════════════════════════════════════
SUMMARY
═══════════════════════════════════════════════

Video title:    [title if known]
Total duration: [X:XX:XX]
Segments found: [N]
Total clip time: [X min X sec] out of [total duration]

VIDEO CLASSIFICATION:
  Major scene:  [scene key] [中文名]
  Sub-scene:    [sub_scene_key] [中文名]
  Confidence:   HIGH / MEDIUM / LOW
  Reclassify?:  [No / Yes → suggested_scene/sub_scene with reason]

RECOMMENDED CLIP ORDER (by teaching value):
  1. Segment [X]: [title] — ⭐[score] — [duration]
  2. Segment [Y]: [title] — ⭐[score] — [duration]
  ...

SEGMENTS SKIPPED AND WHY:
  - [timestamp range]: [reason, e.g., "Blogger intro, talking to camera, no dialogue"]
  - [timestamp range]: [reason, e.g., "Background music with text overlay, no speech"]
  - [timestamp range]: [reason, e.g., "Conversation about unrelated topic (food recommendations)"]

ALL KEY EXPRESSIONS (deduplicated, sorted by teaching value):
  1. "[expression]" — [Chinese] — Segment [X] at [timestamp]
  2. "[expression]" — [Chinese] — Segment [Y] at [timestamp]
  ...
```

## Critical rules

1. **NEVER recommend cutting mid-conversation.** If a question is asked at 1:42 and answered at 1:48, the segment must include both. If unsure whether a response is complete, extend the segment to the next clear boundary.

2. **NEVER recommend a segment shorter than 20 seconds.** Too short to provide context. If a valuable exchange is under 20 seconds, extend to the nearest natural boundary.

3. **NEVER recommend a segment longer than 3 minutes.** If a valuable conversation runs longer, suggest splitting it at a topic change within the conversation, and note this explicitly.

4. **Always explain WHY a cut point is safe.** The user will be manually cutting the video — they need to know "cut here because the officer finishes speaking and there's a 2-second pause before the next topic."

5. **Flag risky cut points.** If there's no perfect boundary and you're recommending the best available option, say so: "⚠ This cut point is not ideal — the speaker trails off mid-thought at [timestamp]. Consider extending to [timestamp] where there's a cleaner pause."

6. **Consider the student's perspective.** A segment about a border officer asking "Where will you be staying?" is high value. A segment about airport architecture is zero value. Always ask: "Would a Chinese student about to fly to the UK find this useful or interesting?"

7. **Identify speakers.** If the subtitle doesn't identify speakers, infer from context (question-asker vs answerer, formal vs informal tone) and label them in your output (e.g., "Officer:", "Student:", "Doctor:", "Receptionist:").

8. **Group related segments.** If two clips from the same video naturally form a sequence (e.g., "checking in" then "going through security"), note this so the user can use them as Video 1 and Video 2 within the same scene.

## Handling edge cases

### Video has no dialogue (narration only)
Report: "This video is narration/monologue with no interactive dialogue. Not recommended for Eversay's conversation practice format. However, the following expressions from the narration may be useful for keyPhrases: [list]."

### Video has dialogue but not in the target scene
Report: "This video contains dialogue but it does not match the [scene] category. The dialogue is about [actual topic]. Segments may be useful for [alternative scene] instead."

### Subtitles are auto-generated and messy
Note this at the top of the report: "⚠ These subtitles appear to be auto-generated. Timestamps may be off by 1-3 seconds. Recommend verifying cut points visually." Then proceed with analysis, adding ±2 second buffers to all recommended cut points.

### Multiple languages in subtitles
Only analyze English segments. Note: "Subtitles contain [language] sections which have been skipped."

## Example usage

User: "Here's the subtitle file for a video about arriving at Heathrow. Which parts should I clip?"

→ Parse the subtitles
→ Identify all dialogue segments
→ Score each segment
→ Output the recommendation report with exact timestamps, cut point safety notes, and key expressions
→ User watches the video at the recommended timestamps, verifies the cut points, and manually clips
