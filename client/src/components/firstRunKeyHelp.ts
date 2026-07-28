// Per-vendor "how to get an API key" steps. Shown in an inline help panel
// when the user clicks "密钥传送门🔑" — same UX pattern as the cookies
// tutorial in ImportModal so users don't get yanked to the vendor's site
// without knowing what to do once they're there.
//
// Each step's `screenshot` (optional) refers to a PNG under public/help/
// (e.g. "/help/api-key-deepseek-1.png"). When the file isn't present the
// img tag is skipped so the steps still render as plain text. Drop new
// screenshots in client/public/help/ to enrich any vendor's flow.
export type KeyHelpStep = { text: string; screenshot?: string };
export type KeyHelp = { prereq?: string; steps: KeyHelpStep[] };

export const KEY_HELP: Record<string, KeyHelp> = {
  deepseek: {
    steps: [
      { text: "用手机号注册并登录 DeepSeek 开放平台（国内直连，无需梯子）" },
      { text: "左侧菜单点「API keys」→ 点「创建 API key」" },
      { text: "名字填「whatsub」→「创建」，复制弹窗里出现的密钥（仅显示一次）" },
      { text: "前往「充值」页面，充值 5 块钱就够用" },
      { text: "回到 whatSub 粘贴密钥，然后点击「保存并验证」" },
    ],
  },
  openai: {
    prereq: "🪜 需要梯子（系统级 / TUN 模式，不是浏览器扩展）",
    steps: [
      { text: "登录 platform.openai.com/api-keys（推荐 Google 账号登录）" },
      { text: "点「+ Create new secret key」" },
      { text: "名字填「whatsub」→「Create secret key」→ 复制 sk- 开头的密钥（仅显示一次）" },
      { text: "粘贴回这里。新账号需先在 Billing 绑定信用卡 + 充值至少 $5" },
    ],
  },
  kimi: {
    steps: [
      { text: "注册并登录 Moonshot 开放平台（国内直连）" },
      { text: "左侧「API Key 管理」→「新建」" },
      { text: "名字填「whatsub」→ 复制弹窗里出现的密钥（仅显示一次）" },
      { text: "粘贴回这里。新账号有免费体验额度" },
    ],
  },
  zhipu: {
    steps: [
      { text: "注册并登录智谱 AI 开放平台（国内直连）" },
      { text: "点头像 →「API keys」管理页" },
      { text: "点「添加新的 API Key」→ 名称填「whatsub」→ 复制密钥" },
      { text: "粘贴回这里。glm-4-flash 模型有大量免费额度可白嫖" },
    ],
  },
  qwen: {
    steps: [
      { text: "登录阿里云百炼控制台（需要阿里云账号）" },
      { text: "左侧「API-KEY」→「我的 API-KEY」→ 创建" },
      { text: "名称填「whatsub」→ 复制密钥（仅显示一次）" },
      { text: "粘贴回这里。turbo 模型几分钱就能跑完一个视频" },
    ],
  },
  siliconflow: {
    steps: [
      { text: "注册并登录 SiliconFlow 控制台（国内直连）" },
      { text: "左侧「API 密钥」→「新建 API 密钥」" },
      { text: "描述填「whatsub」→ 复制密钥" },
      { text: "粘贴回这里。注册即送 14 元体验额度" },
    ],
  },
  claude: {
    prereq: "🪜 需要梯子（系统级 / TUN 模式）",
    steps: [
      { text: "登录 console.anthropic.com，没账号先注册" },
      { text: "Settings → API Keys →「Create Key」" },
      { text: "名字填「whatsub」→ Create → 复制 sk-ant- 开头的密钥（仅显示一次）" },
      { text: "粘贴回这里。新账号需先在 Plans & Billing 充值至少 $5" },
    ],
  },
  gemini: {
    prereq: "🪜 需要梯子（且在某些受限地区如香港无法使用）",
    steps: [
      { text: "登录 aistudio.google.com/apikey（需 Google 账号）" },
      { text: "点「Create API key」→ 选一个 Google Cloud 项目（或新建一个）" },
      { text: "复制 AIza- 开头的密钥" },
      { text: "粘贴回这里。flash 模型有大量免费额度，pro 更聪明但收费" },
    ],
  },
};
