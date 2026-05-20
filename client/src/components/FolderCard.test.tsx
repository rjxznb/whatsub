import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { FolderCard } from "./FolderCard";
import type { LibraryEntry, LibraryFolder } from "../types/library";

const cue = (id: string, thumb: string): LibraryEntry => ({
  id,
  title: id,
  source: { type: "local", originalPath: "/x" },
  durationSec: 10,
  thumbnailPath: thumb,
  createdAt: "2026-05-20T00:00:00Z",
  status: "ready",
  lastError: null,
});

const folder: LibraryFolder = {
  id: "f1",
  name: "Test Folder",
  videoIds: ["a", "b", "c"],
  createdAt: "2026-05-20T00:00:00Z",
};

describe("FolderCard", () => {
  it("renders folder name and video count", () => {
    const { getByText } = render(
      <FolderCard
        folder={folder}
        videos={[cue("a", "a.jpg"), cue("b", "b.jpg"), cue("c", "c.jpg")]}
        draggedId={null}
        dropFeedback={null}
        onClick={() => {}}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        onDragEnd={() => {}}
      />
    );
    expect(getByText("Test Folder", { exact: false })).toBeTruthy();
    expect(getByText("3")).toBeTruthy();
  });

  it("fires onClick when not in a drag operation", () => {
    const onClick = vi.fn();
    const { container } = render(
      <FolderCard
        folder={folder}
        videos={[cue("a", "a.jpg")]}
        draggedId={null}
        dropFeedback={null}
        onClick={onClick}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        onDragEnd={() => {}}
      />
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("suppresses onClick while a drag is in flight", () => {
    const onClick = vi.fn();
    const { container } = render(
      <FolderCard
        folder={folder}
        videos={[cue("a", "a.jpg")]}
        draggedId="someOtherId"
        dropFeedback={null}
        onClick={onClick}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        onDragEnd={() => {}}
      />
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClick).not.toHaveBeenCalled();
  });
});
