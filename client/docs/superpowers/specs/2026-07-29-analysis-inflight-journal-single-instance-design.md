# 分析逐条持久化与 whatSub 单实例设计

## 背景

当前视频分析以 50 条字幕为一个事务批次。模型流式返回的有效字幕会立即显示为预览，但只有整批 50 条全部解析成功后，`analysis.json` 才会推进 checkpoint。用户在一批完成前点击停止，或者直接结束 whatSub 进程时，本批已经显示但尚未提交的字幕会被丢弃；重启后只能从上一批 checkpoint 继续。

现有架构已经具备三层并发保护：

- 前端 `localSessionSlots` 保证同一 JavaScript 进程内同一个视频只有一个分析会话；
- Rust `AnalysisStore` 为会话签发 lease，并校验 transcript generation、transcript fingerprint 与 revision；
- `analysis.json` 通过临时文件和原子替换发布，避免半写入快照。

这些保护不能保存当前未满 50 条的批次，也不能阻止用户同时启动两个 whatSub 进程。后者会让两个进程拥有彼此不可见的内存 lease，并同时操作同一语料库目录。

## 目标

1. 模型每返回一条通过校验的字幕，就先可靠写盘，再把它显示为“已保存”的流式结果。
2. 用户点击暂停、额度耗尽、网络失败或进程被强制结束后，重新继续时只请求尚未保存的字幕。
3. 保留每 50 条更新一次正式 `analysis.json` checkpoint 的批次事务，不把主快照改成每条重写。
4. whatSub 在同一用户会话中只允许一个桌面进程运行；第二次启动只唤醒已有窗口。
5. 重置解析、重新转录、删除视频和云端覆盖等破坏性操作不会复活旧的临时分析。

## 非目标

- 不修改每批 50 条的模型请求上限。
- 不对 summary 阶段做逐字段持久化；summary 失败或中断时重新请求整份 summary。
- 不引入数据库、追加式事件日志或跨进程文件锁。
- 不承诺保存模型尚未完整输出、尚未通过结构和内容校验的文本。
- 不改变 DeepSeek 重试、配额判断或正式 checkpoint 的业务语义。

## 总体架构

每个视频目录保留两个不同职责的文件：

- `analysis.json`：正式、可对外读取和同步的分析快照。每完成一批字幕或 summary 后原子更新。
- `analysis.inflight.json`：当前字幕批次的本地恢复 journal。只保存已经通过校验、但尚未进入正式 checkpoint 的字幕。

`analysis.json` 仍是语料库、云同步、导出和 Agent 工具的唯一权威快照。`analysis.inflight.json` 只由分析会话打开、写入、恢复和清理，不参与云同步，也不作为“分析完成”的判断依据。

应用层另外接入 Tauri 官方 Single Instance 插件。单实例从源头阻止两个 Rust 后端同时持有不同的内存 lease，因此本方案不再增加跨进程文件锁。现有 lease、generation、fingerprint 和 revision 校验仍保留，用来抵御同一进程中的过期异步回调以及崩溃恢复后的旧数据。

## Journal 数据模型

`analysis.inflight.json` 使用带版本号的完整 JSON 对象，而不是 JSONL：

```json
{
  "version": 1,
  "journalId": "random-id",
  "transcriptGeneration": "sha256:...",
  "transcriptFingerprint": "sha256:...",
  "analysisStyle": "colloquial",
  "baseRevision": 3,
  "startCueOffset": 150,
  "endCueOffset": 200,
  "entries": [
    {
      "cueOffset": 150,
      "subtitle": { "time": 157.46, "endTime": 162.5, "text": "validated cue", "...": "validated fields" }
    }
  ]
}
```

约束如下：

- `journalId` 在一批 journal 首次创建时生成；当前 Rust lease 绑定该 ID，过期回调不能覆盖新 journal。
- `baseRevision` 必须等于当前正式 checkpoint 的 revision。
- `startCueOffset` 必须等于正式 checkpoint 的 `nextCueOffset`。
- `endCueOffset` 是该批的固定右边界，范围不得超过字幕总数。
- `entries` 以输入数组中的 `cueOffset` 为主键，而不是 SRT 的 `index`。这样即使源字幕存在重复 index，也不会覆盖另一条输入。
- 每个 offset 只能出现一次，必须落在 `[startCueOffset, endCueOffset)` 内。
- journal 绑定 transcript generation、语义 fingerprint 和分析风格；任一不匹配都不能恢复。
- 只保存经 `validateCueOutput` 正规化后的 `Subtitle`，不保存原始模型 JSON 行、残缺文本或解析错误。

Rust 在反序列化前拒绝超过 8 MiB 的 journal；`entries` 数量不得超过批次跨度且最多为 50，每个序列化后的 entry 不得超过 256 KiB。超限或结构非法的文件按损坏 journal 处理，不能导致无限内存占用或阻塞视频打开。

## 会话接口与所有权

Rust 会话接口扩展为以下职责：

