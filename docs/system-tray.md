# System tray

CrewCode can keep desktop work running after its window is closed. The behavior
is opt-in under **Settings → General → Keep running in background** and is
disabled by default.

When enabled:

- CrewCode creates an operating-system tray icon.
- Closing the window hides it instead of terminating terminals, agent bridges,
  editor watchers, or other app-owned runtime state.
- **Open CrewCode** in the tray menu restores and focuses the existing window.
- **Quit CrewCode** performs a real application quit and runs normal cleanup.
- On Windows and Linux, clicking the tray icon also restores the window. Linux
  StatusNotifierItem hosts typically emit a single Activate click rather than a
  double-click; both are handled. The menu object is retained so D-Bus menu
  actions keep working after the window is hidden.

Disabling the setting removes the tray icon immediately and restores normal
close behavior. On macOS the Dock icon remains visible; CrewCode does not switch
to an accessory-only application policy.

The preference is renderer-persisted like other CrewCode settings and projected
to the Electron main process over the narrow `tray:configure` IPC method. Web,
Hub, and headless runtimes do not expose or emulate a system tray.
