import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatArtifacts, useChatArtifacts } from './ChatArtifacts'

const read = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/crewcode-client', () => ({ getCrewCodeClient: () => ({ fsReadFile: read }), getCrewCodeRuntime: () => ({ kind: 'electron' }) }))
vi.mock('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }))
function Actions() {
  const artifacts = useChatArtifacts()!
  return <><button id="html" onClick={() => artifacts.openHtml('<script>window.test=1</script>', 'demo')}>HTML</button>
    <button id="file" onClick={() => artifacts.openLink('preview.html')}>File</button>
    <button id="web" onClick={() => artifacts.openLink('http://127.0.0.1:5198')}>Web</button></>
}
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks() })
function mount(root = '/repo') {
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  act(() => { tree = create(<ChatArtifacts workspacePath={root}><Actions /></ChatArtifacts>) })
  return tree!
}
describe('chat artifacts isolation', () => {
  it('runs generated HTML only in an opaque sandbox without native capabilities', () => {
    const view = mount()
    act(() => view.root.findByProps({ id: 'html' }).props.onClick())
    const frame = view.root.findByType('iframe')
    expect(frame.props.sandbox).toBe('allow-scripts')
    expect(frame.props.src.startsWith('crewcode-artifact://preview/#')).toBe(true)
    expect(decodeURIComponent(new URL(frame.props.src).hash.slice(1))).toContain('<script>')
    expect(frame.props.referrerPolicy).toBe('no-referrer')
  })
  it('loads linked files through the registered workspace client', async () => {
    read.mockResolvedValue({ ok: true, text: '<h1>Artifact</h1>' })
    const view = mount()
    await act(async () => view.root.findByProps({ id: 'file' }).props.onClick())
    expect(read).toHaveBeenCalledWith('/repo', 'preview.html')
    expect(decodeURIComponent(new URL(view.root.findByType('iframe').props.src).hash.slice(1))).toContain('Artifact')
  })
  it('does not reopen an artifact after the user closes a pending read', async () => {
    let resolve!: (value: unknown) => void
    read.mockReturnValue(new Promise(r => { resolve = r }))
    const view = mount()
    act(() => view.root.findByProps({ id: 'file' }).props.onClick())
    act(() => view.root.findByProps({ 'aria-label': 'Close artifacts' }).props.onClick())
    await act(async () => resolve({ ok: true, text: '<h1>late</h1>' }))
    expect(view.root.findAllByType('iframe')).toHaveLength(0)
  })
  it('explains remote loopback rather than loading a different machine', () => {
    const view = mount('ssh://host/repo')
    act(() => view.root.findByProps({ id: 'web' }).props.onClick())
    expect(view.root.findAllByType('iframe')).toHaveLength(0)
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('SSH host')
  })
})
