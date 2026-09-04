/**
 * Minimal renderHook harness over react-test-renderer.
 *
 * The repo's vitest runs in a node environment with no jsdom — fine, because the
 * crew orchestration hooks touch no DOM (all refs, effects, and injected fakes).
 * react-test-renderer drives the React reconciler in pure node so we can mount a
 * hook, read its return value, and re-render with new props. We build elements
 * with `createElement` (not JSX) so this file stays `.ts` and matches the
 * `*.test.ts` collection glob without a JSX transform.
 */

import { createElement, type ComponentType, type ReactNode } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'

export interface HookHarness<P, R> {
  /** Live view of the hook's latest return value. */
  result: { current: R }
  /** Re-render the hook with new props (wrapped in act). */
  rerender: (props: P) => void
  /** Unmount — runs effect cleanups (subscription teardown, timer clears). */
  unmount: () => void
}

export function renderHook<P, R>(
  useHook: (props: P) => R,
  initialProps: P,
  Wrapper?: ComponentType<{ children: ReactNode }>,
): HookHarness<P, R> {
  const result = { current: undefined as unknown as R }
  let currentProps = initialProps

  function Probe(): null {
    result.current = useHook(currentProps)
    return null
  }

  const renderProbe = () => Wrapper
    ? createElement(Wrapper, null, createElement(Probe))
    : createElement(Probe)

  let renderer!: ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(renderProbe())
  })

  return {
    result,
    rerender(props: P) {
      currentProps = props
      act(() => { renderer.update(renderProbe()) })
    },
    unmount() {
      act(() => { renderer.unmount() })
    },
  }
}

/** Drain queued microtasks so chained promises (ensureBridge→prompt→post) settle. */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

export { act }
