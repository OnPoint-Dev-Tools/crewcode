# Chat artifacts and browser access

Agent replies expose **Open artifact** on HTML and SVG fenced code blocks.
Supported workspace-file links and HTTP(S) links expose **Preview** beside the
normal link. Preview opens the Artifacts panel while keeping the chat available.
Image links open the in-app image viewer directly; other normal links retain
their editor/in-app-browser behavior. HTTP previews also
offer **Open in app browser**, since some sites refuse iframe embedding.

HTML/SVG previews run scripts in a sandboxed iframe with an opaque origin, no
Electron bridge, no same-origin allowance, no popups, and no top navigation.
They can load network resources; opening a preview runs its supplied code.
Interactive content loads through a dedicated preview document, served by the
desktop `crewcode-artifact:` protocol or the web/Hub `/crewcode-artifact-frame`
route. Its response enforces `sandbox allow-scripts` without same-origin access;
it permits artifact scripts without widening the trusted renderer's script CSP.
The app's frame policy permits these previews and HTTP(S) pages. Artifact content
travels only in the URL fragment, never an HTTP request body/query or server log.
The preview endpoint is public static bootstrap code with no workspace access.
Workspace files are read through the typed CrewCode client and existing
registered-root checks, including SSH. Text/HTML previews are limited to 2 MB.
HTML must be self-contained or use absolute network URLs: relative workspace
dependencies are not served by the panel. Markdown/text files display as source;
Image files use the shared viewer with Fit, Actual size, zoom, dimensions, and
Reload, including SVG as an inert image. Image reads support local and SSH
workspaces up to 25 MB. See [In-app image viewing](image-viewer.md).
JSX requires a running build/dev server.
Previews are ephemeral and do not create another copy of the artifact.

For SSH workspaces, loopback HTTP previews require explicit port forwarding:
`127.0.0.1` in the desktop/browser refers to the client computer, not the remote
workspace host. The panel explains this rather than loading the wrong machine.

Codex browser automation is separate from this panel and the Electron browser.
The app-server bridge handles `mcpServer/elicitation/request` using MCP's
`action`/`content` response. Full Access automatically accepts consent-only forms;
forms requesting data and URL-based authentication remain interactive. Structured
form data is entered as a JSON object using the existing request card; malformed
JSON is an explicit error. MCP/provider validation remains authoritative.
Stop, process exit, and provider-side request resolution withdraw pending cards.
Both numeric and string server request ids retain their exact identity.
Unknown server requests return an explicit unsupported-method error rather than
an empty success object that a tool might interpret as user denial.

Codex `item/permissions/requestApproval` displays the exact requested sandbox
extension and grants it only after an observed acceptance, for the current turn.
Ask/Plan/read-only sessions cannot grant those extensions. Full Access retains
the existing workspace-write sandbox and dangerous-command tripwire. A prompt
claiming full access cannot remove an OS sandbox; `spawn EPERM` still requires
examining the provider's actual execution environment. External browser services
can also enforce gates CrewCode does not control. This feature does not install
an automation backend or prove a browser automation request succeeded.
