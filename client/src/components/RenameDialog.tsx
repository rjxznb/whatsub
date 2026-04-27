import { useEffect, useRef, useState } from "react";

interface Props {
  initialTitle: string;
  onConfirm: (newTitle: string) => void;
  onClose: () => void;
}

export function RenameDialog({ initialTitle, onConfirm, onClose }: Props) {
  const [title, setTitle] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100]">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 w-[420px]">
        <h2 className="text-base font-semibold text-zinc-100 mb-3">重命名视频</h2>
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onClose();
          }}
          className="w-full px-3 py-2 bg-zinc-800 text-zinc-100 rounded text-sm border border-zinc-700"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-300">
            取消
          </button>
          <button
            onClick={submit}
            disabled={!title.trim()}
            className="px-4 py-1.5 bg-blue-500 text-black text-sm rounded font-medium disabled:opacity-50"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
