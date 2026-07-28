# Import、登录与首次配置错误体验实施计划

> **执行要求：** 使用 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 逐项执行；每个任务严格遵循红灯测试 → 最小实现 → 绿灯测试 → 小提交。不得合并或修改暂停中的 `codex/ytdlp-watchdog` 工作树。

**目标：** 将 yt-dlp 的确定性不支持链接错误准确呈现给用户，补全 DeepSeek 首次配置教程，并让邮箱验证码登录在不重复消费验证码的前提下安全恢复建连失败、统一显示中文错误。

**架构：** 下载错误继续由 `friendlyError()` 单点分类；首次配置教程只调整 DeepSeek 数据；认证后端把 reqwest 错误收敛成稳定错误码，并通过可测试的“仅连接错误重试”执行器控制重试；两个登录入口复用同一个前端错误文案模块，但保留各自现有 UI 和成功流程。

**技术栈：** Rust、reqwest 0.12、Tokio、Tauri 2、React 19、TypeScript、Vitest、Testing Library。

**设计规格：** `docs/superpowers/specs/2026-07-28-import-auth-onboarding-errors-design.md`

---

## Task 1：统一识别所有 yt-dlp `Unsupported URL`

**文件：**

- 修改：`client/src/utils/friendlyError.test.ts`
- 修改：`client/src/utils/friendlyError.ts`
- 修改：`client/src/components/DownloadQueueWidget.test.tsx`

### Step 1：先写失败的分类器测试

在 `friendlyError download diagnosis` 中添加任意非 Apple Music 域名的测试，证明规则与域名无关：

```ts
it("classifies every yt-dlp Unsupported URL as deterministic", () => {
  const result = friendlyError(
    "yt-dlp exit 1\nERROR: Unsupported URL: https://example.invalid/media/42",
    "downloading",
    "https://example.invalid/media/42",
  );

  expect(result.title).toBe("暂不支持该链接");
  expect(result.suggestion).toBe(
    "当前下载工具无法解析这个链接。请换一个受支持的视频链接，或先下载为本地音视频文件后再导入。",
  );
  expect(result.details).toContain("Unsupported URL");
  expect(result.generic).not.toBe(true);
  expect(result.retryable).not.toBe(true);
  expect(result.loginRequired).not.toBe(true);
  expect(result.action).toBeUndefined();
});
```

再用小写 `unsupported url` 添加一个断言，锁定大小写不敏感。

### Step 2：运行目标测试并确认红灯

在 `client` 目录执行：

```powershell
pnpm test -- src/utils/friendlyError.test.ts
```

预期：新测试失败，当前返回“下载视频失败”或“处理视频源失败”。

### Step 3：实现最小分类规则

在 `classifyError()` 完成 `txt`/`normalized` 预处理之后、所有网络/Cookie/格式和通用 yt-dlp 分支之前添加：

```ts
if (txt.includes("unsupported url")) {
  return {
    title: "暂不支持该链接",
    suggestion:
      "当前下载工具无法解析这个链接。请换一个受支持的视频链接，或先下载为本地音视频文件后再导入。",
    details: raw,
  };
}
```

不要根据 Apple Music 或其他域名建立白名单，也不要设置重试、登录或 generic 标记。

### Step 4：补后台队列行为测试

在 `DownloadQueueWidget.test.tsx` 渲染 `FailedActions`，传入 `Unsupported URL` 和任意 URL，断言：

- 显示“暂不支持该链接”；
- 不显示“立即登录”；
- 保持现有“重试”交互不变，不因本分类器修复调整队列按钮策略。

### Step 5：运行目标测试并提交

```powershell
pnpm test -- src/utils/friendlyError.test.ts src/components/DownloadQueueWidget.test.tsx
pnpm typecheck
git add client/src/utils/friendlyError.ts client/src/utils/friendlyError.test.ts client/src/components/DownloadQueueWidget.test.tsx
git commit -m "fix(import): explain unsupported links directly"
```

---

## Task 2：将 DeepSeek 教程改为独立五步

**文件：**

