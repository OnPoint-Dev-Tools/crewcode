# Realtime voice

CrewCode's voice orb is a provider-neutral controller for the active coding
agent. The voice model handles the spoken conversation and uses a narrow tool
contract to send work to the selected Claude, Codex, Pi, or other CrewCode
agent. It never receives direct filesystem, shell, Git, or approval authority.

## Availability

Voice is off by default.

| Provider | Transport | Status |
| --- | --- | --- |
| GPT | OpenAI Realtime over WebRTC | Implemented; disabled until an OpenAI API key is configured |
| xAI | xAI Voice over WebSocket and binary PCM | Implemented; disabled until an xAI API key is configured |
| Test | In-memory fake transport | Development builds and automated tests only |
| Local | Parakeet TDT 0.6B v2 + Kokoro-82M | Implemented as a native Python sidecar; `am_michael` is the default voice |

Configure a provider under **Settings → Voice**. A configured provider can be
started from the microphone orb in a chat header. CrewCode permits only one
active microphone owner across normal chat and Workbench panes.

The orb is one-turn push-to-talk. One click records one request and then opens
an editable confirmation before anything is sent to the coding agent. Microphone
input is muted during review while the output side of the voice transport stays
available for the eventual spoken result. Choose **Edit** to revise the
transcript, **Send** to route it through the active session, or **Cancel** to
close the voice session without contacting the agent.

After confirmation, CrewCode waits for the coding agent and plays the spoken
result. It then releases the voice session after playback finishes; click the
orb again for the next request. This confirmation belongs only to the orb.
Composer dictation continues to insert text into the composer without sending
it.

Voice mode survives chat and tab navigation during that turn. The persistent
runtime remains pinned to the session where the user started it, so navigating
cannot reroute the request or its result to another agent. Individual chat panes
only present the runtime: when the originating pane unmounts, the next visible
chat adopts the live overlay while the original transport, activity tracking,
and eventual speech continue. A non-chat page may have no overlay host, but the
voice turn continues and reappears when a chat surface is visible again.

The orb microphone can also be started with **Ctrl+Alt+V** and ended with
**Ctrl+Alt+X**. Both shortcuts are editable under **Settings → Shortcuts** or
in `~/.crewcode/keys.json`. In split layouts, the start shortcut targets the
focused composer; the end shortcut only stops the voice session that currently
owns the microphone.

While the coding agent is executing a tool, the orb remains in its waiting
state and displays **Running tools**. A late provider event must not present
normal coding-agent activity as a voice error; a real transport failure remains
stored and surfaces after the active coding turn stops.

While active, the compact header control expands into the voice orb supplied
with CrewCode. Its overlay begins at the top edge of the chat header and extends
down into that chat pane, showing connecting, listening, agent-working, and
speaking states for the complete voice turn. The X hides only the overlay; the
transport remains active and the agent result still plays aloud. A compact
phase-aware orb remains available to reopen it. Click the large orb or press
Escape to stop the voice session. Split and Workbench layouts clip the overlay
to its owning chat pane.

OpenAI and xAI API usage is billed separately from a ChatGPT or Codex
subscription. Configuring a key does not make a provider free, so the adapters
remain disabled when no key is present.

## Composer dictation

The small microphone in the composer's left utility bar, immediately after the
branch picker, is dictation only. It is separate from the voice orb:

- one click records a single utterance and stops after a short silence;
- the selected Voice provider converts the recording to text;
- CrewCode inserts the text at the current composer caret for review or editing;
- it never sends the composer, contacts a coding agent, opens the orb, generates
  speech, or plays audio.

Click the active dictation mic again to finish the current utterance immediately.
The mic pulses while listening and spins while transcribing. Dictation and the
voice orb share only a global microphone lock, so they cannot record at the same
time.

Local dictation sends the captured WAV through main to Parakeet. GPT dictation
uses OpenAI's file transcription endpoint with `gpt-4o-mini-transcribe`; xAI
dictation uses its `/v1/stt` endpoint. Hosted requests use the same configured
provider key and are billed separately. The permanent key remains in main, and
dictation audio is capped at 32 MB before any provider request.

## Read selected chat text aloud

