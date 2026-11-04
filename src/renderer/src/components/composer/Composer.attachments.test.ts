import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { renderHook } from '../../hooks/hook-test-host'
import { useComposerSend, type UseComposerSendOpts } from '../../hooks/useComposerSend'
import type { ChatAttachment, Message } from '../../types'

vi.mock('./ModelRow', async () => {
  const { forwardRef } = await import('react')
  return { ModelRow: forwardRef(() => null) }
})
vi.mock('./ModeSegment', () => ({ ModeSegment: () => null }))
vi.mock('./MentionPopover', () => ({ MentionPopover: () => null }))
vi.mock('./SlashPopover', () => ({ SlashPopover: () => null }))
vi.mock('./MobileComposerMenus', () => ({ MobileComposerActionMenu: () => null, MobileComposerModelMenu: () => null }))
vi.mock('./ComposerDictationButton', () => ({ ComposerDictationButton: () => null }))
vi.mock('../git/BranchPicker', () => ({ ComposerBranchPicker: () => null }))
vi.mock('../voice/VoiceOrb', () => ({ VoiceOrb: () => null }))
vi.mock('../attachments/AttachmentPreviewStrip', () => ({ AttachmentPreviewStrip: () => null }))

afterEach(() => vi.unstubAllGlobals())

it.each([true, false])('preserves images across delayed placement (accepted=%s)', async accepted => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const image: ChatAttachment = { rel: '.crewcode/attachments/screenshot.png', name: 'screenshot.png', mimeType: 'image/png' }
  let attachments = [image]
  let messages: Message[] = []
  const clear = vi.fn((next: ChatAttachment[]) => { attachments = next })
  const prompt = vi.fn(async () => ({ ok: true }))
  const opts: UseComposerSendOpts = {
    activeWs: 'ws', activeTabId: 'tab', sessActive: 'session', composer: 'Look at this',
    setComposer: vi.fn(), setMessages: update => { messages = update(messages) },
    agents: [{ id: 'pi', name: 'Pi', path: '/pi', available: true, transport: 'bridge' }],
    activeAgentId: 'pi', model: '', effort: 'medium', mode: 'build', effectivePath: '/repo',
    bridges: { ensureBridge: vi.fn(async () => ({ bridgeId: 'bridge' })), prompt, dropBridge: vi.fn() },
    pty: { addAgent: vi.fn(), write: vi.fn() }, activeAgentPane: null,
    enabledSkills: [], skillsDeliveredTo: () => [], markSkillsDelivered: vi.fn(),
    lastDeliveredMode: () => 'build', markModeDelivered: vi.fn(), getAttachments: () => attachments,
  }
  const hook = renderHook(useComposerSend, opts)
  let resolvePlacement!: (value: boolean) => void
  const placement = new Promise<boolean>(resolve => { resolvePlacement = resolve })
  let sending!: Promise<void>
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(createElement(Composer, {
      repo: 'repo', branch: 'main', workspacePath: '/repo', mode: 'Build', setMode: vi.fn(),
      value: opts.composer, onChange: vi.fn(),
      onSend: () => {
        sending = (async () => {
          if (!await placement) return
          const dispatched = hook.result.current.send()
          clear([])
          await dispatched
        })()
      },
      agents: opts.agents, activeAgentId: 'pi', onSelectAgent: vi.fn(),
      model: '', onSelectModel: vi.fn(), effort: 'medium', onSelectEffort: vi.fn(),
      onSelectCrewCoderMode: vi.fn(), crewcoderApprovalMode: 'review', onSelectCrewCoderApprovalMode: vi.fn(),
      shortcutOverrides: {}, attachments, onAttachmentsChange: clear,
    }))
  })
  act(() => renderer.root.findAllByType('button').find(button => button.props.className === 'sendbtn')!.props.onClick())
  expect(clear).not.toHaveBeenCalled()
  expect(prompt).not.toHaveBeenCalled()

  await act(async () => { resolvePlacement(accepted); await sending })
  if (accepted) {
    expect(messages.find(message => message.kind === 'user')).toMatchObject({ attachments: [image] })
    expect(prompt).toHaveBeenCalledWith('bridge', expect.stringContaining('@' + image.rel), undefined)
    expect(attachments).toEqual([])
  } else {
    expect(messages).toEqual([])
    expect(prompt).not.toHaveBeenCalled()
    expect(attachments).toEqual([image])
  }
  act(() => renderer.unmount())
  hook.unmount()
})
