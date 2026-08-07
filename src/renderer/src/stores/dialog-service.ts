/**
 * Promise-based dialog service — an imperative replacement for the native
 * window.confirm / window.prompt, which under Electron on Wayland can leave the
 * frameless window without keyboard focus after they close (freezing the
 * composer and other inputs until reload).
 *
 * Any code — including hooks that cannot render JSX — calls `confirmDialog()` /
 * `promptDialog()` and awaits the result. A single <DialogHost/> at the app root
 * subscribes to this store and renders the themed modal.
 */

import { create } from 'zustand'

export interface ConfirmOptions {
  title:        string
  body?:        string
  confirmText?: string
  cancelText?:  string
  danger?:      boolean
}

export interface PromptOptions {
  title:        string
  label?:       string
  placeholder?: string
  initial?:     string
  confirmText?: string
}

export type DialogRequest =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt';  opts: PromptOptions;  resolve: (value: string | null) => void }

interface DialogState {
  current: DialogRequest | null
  set:     (request: DialogRequest | null) => void
}

export const useDialogStore = create<DialogState>((set) => ({
  current: null,
  set:     (current) => set({ current }),
}))

// Resolves true on confirm, false on cancel/escape/backdrop.
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useDialogStore.getState().set({ kind: 'confirm', opts, resolve })
  })
}

// Resolves the trimmed text on confirm, or null on cancel. The input modal
// refuses to confirm an empty value, so a resolved string is always non-empty.
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    useDialogStore.getState().set({ kind: 'prompt', opts, resolve })
  })
}
