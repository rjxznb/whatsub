import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useLibrary } from "../store/library";
import { ImportModal } from "../components/ImportModal";
import { SCENE_LABELS } from "../llm/types";
import { formatTime } from "../utils/time";

export function Library() {
  const { library, reload } = useLibrary();
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    reload();
  }, [reload]);

  const visible = library.videos.filter((v) =>
    v.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <h1 className="text-lg font-semibold flex-1">Library</h1>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索..."
          className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm w-64"
        />
        <button
          onClick={() => setShowImport(true)}
          className="px-3 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
        >
          + Import
        </button>
        <Link to="/settings" className="px-2 py-1.5 text-zinc-300 hover:text-zinc-100">
          ⚙
        </Link>
      </header>

      {visible.length === 0 ? (
        <div className="text-center text-zinc-500 mt-32 text-sm">
          还没有视频。点击右上角 [+ Import] 导入第一个视频。
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-6">
          {visible.map((v) => (
            <Link
              key={v.id}
              to={`/player/${v.id}`}
              className="bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden hover:border-zinc-600"
            >
              <div className="aspect-video bg-zinc-800 relative">
                {v.thumbnailPath && (
                  <img
                    src={convertFileSrc(v.thumbnailPath)}
                    className="w-full h-full object-cover"
                  />
                )}
                {v.status === "analyzing" && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-blue-300 text-xs">
                    解析中...
                  </div>
                )}
                {v.status === "failed" && (
                  <div className="absolute top-2 right-2 bg-red-500 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center">
                    !
                  </div>
                )}
              </div>
              <div className="p-3">
                <div className="text-sm font-medium truncate">{v.title}</div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-500">
                  <span className="bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">
                    {SCENE_LABELS[v.scene as keyof typeof SCENE_LABELS] ?? v.scene}
                  </span>
                  {v.durationSec > 0 && <span>{formatTime(v.durationSec)}</span>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}
