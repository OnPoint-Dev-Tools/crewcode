# Global Notification Bar

A stacked, auto-dismissing notification system that appears at the top of the CrewCode window, just below the tab bar. Notifications provide contextual feedback for agent activity, crew events, and system errors.

## Overview

The **Global Notification Bar** displays transient messages in the upper portion of the application window. Key characteristics:

- **Position**: Fixed overlay beneath the window tab bar (`~54px` from top)
- **Layout**: Centered stack of up to 3 visible cards (max 5 stored)
- **Behavior**: Auto-dismisses after a configurable duration with animated progress bar
- **Interaction**: Click × to dismiss manually, or press `Escape` to dismiss the topmost notification
- **Accessibility**: Uses `aria-live="polite"` for screen reader announcements

Each notification card features:
- Color-coded left border and icon indicating type
- Semi-transparent glassmorphism background with backdrop blur
- Smooth enter/exit animations with staggered stacking effect
- Animated progress bar showing remaining time until auto-dismiss

## Native desktop notifications

Completed agent turns can also send a native OS notification while CrewCode is
unfocused. Configure this under **Settings → General**:

- **Desktop notifications** enables or disables completed-turn notifications.
- **Notification sound** offers `system`, `bell`, `ding`, `knock`, and `none`.
- Selecting a custom sound previews it immediately.

`system` leaves sound playback to the operating system. The custom sounds are
synthesized by CrewCode and the native toast is marked silent to prevent two
sounds from playing. `none` keeps the native toast visible without audio.

Crew completions within the coalescing window produce one summary notification
and one sound rather than a separate notification for every agent.

### Linux delivery path

On Linux, Electron's `Notification` performs synchronous DBus round-trips on
the main process (capability probe and show). With a slow or DBus-activated
notification daemon this stalled the entire browser process 0.5–1.1s per toast
— visible as app-wide freezes during agent streaming. `notify:show` therefore
spawns a detached `notify-send` child process on Linux, moving the DBus wait
out of the main process. Trade-offs and fallbacks:

- Click-to-navigate is preserved through `--action=default=Open` (libnotify
  ≥ 0.7.10): the child lingers for the toast's lifetime, prints `default` on
  stdout when the body is clicked, and main translates that into the same
  focus + scope echo as an Electron notification click. Daemons without action
  support simply show a non-clickable toast.
- The startup probe validates the binary actually runs (`--help`, exit 0). A
  libnotify version mismatch can leave a `notify-send` on PATH that dies with a
  symbol lookup error — that must fall back to Electron `Notification`, not
  silently drop every toast.
- If `notify-send` is missing or broken, the Electron `Notification` path is
  used as before (with `isSupported()` and the icon decode cached, since both
  are also main-process costs).
- The `silent` flag maps to the `suppress-sound` hint for `notify-send`.

Do not reintroduce a per-toast `Notification.isSupported()` call or an uncached
`nativeImage.createFromPath` — both run on the main process hot path.

## Architecture

The notification system follows a **Provider → Hook → Component** pattern built on React Context:

```
NotificationsProvider (Context)
    ↓
useNotifications() (Hook)
    ↓
NotificationBar (UI Component)
    └─ NotificationItem (Individual Card)
```

### Components

| Layer | File | Responsibility |
|-------|------|----------------|
| **Context** | `src/renderer/src/hooks/useNotifications.tsx` | State management, `show()` / `dismiss()` API |
| **Container** | `src/renderer/src/components/ui/NotificationBar.tsx` | Renders the stacked list, handles keyboard shortcuts |
| **Item** | `src/renderer/src/components/ui/NotificationBar.tsx` | Individual card with animations, progress bar, and close button |
| **Integration** | `src/renderer/src/App.tsx` | Wires notification triggers to app events |
| **Native toast** | `src/main/notify.ts` | Shows the cross-platform Electron notification and handles click focus |
| **Sounds** | `src/renderer/src/notifications/notification-sounds.ts` | Validates presets and synthesizes custom tones |
| **Styles** | `src/renderer/src/styles/styles.css` | CSS classes for layout, colors, and animations |

### Data Flow

1. Any component calls `useNotifications().show({ message, type, duration })`
2. The provider generates a unique ID and prepends the notice to its state array (capped at 5)
3. `NotificationBar` reads the `notices` array from context and renders the top 3
4. Each `NotificationItem` schedules its own auto-dismiss timer based on `duration`
5. On dismiss (manual or automatic), the item is removed from the provider's state

