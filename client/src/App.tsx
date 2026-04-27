import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Library } from "./pages/Library";
import { Player } from "./pages/Player";
import { Settings } from "./pages/Settings";
import { FirstRunGate } from "./components/FirstRunGate";
import "./App.css";

function App() {
  return (
    <BrowserRouter>
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
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
