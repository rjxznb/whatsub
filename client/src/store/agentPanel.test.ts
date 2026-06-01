import { describe, it, expect } from "vitest";
import {
  useAgentPanel,
  clampNum,
  PANEL_MIN_W,
  PANEL_MAX_W,
  PANEL_MIN_H,
  PANEL_MAX_H,
  INPUT_MIN_H,
  INPUT_MAX_H,
} from "./agentPanel";

describe("agentPanel store", () => {
  it("clampNum clamps to range", () => {
    expect(clampNum(5, 10, 20)).toBe(10);
    expect(clampNum(25, 10, 20)).toBe(20);
    expect(clampNum(15, 10, 20)).toBe(15);
  });

  it("setSize clamps width + height to bounds", () => {
    useAgentPanel.getState().setSize(99999, 99999);
    expect(useAgentPanel.getState().width).toBe(PANEL_MAX_W);
    expect(useAgentPanel.getState().height).toBe(PANEL_MAX_H);
    useAgentPanel.getState().setSize(1, 1);
    expect(useAgentPanel.getState().width).toBe(PANEL_MIN_W);
    expect(useAgentPanel.getState().height).toBe(PANEL_MIN_H);
  });

  it("setInputHeight clamps to bounds", () => {
    useAgentPanel.getState().setInputHeight(99999);
    expect(useAgentPanel.getState().inputHeight).toBe(INPUT_MAX_H);
    useAgentPanel.getState().setInputHeight(0);
    expect(useAgentPanel.getState().inputHeight).toBe(INPUT_MIN_H);
  });
});
