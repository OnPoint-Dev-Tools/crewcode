# Mobile-responsive pages

CrewCode's renderer uses one phone breakpoint: `useMobileLayout()` and CSS both
treat `≤768px` as mobile. The renderer is shared by direct `crewcode serve` and
Hub-relayed browser sessions; responsive work must not fork the underlying data
or privileged client paths.

## Window tabs

On phones, the top window-tab strip is replaced by a **Tabs** button and open-tab
count in the existing bottom workspace dock. It opens a scrollable bottom sheet
with the active tab highlighted, observed agent/crew activity, and separate close
buttons. Pinned tabs stay protected from closing. Selecting a tab dismisses the
sheet; **New tab** exposes the same built-in and plugin destinations as desktop.
Escape, the backdrop, the close button, and dragging the handle dismiss the sheet.
Keyboard focus stays within the sheet and returns to its trigger on dismissal.
Desktop retains its existing tab strip. Mobile workspace, Git, and file-tree
overlays start at the top of the viewport without reserving the former 40px strip.

## Typography

Hub/mobile renderers apply the same live chat and Code Editor typography settings
as desktop. Agent replies and user bubbles consume `--mono-size`; the phone composer
uses the selected size with a 16px minimum to prevent iOS focus zoom. CodeMirror's
runtime theme must not override `--editor-size`, including after the editor is already
mounted. These preferences remain browser-device-local and update without a reload.

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
  viewport top and workspace dock. With its catalogue visible, turn/file selection
  stacks above the diff. Direct changed-file targets keep the catalogue closed
  so the selected Pierre diff receives the full viewport.

These surfaces retain the exact active-worktree/default-branch comparison and
turn-change aggregation contracts documented in `git-workspace.md` and
`tailwind-renderer.md`.

## Regression coverage

Responsive JSX/CSS contracts are pinned by sibling `mobile-*.test.ts` files.
Keep JS branches aligned with the `768px` CSS breakpoint, avoid viewport-wide
intrinsic children, and retain at least 36px actionable controls on phones.
