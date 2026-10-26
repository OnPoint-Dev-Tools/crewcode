import React from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { CodeEditor } from './CodeEditor'
import { ImageViewer } from '../images/ImageViewer'

vi.mock('../images/ImageViewer', () => ({ ImageViewer: () => null }))
vi.mock('./FileTree', () => ({ FileTree: () => null }))
vi.mock('./CrewCodeMirrorEditor', () => ({ CrewCodeMirrorEditor: () => { throw new Error('Image opened as text') } }))
vi.mock('./useTypeScriptLanguageServer', () => ({ useTypeScriptLanguageServer: () => ({ problems: [], status: 'idle' }) }))
vi.mock('../../hooks/useMobileLayout', () => ({ useMobileLayout: () => false }))
vi.mock('./bearded-file-icons', () => ({ BeardedFileIcon: () => null }))

describe('image editor tabs', () => {
  it('renders the shared viewer, avoids text reads, and refuses save/format shortcuts', async () => {
    const readText = vi.fn()
    const listeners = new Map<string, (event: unknown) => void>()
    vi.stubGlobal('window', {
      electronAPI: { fsReadFile: readText },
      addEventListener: (event: string, listener: (event: unknown) => void) => listeners.set(event, listener),
      removeEventListener: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
    })
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    const save = vi.fn()
    const format = vi.fn()
    let view!: ReturnType<typeof create>
    try {
      await act(async () => { view = create(<CodeEditor root="/repo" activeRel="image.png" tabs={[{ rel: 'image.png', name: 'image.png', text: '', originalText: '', size: 0 }]} cursorMap={{}} scrollMap={{}} onSaveFile={save} onFormatFile={format} />) })
      expect(view.root.findByType(ImageViewer).props.path).toBe('image.png')
      expect(readText).not.toHaveBeenCalled()
      expect(view.root.findAllByType('button').some(button => /format \(/.test(button.props.title ?? ''))).toBe(false)
      await act(async () => {
        listeners.get('keydown')?.({ key: 's', ctrlKey: true, preventDefault: vi.fn() })
        listeners.get('keydown')?.({ key: 'f', ctrlKey: true, shiftKey: true, preventDefault: vi.fn() })
      })
      expect(save).not.toHaveBeenCalled()
      expect(format).not.toHaveBeenCalled()
    } finally {
      act(() => view?.unmount())
      vi.unstubAllGlobals()
    }
  })
})
