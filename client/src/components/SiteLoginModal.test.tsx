import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const startLogin = vi.fn();
vi.mock("../hooks/useSiteLogin", () => ({
  useSiteLogin: () => ({
    presets: [], browsers: [], selectedBrowser: "", setSelectedBrowser: vi.fn(),
    pendingLogin: null, starting: false, savingLogin: false, loginError: null,
    startLogin, finishLogin: vi.fn(), cancelLogin: vi.fn(),
  }),
}));

import { SiteLoginModal } from "./SiteLoginModal";

beforeEach(() => startLogin.mockReset());

describe("SiteLoginModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<SiteLoginModal open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("starts login for the action's site on confirm", () => {
    render(
      <SiteLoginModal
        open
        action={{ kind: "login-site", siteKey: "youtube", siteLabel: "YouTube", loginUrl: "https://youtube.com/", harvestDomains: ["youtube.com"] }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /登录 YouTube/ }));
    expect(startLogin).toHaveBeenCalledWith({
      key: "youtube", label: "YouTube", loginUrl: "https://youtube.com/", harvestDomains: ["youtube.com"],
    });
  });
});
