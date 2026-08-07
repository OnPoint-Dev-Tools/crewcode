# System Monitor

The System Monitor shows what CrewCode and everything it has spawned —
terminals and agent daemons — are costing in CPU and memory, grouped by
workspace, with controls to jump to or kill any process.

## Opening it

Click the **CPU pill** in the app chrome. The pill itself is always live: it
shows CrewCode's current CPU usage and a count of active processes (terminal
sessions + agent bridges). Press `Esc` or click outside to close the panel.

## What it shows

- **cpu · crewcode** — CrewCode plus all tracked child processes, shown as a
  share of the whole machine (all cores = 100%), with a sparkline history.
- **memory** — CrewCode's resident memory plus tracked processes, against
  physical RAM.
- **Process list, grouped by workspace** — every terminal session and agent
  daemon, with per-process CPU and memory that includes each process's child
  tree (a shell's `npm`/`node` children are counted). Groups collapse per
  workspace. Processes that don't map to a workspace land in an "other" group.

Per row you can:

- **Open** — jump to that terminal pane or agent session (closes the panel).
- **Kill / stop** — kill a terminal session or stop an agent daemon.

## How sampling works

Two channels keep the always-on pill cheap:

- A lightweight snapshot (CrewCode's own footprint via Electron app metrics)
  polls continuously and drives the trigger pill — no child processes are
  spawned for it.
- The detailed per-process sample (every spawned terminal and agent daemon plus
  their child trees) only polls **while the panel is open**.

> [!NOTE]
> Idle agent bridges are stopped automatically after ~10 minutes to free
> memory; they resume transparently on the next prompt. The monitor's stop
> action is the manual version of the same thing.
