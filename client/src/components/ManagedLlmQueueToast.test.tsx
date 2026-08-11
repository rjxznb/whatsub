import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useManagedQueueStatus } from "../llm/managedQueueStatus";
import { ManagedLlmQueueToast } from "./ManagedLlmQueueToast";

describe("ManagedLlmQueueToast", () => {
  beforeEach(() => useManagedQueueStatus.setState({ waitingCount: 0 }));

  it("renders nothing when no managed request is waiting", () => {
    const { container } = render(<ManagedLlmQueueToast />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one global, non-blocking queue notice", () => {
    useManagedQueueStatus.setState({ waitingCount: 2 });
    render(<ManagedLlmQueueToast />);

    expect(screen.getByText("AI 服务繁忙，正在排队…")).toBeInTheDocument();
    expect(screen.getByText("可继续等待，或在当前任务中点击停止")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