In a normal Solo Chat, select text in the transcript and right-click it, then
choose **Read selection aloud**. CrewCode sends only the selected text to the
currently chosen Voice provider and plays the returned audio. This is
text-to-speech only: it does not open the orb, acquire the microphone, contact a
coding agent, or alter the transcript. Starting another selection replaces the
current playback.

The action supports Local Kokoro, GPT Speech, and xAI Text to Speech. Hosted
requests reuse the provider key configured under **Settings → Voice**, with the
permanent key and provider request remaining in Electron main. A compact
**Preparing speech** spinner remains visible while synthesis starts and clears
when playback begins or the request fails.

When a supported Voice provider is selected, completed agent messages also show
a **listen** action in their hover footer. It reads the full reply through the
same provider and changes to **stop** during loading or playback. The copy action
moves into the usage strip immediately after token usage. Both selection and
whole-message speech are capped at 4,000 characters to bound cost and memory.
Voice actions are hidden when Voice is Off or the development-only Test provider
is selected; selection speech remains intentionally unavailable in Crew, Canvas,
and Writer chat surfaces.

## Agent routing

The voice session exposes two provider-neutral tools:

- `send_prompt_to_agent` sends a request to the active coding agent through the
  existing chat bridge.
- `get_agent_status` reports whether that agent is working.

Hosted realtime providers decide when to call those tools. Local mode does not
need another conversational model: each completed Parakeet transcription maps
to a pending `send_prompt_to_agent` confirmation, and the completed coding-agent
reply maps through the natural spoken projection into Kokoro.

If an agent is already running, voice uses CrewCode's session-scoped follow-up
behavior instead of stopping the current turn. The resulting request therefore
inherits the same provider, mode, workspace, SSH routing, permissions, and
transcript behavior as a typed composer message.

For an SSH workspace, microphone capture and audio playback stay on the local
desktop. Only the normal agent prompt follows the existing remote workspace
path.

## Natural spoken replies

The full agent response remains visible in chat. Before speech, CrewCode builds
a spoken projection from all prose blocks in their original order. It removes
fenced code, diffs, tables, Markdown syntax, URLs, and code blocks, but does not
apply a sentence or character summary limit. GPT and xAI receive instructions
to read every remaining sentence naturally without summarizing it.

Local Kokoro receives the same complete prose. **Settings → Voice → Local
speech speed** controls orb replies and chat read-aloud playback from `0.5×` to
`2×` in `0.05×` increments; `1×` is the default. The value is clamped at the
renderer/main boundary and validated again by the sidecar. Hosted GPT and xAI
voices do not use this setting. Replies longer than the sidecar's
4,000-character per-request security limit are split at sentence and word
boundaries and played sequentially, so the limit does not truncate the spoken
result.

This projection is presentation-only. It never replaces or truncates the saved
chat transcript.

## Credential boundary

Permanent provider keys are stored by the Electron main process using the
existing owner-only key store. The renderer can set or clear a key but cannot
read it back.

At session start, main exchanges the permanent key for a short-lived provider
client secret. Only that temporary credential crosses the preload boundary:

```text
renderer orb
    → preload IPC
    → main-process key store
    → provider client-secret endpoint
    → temporary credential
    → WebRTC or WebSocket transport
```

Never move permanent voice keys into renderer state, localStorage, logs, or
voice transcripts.

Local mode has a separate security boundary. Electron main starts the bundled
Python service on `127.0.0.1:17841` with a fresh random 256-bit bearer token.
The token exists only in main-process memory. Microphone WAV and speech text
cross typed IPC; main adds authentication when forwarding them to localhost.
The Python entry point rejects non-loopback bind addresses, every endpoint
requires the token, audio is capped at 32 MB, and each speech request is capped
at 4,000 characters. Long orb replies are divided into bounded requests by the
renderer transport; selection speech remains capped at 4,000 total characters.

## Architecture

- `src/shared/voice-types.ts` owns provider IDs and IPC-safe contracts.
- `src/main/voice-provider-auth.ts` owns key status, ephemeral-secret exchange,
  hosted dictation, and hosted selection-speech requests.
- `src/main/local-voice-service.ts` owns the native sidecar process, bearer
  token, authenticated HTTP calls, and shutdown.
