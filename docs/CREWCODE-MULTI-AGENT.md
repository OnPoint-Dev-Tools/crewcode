Act as an expert Full-Stack Engineer specializing in Electron, Harness Engineering, React, TypeScript, and Git-backed developer tools.

# OBJECTIVE

We are building a "Multi-Agent Workspace Orchestrator" feature inside our desktop Agent Coding Environment (ADE). This feature will live within our existing Chat interface, which developers use to talk to CLI-based coding agents via Git branches.

Your task is to implement the logic, UI controls, and backend orchestration workflows that let developers choose between spinning up "Multiple Workspaces" (independent work) or a "Single Workspace" (shared work).

---

# FEATURE SPECIFICATIONS &amp; RULES

1. MULTIPLE WORKSPACES (Independent Work)

- Purpose: Used for independent features, separate bug fixes, parallel issue exploration (GitHub/Linear), risky experiments, or tasks requiring separate app processes/test runs.
- Technical Flow: Every time this choice is selected, the app must provision a new workspace. Each workspace must run a dedicated local Git worktree `git worktree add`) with its own branch, separate files, independent running environments, and isolated review paths.

2. SINGLE WORKSPACE (Shared Work)

- Purpose: Used for collaborative work on the same branch. For example: one agent implements while another reviews the same diff, frontend/backend changes that land together, or a multi-agent review loop before a PR.
- Technical Flow: Multiple agents are spawned concurrently inside the *same* workspace directory, sharing the exact same branch, files, and runtime context.
- Warning: Account for the tradeoff that agents can edit the same files simultaneously.

---

# WHAT YOU NEED TO BUILD

1. Backend/Orchestration Layer (TypeScript / Node.js Context):
  - Implement the Git automation layer to handle `git worktree` creation, branch switching, and lifecycle management (clean up / archive worktrees when closed).
  - Create a workspace registry/state manager that tracks which CLI agents are running in which directory paths and branches.
2. React UI Components:
  - Create a clean "Workspace Configuration" selector within the Chat interface before a multi-agent session starts.
  - Build a visual "Decision Guide" or toggle based on the following task shapes:
    - Two features ship separately -&gt; Suggest Multiple Workspaces (Isolated branches)
    - One feature needs implementation + test repair -&gt; Suggest Single Workspace (Shared branch)
    - Several issues explored in parallel -&gt; Suggest Multiple Workspaces (Independent merge/discard)
    - One branch needs a second opinion -&gt; Suggest Single Workspace (Same diff review)
    - Risky experiment -&gt; Suggest Multiple Workspaces (Isolated from main work)
  - Design the layout changes needed to display either multiple parallel chat threads/embedded terminal panes (for multiple workspaces) or grouped agent bubbles inside a single timeline (for a shared workspace).

---

# DEVELOPMENT STEPS

Please provide the complete, production-ready code. Break your response down into:

1. State Management Changes (How we track active workspaces and assigned agents in React/TypeScript).
2. Git Automation Utilities (Node.js/Electron main process functions for managing git branches/worktrees).
3. UI Components (The React components for the user interface, styled cleanly for a frameless native-feeling desktop app).

Let's begin by generating the core state machine and TypeScript interfaces for these workspaces.
