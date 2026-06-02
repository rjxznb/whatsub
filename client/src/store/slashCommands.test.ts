import { describe, it, expect, beforeEach } from "vitest";
import { useSlashCommands, SEED_COMMANDS } from "./slashCommands";

beforeEach(() => {
  localStorage.clear();
  // Reset the store to seeds (fresh load).
  useSlashCommands.setState({ commands: [...SEED_COMMANDS] });
});

describe("useSlashCommands", () => {
  it("seeds default commands", () => {
    expect(useSlashCommands.getState().commands.length).toBeGreaterThan(0);
    expect(useSlashCommands.getState().commands.some((c) => c.name === "找视频")).toBe(true);
  });

  it("add / update / remove persist to localStorage", () => {
    const { add } = useSlashCommands.getState();
    add({ name: "测试", description: "d", template: "做 $ARGUMENTS" });
    let added = useSlashCommands.getState().commands.find((c) => c.name === "测试");
    expect(added).toBeTruthy();
    expect(localStorage.getItem("agent.slashCommands")).toContain("测试");

    useSlashCommands.getState().update(added!.id, { template: "改 $ARGUMENTS" });
    added = useSlashCommands.getState().commands.find((c) => c.id === added!.id);
    expect(added!.template).toBe("改 $ARGUMENTS");

    useSlashCommands.getState().remove(added!.id);
    expect(useSlashCommands.getState().commands.find((c) => c.id === added!.id)).toBeUndefined();
  });
});
