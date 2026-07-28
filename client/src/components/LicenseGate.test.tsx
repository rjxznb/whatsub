import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mockUseLicense = vi.hoisted(() => vi.fn());

vi.mock("../store/license", () => ({
  useLicense: mockUseLicense,
}));

import { LicenseGate } from "./LicenseGate";

describe("LicenseGate", () => {
  it("shows the current subscription prices in the email login card", () => {
    mockUseLicense.mockReturnValue({
      mode: "NEEDS_KEY",
      init: vi.fn(),
      activate: vi.fn(),
      activating: false,
      error: null,
      clearError: vi.fn(),
      trial: null,
      trialFetchError: null,
      resumeTrial: vi.fn(),
    });

    render(<LicenseGate>protected content</LicenseGate>);

    fireEvent.click(screen.getByRole("button", { name: /邮箱登录/ }));
    const copy = screen.getByText(/订阅了 whatSub Pro/);
    expect(copy).toHaveTextContent("月度 ¥38 / 年度 ¥348");
    expect(copy).not.toHaveTextContent("¥22");
    expect(copy).not.toHaveTextContent("¥168");
  });
});
