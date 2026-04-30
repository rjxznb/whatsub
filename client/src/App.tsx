import { useEffect } from "react";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Library } from "./pages/Library";
import { Player } from "./pages/Player";
import { Settings } from "./pages/Settings";
import { Vocab } from "./pages/Vocab";
import { FirstRunGate } from "./components/FirstRunGate";
import { UpdateChecker } from "./components/UpdateChecker";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { useSettings } from "./store/settings";
import "./App.css";

/** Listens globally for whisper backend detection events emitted from Rust on
 *  every transcribe. Persists the latest value into settings.json so the
 *  Settings page can render it even after a restart, without forcing the user
 *  to re-trigger transcription to "see" the GPU. Mounted at App root so it
 *  works regardless of which page is active when the import pipeline runs. */
function BackendListener() {
  const { settings, loaded, save, load } = useSettings();
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useTauriEvent<{ stage: string; name?: string }>("pipeline-event", (e) => {
    if (e.stage !== "BackendDetected" || !e.name) return;
    if (settings.whisperBackend === e.name) return;
    void save({ ...settings, whisperBackend: e.name });
  });
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <BackendListener />
      <Routes>
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route
          path="/library"
          element={
            <FirstRunGate>
              <Library />
            </FirstRunGate>
          }
        />
        <Route path="/player/:videoId" element={<Player />} />
        <Route path="/vocab" element={<Vocab />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
      <UpdateChecker />
    </BrowserRouter>
  );
}

export default App;