- 修改：`client/src/components/FirstRunGate.tsx`
- 新增：`client/src/components/firstRunKeyHelp.ts`
- 新增：`client/src/components/FirstRunGate.keyHelp.test.ts`

### Step 1：先写教程数据的失败测试

添加数据级测试，导入尚不存在的 `firstRunKeyHelp.ts`：

```ts
import { describe, expect, it } from "vitest";
import { KEY_HELP } from "./firstRunKeyHelp";

it("shows DeepSeek setup as five independent steps", () => {
  const steps = KEY_HELP.deepseek.steps.map((step) => step.text);
  expect(steps).toEqual([
    "用手机号注册并登录 DeepSeek 开放平台（国内直连，无需梯子）",
    "左侧菜单点「API keys」→ 点「创建 API key」",
    "名字填「whatsub」→「创建」，复制弹窗里出现的密钥（仅显示一次）",
    "前往「充值」页面，充值 5 块钱就够用",
    "回到 whatSub 粘贴密钥，然后点击「保存并验证」",
  ]);
  expect(steps.join(" ")).not.toContain("至少 5 元");
  expect(steps.join(" ")).not.toContain("余额为 0");
});
```

### Step 2：运行测试并确认红灯

```powershell
pnpm test -- src/components/FirstRunGate.keyHelp.test.ts
```

预期：教程配置模块尚不存在，测试失败。

### Step 3：抽取教程配置并替换 DeepSeek 五步数据

将 `KeyHelpStep`、`KeyHelp` 和完整 `KEY_HELP` 从 `FirstRunGate.tsx` 原样移动到 `firstRunKeyHelp.ts` 并导出；组件从新模块导入。只替换 `KEY_HELP.deepseek.steps`，使用测试中的精确文案；其他供应商配置逐字保持不变，不复制两份数据。

### Step 4：验证并提交

```powershell
pnpm test -- src/components/FirstRunGate.keyHelp.test.ts
pnpm typecheck
git add client/src/components/FirstRunGate.tsx client/src/components/firstRunKeyHelp.ts client/src/components/FirstRunGate.keyHelp.test.ts
git commit -m "fix(onboarding): clarify DeepSeek recharge step"
```

---

## Task 3：建立共享的认证中文错误映射

**文件：**

- 新增：`client/src/utils/authError.ts`
- 新增：`client/src/utils/authError.test.ts`
- 修改：`client/src/components/AccountLoginDialog.tsx`
- 修改：`client/src/components/LicenseGate.tsx`

### Step 1：先写共享映射的失败测试

测试业务 reason 与命令异常两类输入：

```ts
expect(authReasonToChinese("wrong_code")).toBe("验证码错误");
expect(authReasonToChinese("too_many_attempts")).toBe("尝试次数过多，请重新获取验证码");
expect(authCommandErrorToChinese("auth_connect_failed")).toBe(
  "无法连接登录服务器，请检查网络或代理后重试。",
);
expect(authCommandErrorToChinese("auth_result_uncertain")).toBe(
  "登录结果未确认，请再次尝试；如果验证码已失效，请重新获取。",
);
expect(authCommandErrorToChinese("auth_protocol_error")).toBe(
  "登录服务器返回异常，请稍后重试。",
);
expect(authCommandErrorToChinese("error sending request for url (secret-url)")).not.toContain(
  "secret-url",
);
```

未知命令异常使用固定中文兜底，不把 URL、reqwest 文案或内部错误直接展示给用户。发送验证码可通过参数选择“发送验证码失败，请稍后重试。”兜底，但三种稳定认证错误码仍使用统一文案。

### Step 2：运行测试并确认红灯

```powershell
pnpm test -- src/utils/authError.test.ts
```

预期：模块尚不存在或导出缺失。

### Step 3：实现纯函数映射

在 `authError.ts` 中集中实现并导出：

- `authReasonToChinese(reason?: string): string`
- `authCommandErrorToChinese(error: unknown, operation?: "send" | "verify"): string`

将两个组件现有 `reasonToChinese()` 的业务原因并集迁入共享模块；删除两份本地函数。对 `catch` 分支使用 `authCommandErrorToChinese()`，不再拼接 `String(error)`。

