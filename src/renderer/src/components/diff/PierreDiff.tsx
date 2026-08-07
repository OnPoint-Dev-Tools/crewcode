import React from 'react'
import { PatchDiff } from '@pierre/diffs/react'
// Pierre's `<diffs-container>` custom element renders the diff into its own
// shadow root and adopts the full diff stylesheet (line backgrounds, indicator
// bars, theme tokens) there — see `@pierre/diffs/dist/components/web-components`.
// So there is nothing to import or override here: styling "just works" as long
// as we render PatchDiff and pick a theme. Forcing `themeType: 'dark'` pins it
// to `pierre-dark` instead of following the OS color-scheme.

interface PierreDiffProps {
  /** Unified diff text from `git diff` or `createUnifiedDiff`. */
  patch:     string
  className?: string
}

/**
 * Boundary around the Pierre `PatchDiff` component. PatchDiff throws hard when
 * the input is anything other than a single, parseable file patch (mode-only
 * changes, binary diffs, multi-file output, etc.). We catch the throw and
 * render a colored-line fallback so a bad patch can't kill the whole pane.
 */
class PatchErrorBoundary extends React.Component<
  { patch: string; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(prev: { patch: string }) {
    // Reset when a new patch comes in so we try Pierre again.
    if (prev.patch !== this.props.patch && this.state.failed) this.setState({ failed: false })
  }
  componentDidCatch(err: unknown) {
    // Surface why Pierre bailed — otherwise "always RawDiffFallback" is invisible.
    console.error('[PierreDiff] PatchDiff threw — falling back to raw diff:', err)
  }
  render() {
    if (this.state.failed) return <RawDiffFallback patch={this.props.patch} />
    return this.props.children
  }
}

/**
 * Minimal colored fallback that just walks the raw unified diff line by line.
 * Used when Pierre's PatchDiff can't parse the patch (binary, mode-only,
 * or a multi-file diff string).
 */
function RawDiffFallback({ patch }: { patch: string }) {
  const lines = patch.split('\n')
  return (
    <div className="pierre-diff-fallback mono">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
          : line.startsWith('-') && !line.startsWith('---')         ? 'del'
          : line.startsWith('@@')                                   ? 'hunk'
          : line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') ? 'meta'
          : 'ctx'
        return <div key={i} className={`fb-line fb-${cls}`}>{line || ' '}</div>
      })}
    </div>
  )
}

/**
 * Cheap sniff for whether a patch will parse as a single-file patch. Anything
 * else (no header, mode-only changes, binary marker, multiple files) takes
 * the raw fallback path instead of risking a Pierre crash.
 */
function isSingleFileTextPatch(patch: string): boolean {
  const headerCount = (patch.match(/^diff --git /gm) ?? []).length
  if (headerCount !== 1) return false
  if (!/^@@ /m.test(patch))           return false   // no hunks → mode-only, binary, etc.
  if (/^Binary files .* differ$/m.test(patch)) return false
  return true
}

export function PierreDiff({ patch, className }: PierreDiffProps) {
  if (!patch || !patch.trim()) {
    return <div className="pierre-diff-empty">(no diff)</div>
  }
  if (!isSingleFileTextPatch(patch)) {
    return (
      <div className={className}>
        <RawDiffFallback patch={patch} />
      </div>
    )
  }
  // The scroll container is this wrapper `<div>`, NOT the `<diffs-container>`
  // host: React passes `className` to the custom element as a property rather
  // than a `class` attribute, so CSS selectors never match the host. Pierre's
  // host grows to full content height and clips vertically internally, so the
  // wrapper owns the vertical scroll.
  return (
    <div className={className}>
      <PatchErrorBoundary patch={patch}>
        <PatchDiff
          patch={patch}
          disableWorkerPool
          // Wrap by default so Git sidebar and Solochat file diffs stay readable
          // in narrow panes instead of forcing horizontal scrolling.
          options={{ diffStyle: 'split', diffIndicators: 'bars', themeType: 'dark', overflow: 'wrap' }}
        />
      </PatchErrorBoundary>
    </div>
  )
}