## Usage Guide

### Basic Usage

Import the hook and call `show()` with a message and type:

```tsx
import { useNotifications } from '../hooks/useNotifications'

function MyComponent() {
  const { show } = useNotifications()

  const handleClick = () => {
    show({
      message: 'Operation completed successfully',
      type: 'success',
      duration: 3000, // optional; defaults to 4000ms
    })
  }

  return <button onClick={handleClick}>Run Action</button>
}
```

### Notification Types

| Type | Icon | Color | Use Case |
|------|------|-------|----------|
| `'info'` | 🔔 Bell | Blue (`#4f8cff`) | General informational messages |
| `'success'` | ✓ Check | Green (`#2ec27e`) | Successful operations |
| `'warning'` | ⚠ Alert | Amber (`#ffb648`) | Non-critical warnings |
| `'error'` | ✕ Close | Red (`#ff6b6b`) | Errors requiring attention |

### API Reference

#### `useNotifications()`

Returns an object with the following properties:

```typescript
interface NotificationsCtx {
  notices: Notice[]           // Read-only array of active notifications
  show: (n: Omit<Notice, 'id'>) => string   // Add a notification; returns its ID
  dismiss: (id: string) => void             // Remove a notification by ID
}
```

#### `Notice` Interface

```typescript
type NoticeType = 'info' | 'success' | 'warning' | 'error'

interface Notice {
  id: string        // Auto-generated UUID-like identifier
  message: string   // Display text (trimmed automatically)
  type: NoticeType  // Visual styling category
  duration?: number // Auto-dismiss delay in ms; 0 = no auto-dismiss
}
```

#### `show()` Parameters

```typescript
show({
  message: string,   // Required: text to display
  type: NoticeType,  // Required: one of 'info' | 'success' | 'warning' | 'error'
  duration?: number, // Optional: milliseconds before auto-dismiss (default: 4000)
})
```

**Notes:**
- Empty messages are ignored (returns `''`)
- Duration of `0` disables auto-dismiss — user must click ×
- Only the most recent 5 notifications are retained; older ones are dropped
- Returns the generated `id` for programmatic dismissal if needed

#### `dismiss(id)`

Manually removes a notification before its auto-dismiss timer fires:

```tsx
const { show, dismiss } = useNotifications()

const id = show({ message: 'Processing...', type: 'info', duration: 0 })
// ... later, when processing completes:
dismiss(id)
show({ message: 'Done!', type: 'success', duration: 2000 })
```

## Integration Points

Notifications are currently wired into three areas of the application:

### 1. Solo Chat Agent Events (`App.tsx`, lines ~290–305)

Triggers when a solo agent (non-crew) finishes responding or exits unexpectedly:

```tsx
useEffect(() => {
  const latest = messages[messages.length - 1]
  if (!latest) return

  // Agent exited with error
  if (latest.kind === 'system' && latest.tone === 'info' && latest.text.startsWith('agent exited')) {
    const text = latest.text.trim()
    const key = `info:${activeTabId}:${latest.time}:${text}`
    if (!text || lastSoloNoticeRef.current === key) return
    lastSoloNoticeRef.current = key
    show({ type: 'warning', message: text, duration: 4200 })
    return
  }

  // New agent response received
  if (latest.kind === 'agent' && !latest.streaming) {
    const key = `agent:${activeTabId}:${latest.turnId ?? latest.time}`
    if (lastSoloNoticeRef.current === key) return
    lastSoloNoticeRef.current = key
    const tabLabel = tabs.find(t => t.id === activeTabId)?.label?.trim() || 'agent'
    show({ type: 'info', message: `New response from ${tabLabel}`, duration: 2600 })
  }
}, [messages, activeTabId, tabs, show])
```

### 2. Crew Session Events (`App.tsx`, lines ~320–330)

Notifies when any lane in an active crew session receives a message:

