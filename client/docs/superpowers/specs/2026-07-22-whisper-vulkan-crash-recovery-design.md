# Whisper Vulkan 崩溃自动恢复设计

## 背景与根因

Windows 用户解析本地视频时，`whisper-cli` 以 `-1073741819`
（`0xC0000005`，原生访问异常）退出。完整 stderr 为：

```text
whisper_init_from_file_with_params_no_state: loading model from '...ggml-base.bin'
whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: flash attn = 1
whisper_init_with_params_no_state: gpu_device = 0
whisper_init_with_params_no_state: dtw        = 0
ggml_vulkan: Found 2 Vulkan devices:
ggml_vulkan: 0 = Intel(R) UHD Graphics ...
ggml_vulkan: 1 = NVIDIA GeForce MX350 ...
```

日志停在 Vulkan 枚举双显卡之后，没有出现 `devices =`、`backends =` 或
`whisper_model_load: loading model`。因此程序尚未读取模型内容，崩溃发生在 Vulkan
后端注册阶段，不是视频、音轨或 `ggml-base.bin` 损坏。

上游 `whisper-cli` 在 `main()` 的第一步调用 `ggml_backend_load_all()`，早于命令行参数
解析。因此仅追加 `-ng` 仍会加载并枚举 Vulkan，不能可靠绕过本次崩溃。上游支持
`GGML_DISABLE_VULKAN`；设置该环境变量后再配合 `-ng`，才能进入真正的 CPU-only 路径。

本机已用当前打包 sidecar、已有 tiny 模型和真实音频验证：

- `GGML_DISABLE_VULKAN=1`；
- 参数包含 `-ng`；
- 日志显示 `Vulkan backend disabled` 和 `use gpu = 0`；
- CPU 转录完成，退出码为 0。

## 目标

1. 用户遇到 Vulkan 原生崩溃时，客户端自动改用 CPU 完成同一解析任务。
2. 不要求用户更新驱动、切换显卡、验证模型、修改设置或手动重试。
3. 同一次 App 会话确认 Vulkan 不稳定后，后续任务直接使用 CPU，避免每个视频先崩一次。
4. UI 显示准确的自动降级信息，不再把错误归因于本地视频文件。
5. 保留正常设备上的 GPU 加速行为。

## 非目标

- 不删除、重命名或重新下载任何 Whisper 模型。
- 不改变用户选择的 tiny、base、small、medium 或 large-v3 型号。
- 不永久关闭 GPU；重启 App 后允许重新探测，便于驱动更新后恢复加速。
- 不对所有子进程错误进行 CPU 重试。

## 崩溃识别

新增纯函数识别“可进行 CPU 恢复的 Whisper 崩溃”。必须同时满足：

1. 错误来自 `whisper-cli`；
2. Windows 退出码是 `-1073741819`；
3. 当前尝试启用了 GPU。

stderr 中出现 `ggml_vulkan:` 作为诊断信息记录，但不作为硬性条件。这样既覆盖当前的
Vulkan 注册崩溃，也覆盖模型加载成功后发生的同类 GPU 原生访问异常。

其他退出码、取消操作、watchdog stall 和 CPU 尝试失败均不触发第二次降级。

## CPU-only 启动方式

`run_whisper_once` 接收明确的执行模式：

- **GPU 模式**：保持现有参数、设备固定逻辑和 Vulkan 环境变量。
- **CPU 模式**：
  - 参数追加 `-ng`；
  - 环境变量设置 `GGML_DISABLE_VULKAN=1`；
  - 不设置 `GGML_VK_VISIBLE_DEVICES`；
  - 不执行 GPU 设备发现和固定。

同时设置环境变量和参数是必要条件：环境变量阻止程序在参数解析前加载 Vulkan，`-ng`
确保 Whisper 上下文不尝试选择其他 GPU 后端。

## 自动恢复状态机

1. App 会话开始时，Vulkan 状态为“未知/可尝试”。
2. 首次转录按现有 GPU 逻辑运行。
3. 若成功，保持 GPU 路径。
4. 若返回目标访问异常：
   - 通过流水线日志提示 `显卡加速启动异常，已自动切换 CPU 继续识别`；
   - 将进程内原子状态标记为“本会话禁用 Vulkan”；
   - 将转录进度重置为 0；
   - 使用 CPU-only 模式从同一音频重新运行一次。
5. CPU 成功后正常生成字幕，后续转录直接使用 CPU-only 模式。
6. CPU 失败时返回包含 GPU 原始错误和 CPU 错误摘要的单一错误，不再重试。
7. 重启 App 后原子状态恢复为默认值，允许再次尝试 GPU。

现有 stall 自动恢复继续保留：GPU 或 CPU 模式各自最多使用现有的两次 stall 重试；访问
异常导致的 GPU → CPU 切换最多一次，不会形成循环。

## 并发

会话级 Vulkan 禁用标记使用进程内 `AtomicBool`：

- 任一任务确认 Vulkan 崩溃后立即置位；
- 新启动的任务读取到该状态后直接使用 CPU；
- 已经并发运行的 GPU 子进程不被强行中止，但它若以同一退出码失败，也只进行一次 CPU
  恢复。

该状态不写入设置文件，避免一次旧驱动故障永久关闭 GPU。

## 日志与错误展示

自动恢复成功时仅在解析进度日志中显示降级说明，不弹失败窗口。后端状态显示为
`CPU（GPU 异常，已自动降级）`。

只有 CPU 重试也失败时才显示错误。前端优先识别组合错误并展示：

- GPU/Vulkan 初始化失败；
- 客户端已自动尝试 CPU；
- CPU 仍未完成识别；
- 建议更新 Intel/NVIDIA 显卡驱动或联系支持并复制详细日志。

此时不显示“视频文件本身有问题”作为首要原因。普通 ffmpeg、无音轨和文件读取错误仍沿用
现有本地视频排查清单。

## 测试

Rust 单元测试覆盖：

1. 精确访问异常可触发 CPU 恢复；
2. 其他退出码、取消和 stall 不触发 CPU 恢复；
3. CPU 参数包含 `-ng`，GPU 参数不包含；
4. CPU 环境包含 `GGML_DISABLE_VULKAN=1` 且不包含设备固定；
5. GPU 模式保持现有设备固定行为；
6. 会话禁用标记置位后，新任务直接选择 CPU；
7. CPU 失败后不进行第三次尝试；
8. 组合错误同时保留 GPU 和 CPU 摘要。

前端测试覆盖 GPU+CPU 组合失败优先显示显卡恢复说明，而不是通用视频损坏清单。

最终验证运行目标 Rust 测试、完整 `cargo test`、目标前端测试、完整 Vitest、TypeScript
类型检查和 `cargo build`。实现完成后先保持本地，不主动触发 CI。
