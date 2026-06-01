// src/store/appDialog.ts
//
// App-styled replacement for the native @tauri-apps/plugin-dialog `message()` /
// `confirm()` and `window.alert/confirm` popups (which render as OS-chrome
// dialogs that don't match the app). `notify()` and `confirmDialog()` enqueue a
// request and resolve when the user responds; <AppDialog> (mounted once at app
// root) renders the current request in the app's dark theme.

import { create } from "zustand";

export type DialogKind = "info" | "confirm";

export interface DialogRequest {
  id: number;
  kind: DialogKind;
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface AppDialogStore {
  queue: DialogRequest[];
  /** Resolve the front-of-queue dialog with the user's choice. */
  resolveTop: (ok: boolean) => void;
}

let _id = 0;

export const useAppDialog = create<AppDialogStore>((set, get) => ({
  queue: [],
  resolveTop: (ok) => {
    const q = get().queue;
    const top = q[0];
    if (!top) return;
    set({ queue: q.slice(1) });
    top.resolve(ok);
  },
}));

function enqueue(req: Omit<DialogRequest, "id" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    const full: DialogRequest = { ...req, id: ++_id, resolve };
    useAppDialog.setState((s) => ({ queue: [...s.queue, full] }));
  });
}

/** App-styled info popup (single OK). Drop-in for native `message()` / alert(). */
export function notify(
  message: string,
  opts?: { title?: string; okText?: string },
): Promise<void> {
  return enqueue({
    kind: "info",
    message,
    title: opts?.title,
    okText: opts?.okText,
  }).then(() => undefined);
}

/** App-styled confirm (OK/Cancel → boolean). Drop-in for native `confirm()`. */
export function confirmDialog(
  message: string,
  opts?: {
    title?: string;
    okText?: string;
    cancelText?: string;
    danger?: boolean;
  },
): Promise<boolean> {
  return enqueue({ kind: "confirm", message, ...opts });
}
