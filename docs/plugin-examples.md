1. Plugin type: custom workspace panels
     - Target files/components: tab system,
       settings/plugin page, renderer
       contribution host.
     - Validation method: install plugin
       and see a new tab/panel in CrewCode.

    Example: “Architecture Map” plugin

    What it does:
     - scans the repo
     - builds a dependency/module graph
     - shows an interactive map in a
       CrewCode tab
     - lets user click a module and ask an
       agent: “explain this area” or
       “refactor this boundary”

    This is more interesting than commands
    because it gives CrewCode new visual
    surfaces.
2. Plugin type: new agent provider adapter
     - Target files/components:
       src/main/agents, agent registry,
       bridge lifecycle.
     - Validation method: plugin registers
       a new local/remote agent provider.

    Dogfood shipped:
     - `examples/plugins/mock-agent-provider`
     - contributes `Mock Reviewer` with `runtime: mock`
     - validates agent registry, selector visibility, and bridge lifecycle before shell/API-backed providers are allowed

    Example: “Aider Adapter” plugin

    Adds:
     - new agent: aider
     - model detection
     - session resume support if possible
     - structured events mapped into
       CrewCode chat/tool UI

    This is a strong plugin category
    because CrewCode’s identity is
    multi-agent orchestration. Letting
    people add their own agent CLIs would
    be valuable.
3. Plugin type: repo intelligence/indexer
    plugin

    Dogfood shipped:
     - `examples/plugins/repo-radar`
     - read-only scanner for TODOs, risk signals, and source mix
     - validates tabs, sidebar panels, status items, editor actions, chat actions, and workspace read calls
     - Target files/components: filesystem
       IPC, workspace metadata, command
       palette, editor sidebars.
     - Validation method: plugin indexes
       repo and contributes searchable
       symbols/insights.

    Example: “Codebase Memory Index” plugin

    What it does:
     - indexes files locally
     - extracts symbols/routes/API
       endpoints
     - adds command palette results like:
         - “route: POST /api/users”
         - “component: SettingsScreen”
         - “type: BridgeEvent”
     - lets agents retrieve relevant
       context before answering

    This could make CrewCode smarter than a
    normal terminal wrapper.
4. Plugin type: terminal automation plugin
     - Target files/components: PTY
       lifecycle, terminal panes, system
       monitor, command palette.
     - Validation method: plugin can define
       supervised terminal jobs.

    Example: “Dev Server Watchdog” plugin

    What it does:
     - starts npm run dev
     - watches terminal output
     - detects crashes
     - offers “send error to active agent”
     - restarts automatically if configured
     - displays status in a small panel

    Permissions:
     - terminal:spawn
     - terminal:read
     - optional agent:prompt

    This is practical and very
    CrewCode-native.
5. Plugin type: browser/research workflow
    plugin
     - Target files/components: browser
       tab, browser grab, chat composer.
     - Validation method: plugin uses
       browser selection/screenshot context
       safely.

    Example: “Docs-to-Code Assistant”
    plugin

    What it does:
     - user opens docs in CrewCode browser
     - highlights an API section
     - plugin extracts selected
       text/screenshot
     - sends it to an agent with repo
       context
     - proposes implementation changes

    This is more powerful than a prompt
    pack because it connects browser
    context + repo + agent.
6. Plugin type: git/worktree policy plugin
     - Target files/components: git IPC,
       crew orchestration, worktree
       creation.
     - Validation method: plugin can
       enforce workflow rules before agents
       edit.

    Example: “Safe Worktree Guard” plugin

    What it does:
     - prevents agents from working on main
     - requires clean git status before
       crew launch
     - auto-creates named worktrees per
       agent
     - blocks destructive operations unless
       user confirms
     - adds “merge winning crew branch”
       workflow

    This is useful for teams and makes
    CrewCode safer.
7. Plugin type: custom diff/review plugin
     - Target files/components:
       CrewDiffView, git sidebar, chat
       messages.
     - Validation method: plugin
       contributes a review lens or
       annotations.

    Example: “Risk Lens” plugin

    What it does:
     - labels changed files as:
         - low risk
         - config risk
         - auth/security risk
         - migration risk
     - highlights suspicious diffs
     - asks different agents to review
       different risk categories

    This could become a premium-quality
    workflow.
8. Plugin type: MCP/tool server connector
     - Target files/components: agent
       bridge, settings, permissions.
     - Validation method: plugin registers
       external tools available to agents.

    Example: “Linear/Jira Context” plugin

    What it does:
     - connects to Linear/Jira
     - pulls ticket acceptance criteria
     - injects ticket context into crew
       sessions
     - posts final summaries back to the
       ticket

    Permissions:
     - mcp:server
     - network:fetch once CrewCode owns safe outbound routing
     - secrets:read for named tokens only, once secret injection exists
     - agent:prompt/context once agent context routing exists

    Current manifest shape can declare MCP server commands with `contributes.mcpServers`, but CrewCode should own spawning, enablement, audit, and secret injection.

    This is more enterprise/team-oriented.

    Dogfood shipped:
     - `examples/plugins/handoff-pack`
     - local markdown handoff generator for teammates/agents
     - validates workspace read/write permissions before external integrations need secrets or network access
9. Plugin type: UI theming/layout plugin
     - Target files/components: design
       tokens, settings, tab/layout state.
     - Validation method: plugin changes
       theme/layout without arbitrary app
       code.

    Example: “Review Mode Layout” plugin

    What it does:
     - opens diff left
     - chat right
     - terminal bottom
     - hides mission/system surfaces
     - applies a specific density/theme
       preset

    Not as deep, but nice for workflow
    customization.
10. Plugin type: mission-control plugin

- Target files/components: MissionControl,
   system monitor, agent status.
- Validation method: plugin adds mission
   widgets or automated checks.

    Example: “CI Mission Monitor” plugin

    What it does:
- watches GitHub Actions/local CI
- shows failing jobs in Mission Control
- lets user send logs to selected agent
- tracks which agent caused/fixed a
   failure
