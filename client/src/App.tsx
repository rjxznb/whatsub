import { useEffect } from "react";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Library } from "./pages/Library";
import { Player } from "./pages/Player";
import { Settings } from "./pages/Settings";
import { Corpus } from "./pages/Corpus";
import { Vocab } from "./pages/Vocab";
import { FirstRunGate } from "./components/FirstRunGate";
import { LicenseGate } from "./components/LicenseGate";
import { LicenseSessionGate } from "./components/LicenseSessionGate";
import { UpdateChecker } from "./components/UpdateChecker";
import { DownloadQueueWidget } from "./components/DownloadQueueWidget";
import { AgentRoot } from "./components/agent/AgentRoot";
import { mountDownloadQueueListener } from "./store/downloadQueue";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { useSettings } from "./store/settings";
import { useAuth } from "./store/auth";
import { useLibrary } from "./store/library";
import { startImportQueuePolling } from "./store/importQueue";
import "./App.css";

/**
 * Starts the import-queue poll loop once the user is authenticated.
 * startImportQueuePolling() is idempotent — safe to call multiple times if
 * auth status flips (e.g. token refresh). Renders nothing.
 */
function ImportQueuePoller() {
  const status = useAuth((s) => s.status);
  useEffect(() => {
    if (status === "authed") {
      startImportQueuePolling();
    }
  }, [status]);
  return null;
}

/** Listens globally for pipeline-event Transcribed/Failed and reloads the
 *  library store. Without this, a video imported via the agent (or any other
 *  in-app import path) only appears in Library after the user navigates away
 *  and back, because useLibrary's in-memory state isn't aware that the
 *  underlying library.json was rewritten by Rust mid-pipeline. The reload
 *  is idempotent + cheap — just re-reads library.json. */
function LibraryRefreshListener() {
  useTauriEvent<{ stage: string; video_id?: string }>("pipeline-event", (e) => {
    if (e.stage === "Transcribed" || e.stage === "Failed") {
      void useLibrary.getState().reload();
    }
  });
  return null;
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
        <LicenseSessionGate>
          <BrowserRouter>
            <BackendListener />
            <LibraryRefreshListener />
            <ImportQueuePoller />
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
              <Route path="/vocab" element={<Vocab />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
            <DownloadQueueWidget />
            <AgentRoot />
          </BrowserRouter>
        </LicenseSessionGate>
      </LicenseGate>
      <UpdateChecker />
    </>
  );
}

export default App;
