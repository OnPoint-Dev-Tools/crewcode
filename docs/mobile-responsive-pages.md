# Mobile-responsive pages

CrewCode's renderer uses one phone breakpoint: `useMobileLayout()` and CSS both
treat `≤768px` as mobile. The renderer is shared by direct `crewcode serve` and
Hub-relayed browser sessions; responsive work must not fork the underlying data
or privileged client paths.

## Code and Git review

- **Code Editor** keeps the code canvas full width. Tabs and status metadata
  scroll horizontally within their own bars, while toolbar controls retain
  touch-sized targets. The file tree starts closed on a phone and opens as a
  dismissible right-side overlay. Problems and references cover the editor body
  instead of creating an unusably narrow code column.
- **Git Sidebar** uses the same `useGitSidebar` state and actions on every
  viewport. On phones it becomes an off-canvas right panel with a backdrop and
  close action; desktop retains the resizable side-by-side panel.
- **Git Workspace** collapses its overview, changes/diff review, and shared Git
  tools into a bounded single-column flow at the same `768px` breakpoint. The
  overview stays two columns to avoid unnecessary page height, changed files
  stack above the diff, menus and branch selection use mobile overlay layers,
  and interactive controls/inputs remain touch-sized and iOS-safe.
- **Changes by turn** becomes a full-screen review surface between the mobile
  tab bar and workspace dock. With its catalogue visible, turn/file selection
  stacks above the diff. Direct changed-file targets keep the catalogue closed
  so the selected Pierre diff receives the full viewport.

These surfaces retain the exact active-worktree/default-branch comparison and
turn-change aggregation contracts documented in `git-workspace.md` and
`tailwind-renderer.md`.

## Regression coverage

Responsive JSX/CSS contracts are pinned by sibling `mobile-*.test.ts` files.
Keep JS branches aligned with the `768px` CSS breakpoint, avoid viewport-wide
intrinsic children, and retain at least 36px actionable controls on phones.
