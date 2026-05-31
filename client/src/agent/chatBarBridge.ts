// src/agent/chatBarBridge.ts
//
// Tiny module-level bridge so voice components can programmatically open the
// agent text panel, mirroring the nav.ts pattern for the router bridge.
//
// AgentRoot registers `setOpenPanel` on mount; VoiceMode's "打字" button calls
// openPanel() which triggers the ChatBar's mode to "panel".
//
// If openPanel() is called before AgentRoot mounts (e.g. during tests or
// server-side rendering) it is a safe no-op with a console.warn.

let _openPanel: (() => void) | null = null;

export function registerOpenPanel(fn: (() => void) | null): void {
  _openPanel = fn;
}

export function openAgentPanel(): void {
  if (_openPanel) {
    _openPanel();
  } else {
    // eslint-disable-next-line no-console
    console.warn("[agent/chatBarBridge] openAgentPanel called before AgentRoot registered");
  }
}
