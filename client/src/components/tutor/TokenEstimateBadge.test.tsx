import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TokenEstimateBadge } from "./TokenEstimateBadge";

describe("TokenEstimateBadge", () => {
  it("renders token count + vendor pricing when vendor known", () => {
    render(
      <TokenEstimateBadge
        tokens={3200}
        vendorId="deepseek"
        vendorLabel="DeepSeek"
      />,
    );
    expect(screen.getByText(/3,200/)).toBeTruthy();
    expect(screen.getByText(/DeepSeek/)).toBeTruthy();
    expect(screen.getByText(/¥/)).toBeTruthy();
  });

  it("renders only token count when vendor missing from pricing table", () => {
    render(
      <TokenEstimateBadge
        tokens={3200}
        vendorId="mystery"
        vendorLabel="Mystery"
      />,
    );
    expect(screen.getByText(/3,200/)).toBeTruthy();
    // No ¥ symbol when we have no pricing data for this vendor
    expect(screen.queryByText(/¥/)).toBeNull();
  });
});