### Step 4：运行目标测试和类型检查

```powershell
pnpm test -- src/utils/authError.test.ts
pnpm typecheck
```

### Step 5：提交

```powershell
git add client/src/utils/authError.ts client/src/utils/authError.test.ts client/src/components/AccountLoginDialog.tsx client/src/components/LicenseGate.tsx
git commit -m "fix(auth): localize transport errors consistently"
```

---

## Task 4：Rust 端仅重试验证码验证的建连失败

**文件：**

- 修改：`client/src-tauri/src/commands/auth.rs`

### Step 1：先添加可控重试执行器测试

在 `auth.rs` 的 `#[cfg(test)] mod tests` 中为一个可注入 operation/sleeper 的异步辅助函数写测试：

1. 前两次返回 `AuthHttpError::Connect`、第三次成功：operation 调用三次，记录延迟恰为 `[500ms, 1500ms]`。
2. 三次均为 `Connect`：返回 `auth_connect_failed`。
3. `Uncertain`：只调用一次，不 sleep，返回 `auth_result_uncertain`。
4. `Protocol`：只调用一次，不 sleep，返回 `auth_protocol_error`。

辅助函数建议签名：

```rust
async fn retry_connect_only<T, Op, OpFuture, Sleep, SleepFuture>(
    operation: Op,
    sleep: Sleep,
) -> Result<T, AuthHttpError>
where
    Op: FnMut() -> OpFuture,
    OpFuture: Future<Output = Result<T, AuthHttpError>>,
    Sleep: FnMut(Duration) -> SleepFuture,
    SleepFuture: Future<Output = ()>;
```

测试用 `std::future::ready` 与 `RefCell` 记录次数和延迟，不访问真实服务器。

### Step 2：运行 Rust 测试并确认红灯

在 `client/src-tauri` 目录执行：

```powershell
cargo test commands::auth::tests -- --nocapture
```

预期：新类型/辅助函数尚不存在，测试编译失败。

### Step 3：建立稳定后端错误类型

