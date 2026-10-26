import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageViewer } from './ImageViewer'
import { ChatArtifacts } from '../thread/ChatArtifacts'
import { Markdown } from '../thread/Markdown'
import { AttachmentPreviewStrip } from '../attachments/AttachmentPreviewStrip'
import { workspaceFilePathFromHref } from '../chat/workspace-link-targets'

const read = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/crewcode-client', () => ({ getCrewCodeClient: () => ({ fsReadDataUrl: read }), getCrewCodeRuntime: () => ({ kind: 'electron' }) }))
vi.mock('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }))
const pixel = 'data:image/png;base64,iVBORw0KGgo='
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.clearAllMocks(); vi.unstubAllGlobals() })
function mount(element: React.ReactElement) {
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  act(() => { tree = create(element) })
  return tree!
}

describe('in-app images', () => {
  it('reads workspace images through the client and supports actual size and zoom', async () => {
    read.mockResolvedValue({ ok: true, dataUrl: pixel })
    const view = mount(<ImageViewer root="/repo" path="image.png" title="image.png" />)
    await act(async () => {})
    expect(read).toHaveBeenCalledWith('/repo', 'image.png')
    const img = view.root.findByType('img')
    act(() => img.props.onLoad({ currentTarget: { naturalWidth: 800, naturalHeight: 600 } }))
    act(() => view.root.findAllByType('button').find(b => b.children.join('') === 'Actual size')!.props.onClick())
    expect(view.root.findByType('img').props.style.width).toBe(800)
    act(() => view.root.findByProps({ 'aria-label': 'Zoom in' }).props.onClick())
    expect(view.root.findByType('img').props.style.width).toBe(1000)
  })
  it('ignores stale reads after switching files and displays read failures', async () => {
    let finish!: (result: unknown) => void
    read.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ error: 'file missing' })
    const view = mount(<ImageViewer root="/repo" path="first.png" title="first" />)
    await act(async () => { view.update(<ImageViewer root="/repo" path="second.png" title="second" />) })
    await act(async () => finish({ ok: true, dataUrl: pixel }))
    expect(view.root.findAllByType('img')).toHaveLength(0)
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toBe('file missing')
  })
  it('rejects active documents returned as image data', async () => {
    read.mockResolvedValue({ ok: true, dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' })
    const view = mount(<ImageViewer root="/repo" path="image.png" title="image" />)
    await act(async () => {})
    expect(view.root.findAllByType('img')).toHaveLength(0)
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toBe('Cannot read image')
  })
  it.each(['![Generated](image.png)', '[Generated](C:/repo/image.png)', '![Generated](file:///C:/repo/image.png)'])('opens agent Markdown images inside the app: %s', async text => {
    read.mockResolvedValue({ ok: true, dataUrl: pixel })
    const view = mount(<ChatArtifacts workspacePath="C:/repo"><Markdown text={text} /></ChatArtifacts>)
    await act(async () => {
      const action = view.root.findAllByType('button')[0] ?? view.root.findByType('a')
      action.props.onClick({ preventDefault: vi.fn() })
    })
    expect(read).toHaveBeenCalledWith('C:/repo', 'image.png')
    expect(view.root.findByType('img').props.src).toBe(pixel)
    expect(view.root.findAllByType('iframe')).toHaveLength(0)
  })
  it('opens message image attachments in a native modal', async () => {
    read.mockResolvedValue({ ok: true, dataUrl: pixel })
    const view = mount(<AttachmentPreviewStrip attachments={[{ name: 'image.png', rel: 'image.png' }]} workspacePath="/repo" variant="message" />)
    await act(async () => view.root.findByProps({ 'aria-label': 'Open image image.png' }).props.onClick())
    expect(view.root.findByType('dialog').props['aria-label']).toBe('image.png')
    expect(view.root.findByType(ImageViewer).props.path).toBe('image.png')
  })
  it('keeps remote images in an opaque frame without widening app image policy', async () => {
    const view = mount(<ImageViewer src={'https://example.com/image.png?name="<unsafe>'} title="Remote image" />)
    await act(async () => {})
    const frame = view.root.findByType('iframe')
    expect(frame.props.sandbox).toBe('allow-scripts')
    expect(frame.props.referrerPolicy).toBe('no-referrer')
    expect(decodeURIComponent(new URL(frame.props.src).hash.slice(1))).toContain('&quot;&lt;unsafe&gt;')
    expect(read).not.toHaveBeenCalled()
  })
  it('opens base64 images from agent Markdown without reading a workspace file', async () => {
    const view = mount(<ChatArtifacts workspacePath="/repo"><Markdown text={`![Generated](${pixel})`} /></ChatArtifacts>)
    await act(async () => view.root.findAllByType('button')[0].props.onClick())
    expect(view.root.findByType('img').props.src).toBe(pixel)
    expect(read).not.toHaveBeenCalled()
  })
  it('resolves absolute remote image paths against the SSH workspace', () => {
    expect(workspaceFilePathFromHref('/srv/repo/render.png', 'ssh://server/srv/repo')).toBe('render.png')
    expect(workspaceFilePathFromHref('/srv/other/render.png', 'ssh://server/srv/repo')).toBeNull()
    expect(workspaceFilePathFromHref('../render.png', 'ssh://server/srv/repo')).toBeNull()
  })
})