```tsx
useEffect(() => {
  if (!crewSession || crewSession.state !== 'active') return
  const laneTabs = crewSession.lanes.map(l => l.tabId).filter((v): v is string => !!v)
  const completedKeys = laneTabs.flatMap(tabId =>
    (messagesByTab[tabId] ?? [])
      .filter((msg): msg is Extract<Message, { kind: 'agent' }> => msg.kind === 'agent' && !msg.streaming)
      .map(msg => `${tabId}:${msg.turnId ?? msg.time}`)
  )
  const newest = completedKeys[completedKeys.length - 1]
  if (!newest || lastCrewNoticeRef.current === newest) return
  lastCrewNoticeRef.current = newest
  show({ type: 'info', message: 'Crew message received', duration: 2400 })
}, [crewSession, messagesByTab, show])
```

### 3. Global System Errors (`App.tsx`, lines ~307–318)

Scans all tabs for system-level error messages and displays them globally:

```tsx
useEffect(() => {
  let latestError: { key: string, text: string } | null = null
  for (const [tabId, tabMessages] of Object.entries(messagesByTab)) {
    for (let i = tabMessages.length - 1; i >= 0; i -= 1) {
      const msg = tabMessages[i]
      if (msg.kind === 'system' && msg.tone === 'error') {
        const text = msg.text.trim()
        if (!text) break
        latestError = { key: `err:${tabId}:${msg.time}:${i}:${text}`, text }
        break
      }
    }
  }
  if (!latestError || lastGlobalErrorNoticeRef.current === latestError.key) return
  lastGlobalErrorNoticeRef.current = latestError.key
  show({ type: 'error', message: latestError.text, duration: 5000 })
}, [messagesByTab, show])
```

## Visual Design

### Stacked Cards

Notifications stack vertically with a perspective effect:
- **Top card**: Full opacity (`1.0`), scale `1.0`, no offset
- **Second card**: Opacity `0.86`, scale `0.97`, offset `8px` down
- **Third card**: Opacity `0.72`, scale `0.94`, offset `16px` down

CSS variables control this via `--stack-index`, `--stack-offset`, and `--stack-scale`:

```css
.notification-stack-item {
  position: absolute;
  top: var(--stack-offset);          /* i * 8px */
  transform: scale(var(--stack-scale)) translateY(calc(var(--stack-index) * -2px));
  opacity: calc(1 - (var(--stack-index) * 0.14));
  transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease;
}
```

### Color Coding

Each notification type maps to specific colors:

```css
/* Left border gradient */
.notify-left-border {
  background: linear-gradient(to bottom, color-mix(in srgb, white 14%, var(--notify-color)), var(--notify-color));
}

/* Icon background circle */
.notify-icon {
  color: var(--notify-color);
  background: color-mix(in srgb, var(--notify-color) 12%, transparent);
}

/* Card background tint */
.notification-item {
  background: color-mix(in srgb, var(--notify-bg) 24%, var(--card));
  border-color: color-mix(in srgb, var(--border) 88%, var(--notify-color));
}
```

| Type | `--notify-color` | `--notify-bg` |
|------|------------------|---------------|
| info | `#4f8cff` | `color-mix(in srgb, #4f8cff 10%, var(--card))` |
| success | `#2ec27e` | `color-mix(in srgb, #2ec27e 10%, var(--card))` |
| warning | `#ffb648` | `color-mix(in srgb, #ffb648 12%, var(--card))` |
| error | `#ff6b6b` | `color-mix(in srgb, #ff6b6b 10%, var(--card))` |

### Progress Bar

When `duration > 0`, a thin progress bar animates along the bottom edge:

```css
.notify-progress-bar {
  height: 100%;
  width: 100%;
  transform-origin: left center;
  background: linear-gradient(90deg, color-mix(in srgb, white 10%, var(--notify-color)), var(--notify-color));
  animation-name: notify-progress-shrink;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
  animation-duration: <duration>ms;  /* set inline per notification */
}

@keyframes notify-progress-shrink {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}
```

### Animations

**Enter animation** (300ms ease-out):
```css
.notification-item {
  opacity: 0;
  transform: translateY(-20px) scale(0.985);
}
.notification-item.visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}
```

**Exit animation** (300ms ease-in):
```css
.notification-item.leaving {
  opacity: 0;
  transform: translateY(-20px) scale(0.985);
}
```

The exit transition includes a 300ms delay before the DOM node is actually removed, allowing the animation to complete.

## Adding New Integration Points

To wire notifications to a new event source, follow these steps:

### Step 1: Import the Hook

In your component file:

```tsx
import { useNotifications } from '../hooks/useNotifications'
```