添加私有枚举：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthHttpError {
    Connect,
    Uncertain,
    Protocol,
}
```

为其实现 `code()`：

- `Connect` → `auth_connect_failed`
- `Uncertain` → `auth_result_uncertain`
- `Protocol` → `auth_protocol_error`

reqwest 映射规则：

- `error.is_connect()` → `Connect`
- 其余发送/超时/响应读取错误 → `Uncertain`
- JSON 序列化、JSON 解析、成功响应缺字段、HTTP client 构建异常 → `Protocol`

不要保留原始 URL 或英文 reqwest 错误到 Tauri `Err`。

### Step 4：让 `post_json_body` 不再吞掉响应错误

将其返回类型改为：

```rust
Result<(reqwest::StatusCode, serde_json::Value), AuthHttpError>
```

行为要求：

- `.send()` 根据 `is_connect()` 映射；
- `resp.text()` 失败映射为 `Uncertain`，不再 `unwrap_or_default()`；
- `serde_json::from_str()` 失败映射为 `Protocol`，不再静默替换成 `{}`；
- HTTP 4xx/5xx 仍正常返回 status/body，由现有 `map_reason()` 处理，且不重试。

所有现有调用点将 `AuthHttpError` 转为其稳定 code；`VerifyCodeResp` 解析失败也必须映射为 `auth_protocol_error`。

### Step 5：只给 `auth_verify_code` 接入连接重试

使用 `retry_connect_only()` 包裹 `post_json_body()`：

```rust
let result = retry_connect_only(
    || post_json_body(&client, url, body.clone()),
    |delay| tokio::time::sleep(delay),
).await;
```

实际延迟固定为 500ms、1500ms。`auth_send_code`、`auth_me`、`auth_from_license` 不接入此重试器，避免重复发送邮件或扩大请求语义。

### Step 6：运行 Rust 验证并提交

```powershell
cargo fmt --check
cargo test commands::auth::tests -- --nocapture
cargo test
cargo build
git add client/src-tauri/src/commands/auth.rs
git commit -m "fix(auth): retry safe OTP connection failures"
```

---

## Task 5：验证两个登录入口的恢复行为

**文件：**

- 新增：`client/src/components/AccountLoginDialog.test.tsx`
- 新增：`client/src/components/LicenseGate.auth.test.tsx`
- 修改：`client/src/components/LicenseGate.tsx`（具名导出 `SubLoginForm` 供测试）

### Step 1：为账号登录弹窗写行为测试

Mock `useAuth`、`useLicense` 与 portal 环境，完成邮箱提交进入验证码阶段；令 `verifyCode` reject `auth_connect_failed`，断言：

- 显示“无法连接登录服务器，请检查网络或代理后重试。”；
- 原邮箱和 6 位验证码仍保留；
- “正在验证…”消失，登录按钮重新可用；
- 不出现 `error sending request for url`。

### Step 2：为授权门禁登录写相同行为测试

将 `SubLoginForm` 改为具名导出以便直接渲染；mock Tauri `invoke`：发送验证码成功，验证时 reject `auth_result_uncertain`。断言：

- 显示“不确定”对应的中文文案；
- 邮箱/验证码不被清空；
- spinner 停止，按钮可再次点击。

同时测试 `auth_send_code` reject 时显示中文发送失败文案且发送按钮退出 loading；不得自动在前端重复 invoke。

### Step 3：运行测试并修正最小差异

```powershell
pnpm test -- src/components/AccountLoginDialog.test.tsx src/components/LicenseGate.auth.test.tsx
```

组件已有 `catch/finally` 状态恢复逻辑，除共享映射和必要测试导出外不应重写登录流程。

### Step 4：提交

```powershell
pnpm typecheck
git add client/src/components/AccountLoginDialog.test.tsx client/src/components/LicenseGate.auth.test.tsx client/src/components/LicenseGate.tsx
git commit -m "test(auth): cover OTP failure recovery in both gates"
```

---

## Task 6：全量回归与范围审计

**文件：**

- 核验：以上所有修改文件
- 不修改：`.worktrees/ytdlp-watchdog` 及其分支历史

### Step 1：运行前端全量验证

在 `client` 目录执行：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

预期：TypeScript 无错误，Vitest 全绿，Vite 生产构建成功。

### Step 2：运行 Rust 全量验证

在 `client/src-tauri` 目录执行：

```powershell
cargo fmt --check
cargo test
cargo build
```

预期：格式、测试和构建全部通过。

### Step 3：检查改动范围与文案

在仓库根目录执行：

```powershell
git diff --check
rg -n "余额为 0|充至少 5 元|error sending request for url" client/src client/src-tauri/src
git status --short
git log --oneline -8
```

验收标准：

- DeepSeek 教程不再命中旧文案；其他供应商自己的“至少 $5”说明不属于本任务，不得误删。
- 前端用户错误文案不再拼接 reqwest URL；注释或测试样本中的匹配允许保留。
- 状态中只出现本计划的修改和用户原有未跟踪文件，不出现 `codex/ytdlp-watchdog` 的代码。

### Step 4：人工最小冒烟（不触发 CI）

```powershell
pnpm tauri dev
```

依次确认：

1. 导入任意 yt-dlp 不支持的链接，显示“暂不支持该链接”，可展开原始详情。
2. 首次配置 DeepSeek 展开帮助后显示五个独立编号步骤。
3. 断网或配置不可达代理后验证邮箱验证码，有限等待后显示中文网络提示，输入仍保留且可以再次提交。

验证期间若发现问题，返回对应任务完成红灯测试、最小修复与该任务提交；不要用一个无归属的“最终修复”提交掩盖回归。不得 push、merge 或触发 CI，除非用户随后明确要求。

---

## 暂停任务登记

`codex/ytdlp-watchdog` 工作树中的 DeepSeek generation/lifecycle 持久化及后续 Task 5—8 仍为独立待办。本计划完成后不得把其当前 `ce33c97` 直接并入 `main`；恢复时必须先修订其生产者 generation 绑定、后端确认清理和完整语义校验设计。