- begin 命令除 `videoId / reset / expectedGeneration` 外接收当前 `analysisStyle`，返回正式 analysis、lease、transcript generation 和可选 journal。
- 新增 journal save 命令，参数包含 `videoId / lease / journal`。它只接受当前 lease，并把首次成功写入的 `journalId` 绑定到活动 lease。
- 同一 journal 的后续保存必须是单调追加：已有 offset 不能消失，已有 subtitle 不能被改写，新 entry 只能增加。完全相同的重复保存按幂等成功处理。
- 正式 `save_analysis_session` 在 checkpoint 越过活动 journal 后，负责把该 journal 标记为已提交并尽力删除文件。删除失败不回滚、也不把已经成功的正式提交报告为失败；残留文件由下次 begin 的 stale 检查清理。
- end session 只释放 lease，不删除 journal。暂停和普通错误因此可以恢复。

Rust 能直接验证 transcript generation、正式 checkpoint 元数据、journal 边界和磁盘大小。语义 fingerprint 需要前端解析 cues 后才能完整复核：begin 在正式 checkpoint 已有 fingerprint 时先做一致性检查；无正式 checkpoint 的首批 journal 则由前端用 `prepareAnalysis` 计算出的 fingerprint 校验后再采用。前端拒绝后调用受 lease 保护的清理路径，不能把不匹配 entries 发布为预览。

## 打开与恢复流程

`begin_analysis_session_from_transcript` 在持有 `AnalysisStore` mutex 时完成以下步骤：

1. 读取 `transcript.srt`，计算 transcript generation。
2. 恢复并校验正式 `analysis.json`。
3. 读取 `analysis.inflight.json`；文件不存在时正常继续。
4. 校验 journal 的版本、大小、generation、可用的 canonical fingerprint、style、base revision、批次边界和 offset 唯一性。
5. 如果正式 checkpoint 已经越过该批，说明进程曾在提交正式快照后、删除 journal 前退出。此 journal 已经成功提交，静默删除并忽略。
6. 如果 journal 与当前 transcript 或 checkpoint 不匹配，静默忽略并尽力删除；删除失败也不采用它，绝不拼接到新分析。
7. 有效 journal 随 session start 一起返回，并绑定到新签发的 lease；新进程可以接管这个 journal，而不是要求沿用崩溃前的内存 lease。

前端收到有效 journal 后，把 entries 注入当前批次的 `resolved` 集合。后续模型请求只包含没有 journal entry 的 offset；已保存条目不会再次发送给模型。

## 流式写入顺序

模型流每产生一组完整 JSON 行时：

1. 同步解析并运行现有 `validateCueOutput`。
2. 将新通过校验的结果映射到对应 `cueOffset`，合并到内存 journal。
3. 调用 Rust 命令保存完整、累计的 journal；Rust 校验 lease、journal ID、transcript generation 和 base revision，并通过临时文件原子替换。
4. 只有 Rust 返回成功后，前端才发布新的流式预览和“本批已保存”计数。
5. journal 写入失败时立即停止当前分析并显示可操作错误；不得把未落盘结果伪装为已保存。

JSON line parser 的回调仍保持同步，只负责收集新结果。每次处理完 provider chunk 后，执行器顺序等待一次累计 journal 写入，再读取下一块流数据。一个 chunk 含多条有效字幕时可以一次原子写入这些字幕，但它们必须在写入成功后一起显示。

用户点击暂停时，已经开始的 journal 写入不被取消；应用等待该次短写入完成后停止 provider 流。因此暂停瞬间最多会多保存刚刚完成校验的一条或一小组字幕，不会少保存已经显示为持久化的字幕。

## 批次提交与崩溃窗口

当 `[startCueOffset, endCueOffset)` 全部存在有效 entry 后：

1. 按 `cueOffset` 排序重建完整批次。
2. 通过现有 `save_analysis_session` 原子提交新的 `analysis.json` 和递增 revision。
3. Rust 在确认 checkpoint 已越过活动 journal 后尽力删除 `analysis.inflight.json`；清理失败不改变正式提交结果。
4. 清空预览并开始下一批。

提交顺序必须是“正式快照在前，删除 journal 在后”。如果进程在两者之间退出，重启时会发现正式 checkpoint 已越过 journal，对 journal 做幂等清理，不会重复追加字幕。如果正式保存失败，journal 保留，用户下次仍可从本批恢复。

## 暂停、错误和恢复语义

- 点击现有停止按钮等同于“暂停解析”，保留正式 checkpoint 与有效 journal。
- 正常关闭窗口、网络错误、DeepSeek 重试耗尽和 Pro 配额耗尽同样保留 journal。
- 强制结束 whatSub 进程后，原子写入成功的 entries 保留；尚未形成有效 JSON 或尚未写盘的内容不保证保留。
- 继续解析时先恢复 journal，再请求缺失 offset；已完成的下载、Whisper、正式批次和 journal entry 均不重复执行。
- summary 阶段没有 inflight journal；失败后保留全部字幕 checkpoint，只重跑 summary。
- journal 写盘失败、磁盘空间不足或权限错误时，界面明确提示“当前新增字幕未能保存，解析已暂停”，并保留上一次成功写入的 journal。

## 破坏性操作与清理

