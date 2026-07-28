import { describe, expect, it } from "vitest";
import { KEY_HELP } from "./firstRunKeyHelp";

describe("first-run key help", () => {
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
});
