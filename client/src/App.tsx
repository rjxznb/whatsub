import { useEffect } from "react";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Library } from "./pages/Library";
import { Player } from "./pages/Player";
import { Settings } from "./pages/Settings";
import { Corpus } from "./pages/Corpus";
import { FirstRunGate } from "./components/FirstRunGate";
import { LicenseGate } from "./components/LicenseGate";
import { UpdateChecker } from "./components/UpdateChecker";
import { DownloadQueueWidget } from "./components/DownloadQueueWidget";
import { mountDownloadQueueListener } from "./store/downloadQueue";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { useSettings } from "./store/settings";
import { useAuth } from "./store/auth";
import { AuthCard } from "./components/AuthCard";
import "./App.css";

function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status);
  const refresh = useAuth((s) => s.refresh);
  useEffect(() => { void refresh(); }, [refresh]);
  if (status === 'unknown') return <div className="p-8 text-zinc-400">加载中…</div>;
  if (status === 'unauthed') {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center p-4">
        <AuthCard />
      </div>
    );
  }
  return <>{children}</>;
}

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
  // Subscribe the download queue store to pipeline-events once, app-wide.
  // Idempotent — the helper guards against double-mount in StrictMode dev.
  useEffect(() => {
    void mountDownloadQueueListener();
  }, []);
  return (
    // LicenseGate is the OUTERMOST gate for the *app* — routing, FirstRun
    // setup, BackendListener, etc. don't mount until the user has a valid
    // license (or active trial). HOWEVER the updater MUST mount even when
    // license=NEEDS_KEY: a user stuck on the activation screen (trial
    // expired, no key yet) still benefits from an update prompt — maybe
    // the new version fixes whatever's blocking them. UpdateChecker is
    // hoisted out of LicenseGate's children to ensure that.
    //
    // (UpdateChecker has no router dependencies — pure useUpdater hook +
    // localStorage + JSX — so sitting outside BrowserRouter is fine.)
    <>
      <LicenseGate>
        <AuthGate>
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
              <Route path="/corpus" element={<Corpus />} />
              <Route path="/vocab" element={<Navigate to="/corpus" replace />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
            <DownloadQueueWidget />
          </BrowserRouter>
        </AuthGate>
      </LicenseGate>
      <UpdateChecker />
    </>
  );
}

export default App;