- `services/local-voice/` is the separately installed Python runtime containing
  Parakeet and Kokoro. It is packaged as a resource, not imported by Electron.
- `src/renderer/src/voice/voice-agent-contract.ts` defines the transport and
  narrow voice tools.
- Provider adapters implement that transport without knowing about chat UI or
  agent providers.
- `voice-session-runtime.ts` owns the active transport and original agent target
  independently of chat-pane mounts, and holds tool calls for confirmation.
- `useVoiceSessionController` attaches visible chat presenters to that runtime;
  unmounting it must never stop an active voice turn.
- `voice-session-store.ts` owns high-frequency voice state outside `App.tsx`.
- `ComposerDictationButton` and `one-shot-audio-capture.ts` own the
  transcription-only composer flow; they do not use the agent tool contract.
- `selection-speech-playback.ts` owns independent playback for the Solo Chat
  selection menu; it does not use voice-session or microphone state.
- `FakeVoiceTransport` provides deterministic local lifecycle testing without a
  microphone, network, or paid request.

## Installing local voice

Local voice requires Python 3.11, `espeak-ng`, and `libsndfile`. Kokoro uses the
system packages for English pronunciation fallback and WAV output.

On Arch Linux:

```bash
sudo pacman -S --needed espeak-ng libsndfile
```

From a source checkout, create the environment inside the local voice service:

```bash
cd services/local-voice
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python .
```

The installation can use several gigabytes and may take a while because it
includes NeMo and PyTorch. Verify it before opening CrewCode:

```bash
.venv/bin/python -c "import fastapi, kokoro, soundfile, nemo.collections.asr; print('Local voice dependencies ready')"
```

Then configure CrewCode:

1. Open **Settings → Voice**.
2. Select **Local** as the voice provider.
3. Find the **Local voice** row.
4. Enter the **absolute path** to the environment's Python executable. Do not
   enter a repo-relative path because CrewCode may launch with another working
   directory.
5. Choose a **Local voice device**:
   - **Automatic** prefers an available NVIDIA GPU and otherwise uses the CPU.
   - **GPU** requires CUDA and reports an error instead of silently falling back.
   - **CPU** keeps both local models off the GPU, trading lower VRAM use for
     slower transcription and speech generation.
6. Keep `am_michael` selected.
7. Click **start & check**.

For example, a source checkout on Linux may use:

```text
/absolute/path/to/CrewCode/services/local-voice/.venv/bin/python
```

Windows environments normally use:

```text
C:\absolute\path\to\CrewCode\services\local-voice\.venv\Scripts\python.exe
```

Do not launch `crewcode_voice` manually. CrewCode starts it with the required
temporary bearer token. **Start & check** now warms both models; on first use it
may download Parakeet, Kokoro, and Kokoro's English spaCy data before reporting
ready. When Local is already selected at app launch, CrewCode starts the
sidecar after the renderer's first paint and warms only Parakeet in the
background. Dictation therefore does not pay Kokoro's startup or memory cost.
The orb begins warming Kokoro only after it dispatches work to a coding agent,
overlapping that load with the coding turn so speech is ready near the visible
reply.

The lightweight Python sidecar stays running, but its models have independent
idle lifetimes. Kokoro unloads after about 5 idle minutes and Parakeet unloads
after 15 idle minutes. Clicking the dictation microphone or voice orb starts a
Parakeet warmup immediately so model loading overlaps microphone capture. An orb
turn still waits until agent work is dispatched before warming Kokoro.

On CUDA, each unload deletes the model, runs Python garbage collection, and
clears PyTorch's CUDA cache. If both models are unloaded but PyTorch still holds
more than a small residual CUDA allocation, the sidecar exits with its managed
idle-recycle code. CrewCode immediately starts a clean, model-free sidecar;
terminating the old process guarantees that its VRAM is released. Stopping the
orb releases only the microphone, while quitting CrewCode terminates the
sidecar. A later dictation or orb turn reloads only the capability it needs.

Parakeet is fastest on supported NVIDIA hardware, but the CPU setting is useful
when GPU memory matters more than latency. Running local voice outside Electron
isolates dependencies and failures, but does not eliminate shared GPU/RAM/CPU
usage. CrewCode intentionally does not include Docker support for this provider.
