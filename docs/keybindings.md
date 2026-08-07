# Keybindings

All shortcuts are editable. Defaults are listed below; overrides live in a
plain JSON file you can edit by hand or through Settings.

## How it works

- `~/.crewcode/keys.json` is the **source of truth** for overrides. Each key is
  a stable action id; the value is a list of key tokens. Remove an entry to
  fall back to that action's default.
- Settings shows the full bindings list and writes the file for you; there is
  also a button to open `keys.json` directly.
- The file is watched — hand edits apply **live**, no restart needed.
- Token format: modifiers are `Cmd`, `Ctrl`, `Alt`, `Shift` (or the glyphs
  `⌘ ⌃ ⌥ ⇧`) plus one main key (`↵` Enter, `⇥` Tab, `⌫` Backspace, or a
  character).

> [!TIP]
> `Cmd`/`⌘` means the platform primary modifier: Command on macOS, Ctrl on
> Linux/Windows. A Mac-style binding Just Works everywhere without a separate
> Ctrl rebind.

## Defaults

### Navigation

| Action | Default |
| --- | --- |
| Open command palette | Cmd K |
| Toggle workspaces drawer | Cmd B |
| Next / previous tab | Cmd Shift ] / Cmd Shift [ |
| Next / previous workspace | Ctrl Alt Tab / Ctrl Alt Shift Tab |
| Next / previous recent chat | Ctrl Tab / Ctrl Shift Tab |
| Focus settings search | Cmd / |
| Open prompt picker | Cmd P |

### Composer

| Action | Default |
| --- | --- |
| Send message | Cmd Enter |
| Cycle mode (ask/plan/build/full) | Ctrl M |
| Insert context chip | Cmd / |
| Switch model | Cmd Shift M |
| Start voice orb microphone | Ctrl Alt V |
| End voice orb microphone | Ctrl Alt X |

### Terminal

| Action | Default |
| --- | --- |
| New terminal session | Ctrl Shift T |
| Clear active pane | Cmd L |
| Toggle terminal column | Cmd J |
| Focus next session | Ctrl ` |
| Split terminal right / down | Cmd Shift D / Alt Shift D |

### Window

| Action | Default |
| --- | --- |
| New tab / close tab / reopen closed tab | Cmd T / Cmd W / Cmd Shift T |
| Toggle full screen | Ctrl Cmd F |

### Workspace

| Action | Default |
| --- | --- |
| Open in VS Code | Cmd E |
| Open local folder | Cmd O |
| Clone repository | Cmd Shift C |
| Start Crew workers | unbound |

### Session

| Action | Default |
| --- | --- |
| New agent session | Cmd N |
| Duplicate current session | Cmd Shift N |

### View

| Action | Default |
| --- | --- |
| Toggle light / dark theme | Cmd Shift L |
| Cycle color theme | unbound |
| Density: compact / regular | Cmd Alt D |

## Example `keys.json`

```json
{
  "palette": ["Ctrl", "Shift", "P"],
  "send-message": ["↵"],
  "start-crew": ["Cmd", "Shift", "G"]
}
```

Shifted symbols are matched by their base key too (binding `]` with Shift still
matches even though the browser reports `}`), so US-layout symbol chords behave
as expected.