### Step 2: Get the `show` Function

Inside your component:

```tsx
function MyComponent() {
  const { show } = useNotifications()
  // ...
}
```

> **Note**: The component must be rendered inside `<NotificationsProvider>`. In CrewCode, this is already set up in the root, so all components have access.

### Step 3: Call `show()` on the Event

Trigger notifications when relevant events occur:

```tsx
// Example: Notify when a file upload completes
const handleUploadComplete = (fileName: string) => {
  show({
    message: `Uploaded ${fileName}`,
    type: 'success',
    duration: 3000,
  })
}

// Example: Notify on validation failure
const handleValidationError = (field: string) => {
  show({
    message: `Invalid value for ${field}`,
    type: 'error',
    duration: 5000,
  })
}
```

### Step 4: Deduplicate If Needed

For high-frequency events, use a ref to track the last shown notification and avoid spam:

```tsx
const lastNoticeRef = useRef<string>('')

useEffect(() => {
  if (!someCondition) return
  
  const key = `my-event:${uniqueIdentifier}`
  if (lastNoticeRef.current === key) return  // skip duplicate
  lastNoticeRef.current = key
  
  show({ message: 'Event occurred', type: 'info', duration: 2000 })
}, [someCondition, uniqueIdentifier, show])
```

### Step 5: Choose Appropriate Duration

Guidelines for duration selection:

| Scenario | Duration | Rationale |
|----------|----------|-----------|
| Brief confirmations (save, copy) | 2000–2600ms | Quick acknowledgment |
| Standard info messages | 3000–4000ms | Default range for readability |
| Warnings | 4000–5000ms | User should notice but not panic |
| Errors | 5000–6000ms | Give time to read details |
| Persistent alerts | `0` (no auto-dismiss) | Requires explicit user action |

### Example: Integrating with a Git Operation

```tsx
import { useNotifications } from '../hooks/useNotifications'

function GitOperationsPanel() {
  const { show } = useNotifications()

  const handleCommit = async () => {
    try {
      await window.electronAPI.gitCommit(message)
      show({
        message: 'Changes committed successfully',
        type: 'success',
        duration: 2500,
      })
    } catch (err) {
      show({
        message: `Commit failed: ${err.message}`,
        type: 'error',
        duration: 5000,
      })
    }
  }

  return <button onClick={handleCommit}>Commit</button>
}
```

## Best Practices

1. **Keep messages concise**: Aim for under 60 characters. The notification bar has limited width (~540px max).

2. **Use appropriate types**: Reserve `'error'` for actionable failures. Don't use it for expected conditions.

3. **Avoid notification spam**: Deduplicate rapid-fire events using refs or throttling.

4. **Provide context**: Include relevant identifiers (file names, branch names) so users know what the notification refers to.

5. **Test accessibility**: Ensure critical information isn't conveyed solely through color. The icon and text should be sufficient.

6. **Respect user focus**: Don't show notifications for routine background tasks unless the user explicitly requested the action.

## Troubleshooting

### "useNotifications must be inside NotificationsProvider"

This error means you're calling the hook outside the provider tree. Verify that:
- Your component is rendered within `<App>` (which wraps everything in `NotificationsProvider`)
- You're not accidentally creating a separate React root without the provider

### Notifications Not Appearing

Check:
- The message is non-empty after trimming
- The component re-renders after calling `show()`
- No CSS `z-index` conflicts are hiding the bar (it uses `z-index: 1500`)

### Progress Bar Not Animating

Ensure `duration` is set to a positive number. A duration of `0` disables the progress bar entirely.

### Too Many Notifications

The system caps at 5 stored notifications and displays only the top 3. Older notifications are automatically dropped. If you need to show more, consider consolidating messages or using a different UI pattern (e.g., a dedicated status panel).

## YuHeard — terminal-pane agent alerts

YuHeard is a **separate channel** from the native OS notifications
triggered by **chat** bridge turn-end. A terminal-agent `complete`
plays knock, shows an in-app toast, and (when the window is unfocused)
an OS notification titled "Terminal agent finished". Chat completions
must not play the YuHeard knock — they keep Desktop notifications +
Notification sound.

See [`docs/yuheard.md`](./yuheard.md) for the protocol, the
`bin/yuheard` CLI, the auto-wrap behavior, PTY idle/BEL fallback, and
the privacy model.