以下操作继续通过 Rust `AnalysisStore` 的 destructive boundary 撤销活动 lease，并扩展为处理 journal：

- 重新开始解析：删除正式 analysis 快照及其恢复工件，同时删除 journal 及其临时工件。
- 重新转录：旧 transcript 对应的 journal 必须失效并清理。
- 删除视频：删除整个视频前先撤销会话；journal 随目录删除。
- 云端或桌面替换 transcript + analysis：只有新 materialized snapshot 成功发布后才清理旧 journal；若替换失败并回滚到旧 transcript，原 journal 仍可恢复。
- 单独删除分析：同时删除正式 snapshot artifacts 和 journal artifacts。

即使清理文件失败，lease 也先撤销，旧生产者不能继续写入。下次打开时仍通过 generation、fingerprint 和 revision 校验 fail closed，不会复活不匹配的 journal。

## 单实例行为

接入 `tauri-plugin-single-instance`，并按 Tauri 要求把它注册为 Builder 的第一个插件。

第二次启动 whatSub 时：

1. 不创建第二个业务后端，也不运行下载、分析或迁移初始化。
2. 找到标签为 `main` 的现有窗口。
3. 如果窗口隐藏则显示，如果最小化则恢复，然后置于前台并聚焦。
4. 第二个启动进程随后退出。

单实例也覆盖“开发版和安装版指向同一应用数据目录”的场景，避免它们同时操作 `%APPDATA%/whatsub`。更新流程必须先退出旧应用，再启动新版；回归测试要覆盖更新重启，防止新版启动过早而只唤醒旧版本。

进程异常终止后，操作系统会释放单实例所有权，用户可以正常重新启动。单实例不替代 journal 的数据身份校验，因为磁盘上仍可能存在崩溃前的旧文件。

## 用户界面

- 分析中的停止操作使用“暂停解析”语义；现有关闭/导航行为继续自动暂停。
- 进度可区分“正式完成 N 条”和“本批已保存 M/50 条”，避免用户误以为只有正式 checkpoint 才写盘。
- 暂停后显示“已保存到第 N 条，其中当前批次 M 条将在继续后接着完成”。
- 恢复时无需弹出额外确认，直接从 journal 缺口继续。
- 第二次启动不显示报错；用户只看到已有窗口被唤醒。

如果界面空间不适合同时显示两个数字，至少把总进度计算为 `正式条数 + journal 条数`，并在暂停提示中明确该总数已经保存。

## 测试设计

### 前端单元测试

1. 已有 23 条 journal entry 时，只向 provider 请求其余 27 条。
2. 新结果必须在 journal save promise 成功后才触发预览。
3. journal save 失败时不显示未保存结果，并停止当前批次。
4. SRT index 重复时，按 cue offset 保存和恢复，不发生覆盖。
5. 暂停发生在写入中时，等待该次写入并保留最新成功预览。
6. 批次正式提交失败时保留 journal；正式提交成功后即使 journal 物理删除失败也继续使用新 checkpoint。
7. 恢复 journal 后仍能正确进入 summary，summary 中断只重跑 summary。

### Rust 单元测试

1. journal 原子写入失败时保留旧的完整文件。
2. lease、journal ID、generation、fingerprint、style 或 base revision 不匹配时拒绝写入。
3. 正式 checkpoint 已越过 journal 时把它视为已提交残留并尽力清理，清理失败不回退 checkpoint。
4. 损坏 JSON、未知版本、重复/越界 offset、超限文件和超长字段均安全忽略或拒绝。
5. reset、delete、retranscribe 和成功 materialized replacement 清理 journal。
6. materialized replacement 失败并回滚时保留仍与旧 transcript 匹配的 journal。
7. 旧 lease 在 destructive boundary 后不能保存 journal。

### 集成与人工回归

1. 在一批处理到约 23/50 时点击暂停，重启后只补剩余 27 条。
2. 在相同位置通过任务管理器强制结束，重启后总进度不倒退到上一批。
3. 模拟正式 `analysis.json` 已提交但 journal 未删除，重启不出现重复字幕。
4. 前台转后台、后台转前台以及额度耗尽恢复后，journal 继续归属于同一视频和 transcript。
5. 连续双击应用、应用最小化后再次启动、窗口隐藏后再次启动，都只保留一个进程并唤醒主窗口。
6. Windows 与 macOS 的安装包更新完成后能退出旧进程并成功拉起新版。

## 验收标准

- 用户看见的每条“已保存”字幕都已经进入正式快照或有效 journal。
- 一批未满 50 条时暂停或强杀，重新继续不会重复请求已经写入 journal 的字幕。
- 任何 stale、损坏或不匹配 journal 都不会污染 `analysis.json`。
- 正式批次提交保持原子、幂等，崩溃窗口不会导致字幕重复或 checkpoint 回退。
- 破坏性操作不会让旧 journal 在新 transcript、新分析或云端替换后复活。
- 同一系统用户不能同时运行两个 whatSub 业务进程；第二次启动只聚焦现有窗口。
- 前端测试、Rust 测试、类型检查和现有完整回归套件全部通过。
