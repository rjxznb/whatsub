import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserBubble } from "./UserBubble";
import type { UserMessage } from "../../types/agent";

const baseMsg: UserMessage = {
  role: "user",
  id: "u1",
  ts: 1700000000000,
  content: "Hello, agent!",
};

describe("UserBubble", () => {
  it("renders the user message content", () => {
    render(<UserBubble msg={baseMsg} />);
    expect(screen.getByText("Hello, agent!")).toBeTruthy();
  });

  it("applies right-alignment via justify-end", () => {
    const { container } = render(<UserBubble msg={baseMsg} />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain("justify-end");
  });
});
