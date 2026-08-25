import React, { useCallback, useRef, useLayoutEffect, useState, useEffect, useMemo } from 'react'
import { Icon } from '../ui/Icon'
import { ModeSegment } from './ModeSegment'
import { ModelRow, type ModelRowHandle } from './ModelRow'
import { MentionPopover } from './MentionPopover'
import { SlashPopover } from './SlashPopover'
import type { Mode } from './ModeSegment'
import type { EffortLevel } from './EffortPicker'
import type { AgentInfo, ChatAttachment } from '../../types'
import type { McpServerConfig } from '../../hooks/useSettings'
import type { CustomCommand, Prompt, Skill } from '../../types/prompts'
import { effectiveChord, matchesChord, type ActionId } from '../../shortcuts'
import { NotepadIcon } from "@phosphor-icons/react"
import { AttachmentPreviewStrip } from '../attachments/AttachmentPreviewStrip'
import { ComposerBranchPicker } from '../git/BranchPicker'
import type { GitBranchRef } from '../git/git-state'
import { VoiceOrb } from '../voice/VoiceOrb'
import type { VoiceControlSurface } from '../../../../shared/voice-types'
import { ComposerDictationButton } from './ComposerDictationButton'
import { insertDictationText } from './composer-dictation-text'
import { MobileComposerActionMenu, MobileComposerModelMenu } from './MobileComposerMenus'

const MODE_CYCLE: Mode[] = ['Ask', 'Plan', 'Build', 'Full']

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const KEY_LABELS: Record<string, string> = IS_MAC
  ? { '⌘': '⌘', '⌃': '⌃', '⌥': '⌥', '⇧': '⇧', '↵': '↵', '⇥': '⇥', '⌫': '⌫' }
  : { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '↵': 'Enter', '⇥': 'Tab', '⌫': 'Backspace' }
const chordLabel = (chord: string[]) => chord.map(key => KEY_LABELS[key] ?? key).join(IS_MAC ? '' : '+')

const workspaceFileCache = new Map<string, string[]>()
const workspaceFileLoads = new Map<string, Promise<string[]>>()

type SlashItem =
  | { id: string; kind: 'prompt'; title: string; description: string; body: string; prompt: Prompt }
  | { id: string; kind: 'skill'; title: string; description: string; skill: Skill }
  | { id: string; kind: 'command'; title: string; description: string; body: string; command?: CustomCommand }

interface ComposerProps {
  repo:    string
  branch:  string
  workspacePath: string
  mode:    Mode
  setMode: (m: Mode) => void
  value:   string
  onChange: (v: string) => void
  onSend:  () => void
  /** Fires a custom slash-command body immediately when it is picked. */
  onRunCommand?: (body: string) => void
  onQueueFollowUp?: () => void
  queuedFollowUps?: Array<{ id: string; text: string }>
  onRemoveQueuedFollowUp?: (followUpId: string) => void
  /** Newest-first list of the local user's previous sent messages. */
  sentMessageHistory?: string[]
  isRunning?: boolean
  onStop?: () => void
  voiceControl?: VoiceControlSurface
  dictationScopeId?: string

  agents:         AgentInfo[]
  activeAgentId:  string
  onSelectAgent:  (id: string) => void

  model:          string
  onSelectModel:  (m: string) => void

  effort:         EffortLevel
  onSelectEffort: (e: EffortLevel) => void

  mcpEnabled?:     boolean
  mcpServers?:     McpServerConfig[]
  selectedMcpIds?: string[]
  onToggleMcp?:    (id: string) => void

  shortcutOverrides: Record<string, Record<string, string[]>>

  attachments?: ChatAttachment[]
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void

  /** Opens the global Prompt Picker — wired by App.tsx. */
  onOpenPrompts?: () => void
  prompts?: Prompt[]
  skills?: Skill[]
  /** Per-agent custom slash-commands from ~/.crewcode/commands. */
  commands?: CustomCommand[]
  onInsertPromptBody?: (body: string, prompt?: Prompt) => void
  onToggleSkillEnabled?: (skillId: string) => void

  branchPicker?: {
    currentBranch: string
    branches: GitBranchRef[]
    onCheckoutBranch?: (ref: string) => void
    onCreateBranch?: (name: string) => void
    onRefresh?: () => void
  }
}

interface MentionState {
  start: number   // index of the `@`
  query: string
}

interface SlashState {
  start: number
  query: string
}

function findMentionAt(value: string, caret: number): MentionState | null {
  // Walk back from caret until we hit a whitespace or the `@`. If we hit `@`,
  // the chars between (`caret`) form the query.
  let i = caret - 1
  while (i >= 0) {
    const ch = value[i]
    if (ch === '@') {
      const before = value[i - 1]
      // Only trigger if `@` is at start or after whitespace/punctuation
      if (i === 0 || /\s/.test(before) || before === '(' || before === ',') {
        return { start: i, query: value.slice(i + 1, caret) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

function findSlashAt(value: string, caret: number): SlashState | null {
  let i = caret - 1
  while (i >= 0) {
    const ch = value[i]
    if (ch === '/') {
      const before = value[i - 1]
      if (i === 0 || /\s/.test(before) || before === '(' || before === ',') {
        return { start: i, query: value.slice(i + 1, caret) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

function attachmentFromRel(rel: string, mimeType?: string): ChatAttachment {
  const normalized = rel.replace(/\\/g, '/')
  const name = normalized.split('/').pop() || normalized
  return { rel, name, mimeType }
}

export function Composer({
  repo, branch, workspacePath, mode, setMode, value, onChange, onSend,
  onRunCommand,
  onQueueFollowUp,
  queuedFollowUps = [],
  onRemoveQueuedFollowUp,
  sentMessageHistory = [],
  isRunning, onStop, voiceControl, dictationScopeId,
  agents, activeAgentId, onSelectAgent,
  model, onSelectModel, effort, onSelectEffort,
  mcpEnabled, mcpServers, selectedMcpIds, onToggleMcp,
  shortcutOverrides,
  attachments: attachmentsProp, onAttachmentsChange,
  onOpenPrompts,
  prompts = [],
  skills = [],
  commands = [],
  onInsertPromptBody,
  onToggleSkillEnabled,
  branchPicker,
}: ComposerProps) {
  const taRef        = useRef<HTMLTextAreaElement>(null)
  const valueRef     = useRef(value)
  valueRef.current = value
  const modelRowRef  = useRef<ModelRowHandle>(null)
  // Desktop keeps the hover row open while one of its pickers is active.
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const inputBlurTimerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const historyIndexRef = useRef(-1)
  const historyDraftRef = useRef('')

  const [files,      setFiles]      = useState<string[]>([])
  const [mention,    setMention]    = useState<MentionState | null>(null)
  const [slash,      setSlash]      = useState<SlashState | null>(null)
  const [internalAttachments, setInternalAttachments] = useState<ChatAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)

  const insertDictation = useCallback((transcript: string) => {
    const textarea = taRef.current
    const latestValue = valueRef.current
    const start = textarea?.selectionStart ?? latestValue.length
    const end = textarea?.selectionEnd ?? start
    const inserted = insertDictationText(latestValue, start, end, transcript)
    onChange(inserted.value)
    requestAnimationFrame(() => {
      const current = taRef.current
      if (!current) return
      current.focus()
      current.setSelectionRange(inserted.caret, inserted.caret)
    })
  }, [onChange])
  const dragCounter = useRef(0)
  const attachments = attachmentsProp ?? internalAttachments
  const composerHasText = value.trim().length > 0
  const canSend = isRunning || composerHasText

  const setAttachments = (next: ChatAttachment[]) => {
    setInternalAttachments(next)
    onAttachmentsChange?.(next)
  }

  const resetHistoryNavigation = () => {
    historyIndexRef.current = -1
    historyDraftRef.current = ''
  }

  const focusTextareaEnd = (next: string) => {
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      const pos = next.length
      ta.setSelectionRange(pos, pos)
    })
  }

  const handleValueChange = (next: string) => {
    resetHistoryNavigation()
    onChange(next)
  }

  const handleSend = () => {
    if (isRunning) {
      if (composerHasText) {
        resetHistoryNavigation()
        onQueueFollowUp?.()
        return
      }
      onStop?.()
      return
    }
    if (!composerHasText) return
    resetHistoryNavigation()
    onSend()
    // Clear chips after the message ships so they don't linger in the composer.
    if (attachments.length > 0) setAttachments([])
  }

  // Keep workspace/session switches snappy: file discovery can walk large repos
  // over local disk or SSH, so only do it when the @ mention UI actually opens.
  useEffect(() => {
    if (!workspacePath) { setFiles([]); return }
    setFiles(workspaceFileCache.get(workspacePath) ?? [])
  }, [workspacePath])

  useEffect(() => {
    if (!mention || !workspacePath || workspaceFileCache.has(workspacePath)) return
    let cancelled = false
    const api = window.electronAPI
    if (!api) return
    const load = workspaceFileLoads.get(workspacePath) ?? api.fsListFiles(workspacePath)
      .then(res => {
        const next = res.files ?? []
        workspaceFileCache.set(workspacePath, next)
        workspaceFileLoads.delete(workspacePath)
        return next
      })
      .catch(() => {
        workspaceFileLoads.delete(workspacePath)
        return []
      })
    workspaceFileLoads.set(workspacePath, load)
    load.then(next => { if (!cancelled) setFiles(next) })
    return () => { cancelled = true }
  }, [mention, workspacePath])

  // Auto-grow
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [value])

  // Listen for app-wide composer-focus requests (Mission Control "open agent",
  // and other surfaces that drop a user into the composer).
  useEffect(() => {
    const fn = (): void => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      const len = ta.value.length
      ta.setSelectionRange(len, len)
    }
    window.addEventListener('crewcode:focus-composer', fn)
    return () => window.removeEventListener('crewcode:focus-composer', fn)
  }, [])

  const updateMentionFromCaret = () => {
    const ta = taRef.current
    if (!ta) return
    const caret = ta.selectionStart ?? value.length
    setMention(findMentionAt(value, caret))
    setSlash(findSlashAt(value, caret))
  }

  useEffect(() => {
    // Re-evaluate after value changes (insertion/deletion)
    const ta = taRef.current
    if (!ta) return
    const caret = ta.selectionStart ?? value.length
    setMention(findMentionAt(value, caret))
    setSlash(findSlashAt(value, caret))
  }, [value])

  const insertAtCursor = (token: string) => {
    const ta = taRef.current
    if (!ta) { onChange(value + token); return }
    const start = ta.selectionStart ?? value.length
    const end   = ta.selectionEnd   ?? value.length
    const next  = value.slice(0, start) + token + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + token.length
      ta.setSelectionRange(pos, pos)
    })
  }

  const pickMention = (rel: string) => {
    const ta = taRef.current
    if (!ta || !mention) return
    const caret = ta.selectionStart ?? value.length
    const before = value.slice(0, mention.start)
    const after  = value.slice(caret)
    const token  = `@${rel} `
    const next   = before + token + after
    onChange(next)
    if (!attachments.some(attachment => attachment.rel === rel)) {
      setAttachments([...attachments, attachmentFromRel(rel)])
    }
    setMention(null)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = before.length + token.length
      ta.setSelectionRange(pos, pos)
    })
  }

  const slashCategory = useMemo<'prompt' | 'skill' | 'command' | null>(() => {
    const q = (slash?.query ?? '').trim().toLowerCase()
    if (q === 'prompt' || q === 'prompts') return 'prompt'
    if (q === 'skill' || q === 'skills') return 'skill'
    if (q === 'command' || q === 'commands') return 'command'
    return null
  }, [slash?.query])

  // Custom commands are global: every provider sees every ~/.crewcode/commands/*.md.
  const slashItems = useMemo<SlashItem[]>(() => {
    const q = (slash?.query ?? '').trim().toLowerCase()
    const search = slashCategory ? '' : q
    const promptItems = prompts
      .filter(p => slashCategory && slashCategory !== 'prompt' ? false : (!search || p.title.toLowerCase().includes(search) || p.description.toLowerCase().includes(search)))
      .map(p => ({ id: `prompt:${p.id}`, kind: 'prompt' as const, title: p.title, description: p.description, body: p.body, prompt: p }))
    const skillItems = skills
      .filter(s => slashCategory && slashCategory !== 'skill' ? false : (!search || s.title.toLowerCase().includes(search) || s.description.toLowerCase().includes(search)))
      .map(s => ({ id: `skill:${s.id}`, kind: 'skill' as const, title: s.title, description: s.description, skill: s }))
    const builtInCommands = [
      { id: 'builtin:compact', kind: 'command' as const, title: '/compact', description: 'compact the current provider session', body: '/compact' },
      { id: 'builtin:handoff', kind: 'command' as const, title: '/handoff', description: 'hand off context to a new or used chat', body: '/handoff' },
      { id: 'builtin:add-dir', kind: 'command' as const, title: '/add-dir', description: 'attach an external directory to this session', body: '/add-dir' },
      { id: 'builtin:remove-dir', kind: 'command' as const, title: '/remove-dir', description: 'remove an external directory from this session', body: '/remove-dir' },
    ].filter(c => slashCategory && slashCategory !== 'command' ? false : (!search || c.title.toLowerCase().includes(search) || c.description.toLowerCase().includes(search)))
    const commandItems = commands
      .filter(c => slashCategory && slashCategory !== 'command' ? false : (!search || c.name.toLowerCase().includes(search) || c.description.toLowerCase().includes(search)))
      .map(c => ({ id: `command:${c.id}`, kind: 'command' as const, title: c.name, description: c.description, body: c.body, command: c }))
    return [...builtInCommands, ...commandItems, ...promptItems, ...skillItems].slice(0, 50)
  }, [prompts, skills, commands, slash?.query, slashCategory])

  const pickSlash = (itemId: string) => {
    const ta = taRef.current
    if (!ta || !slash) return
    const caret = ta.selectionStart ?? value.length
    const before = value.slice(0, slash.start)
    const after = value.slice(caret).replace(/^\s*/, '')
    const item = slashItems.find(x => x.id === itemId)
    if (!item) return
    // Custom commands (those backed by a ~/.crewcode/commands file) fire the
    // instant they're picked: strip the `/query` token, leave any surrounding
    // draft untouched, and dispatch the body straight to the agent. Built-in
    // commands like /compact have no `command` and fall through to be inserted,
    // since they need send()'s special-case handling on Enter.
    if (item.kind === 'command' && onRunCommand && (item.command || item.id === 'builtin:handoff' || item.id === 'builtin:add-dir' || item.id === 'builtin:remove-dir')) {
      const next = (before + after).trimStart()
      onChange(next)
      setSlash(null)
      onRunCommand(item.body)
      requestAnimationFrame(() => {
        ta.focus()
        const pos = Math.min(before.length, next.length)
        ta.setSelectionRange(pos, pos)
      })
      return
    }
    if (item.kind === 'prompt' || item.kind === 'command') {
      const insert = item.body + (after ? `\n\n${after}` : '')
      onChange((before + insert).trimStart())
      if (item.kind === 'prompt') onInsertPromptBody?.('', item.prompt)
      requestAnimationFrame(() => {
        ta.focus()
        const pos = before.length + item.body.length
        ta.setSelectionRange(pos, pos)
      })
    } else {
      const next = (before + after).trimStart()
      onChange(next)
      onToggleSkillEnabled?.(item.skill.id)
      requestAnimationFrame(() => {
        ta.focus()
        const pos = before.length
        ta.setSelectionRange(pos, pos)
      })
    }
    setSlash(null)
  }

  const removeAttachment = (rel: string) => {
    setAttachments(attachments.filter(attachment => attachment.rel !== rel))
    // Also strip the `@rel` token from the text (best-effort)
    const re = new RegExp(`@${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s?`, 'g')
    const stripped = value.replace(re, '')
    if (stripped !== value) onChange(stripped)
  }

  // Copy files into the workspace's `.crewcode/attachments/`. The rel paths
  // stay out of the visible input — the chip row is the only user-facing cue.
  // They ride along on the next send via the lifted `attachments` state.
  const attachFiles = async (files: File[]) => {
    if (!workspacePath || files.length === 0) return
    const api = window.electronAPI
    if (!api) return
    const items = await Promise.all(files.map(async (file) => ({
      name: file.name || `pasted-${Date.now()}`,
      data: await file.arrayBuffer(),
    })))
    const res = await api.attachmentsImport(workspacePath, items)
    if (res.error || !res.rels) {
      console.error('attachment import failed:', res.error)
      return
    }
    const toAdd = res.rels
      .map((rel, index) => attachmentFromRel(rel, files[index]?.type || undefined))
      .filter(attachment => !attachments.some(existing => existing.rel === attachment.rel))
    if (toAdd.length === 0) return
    setAttachments([...attachments, ...toAdd])
  }

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''   // reset so picking the same file twice still fires onChange
    if (picked.length > 0) void attachFiles(picked)
  }

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    dragCounter.current += 1
    if (dragCounter.current === 1) setIsDragging(true)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = () => {
    if (dragCounter.current === 0) return
    dragCounter.current -= 1
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setIsDragging(false)
    }
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragging(false)
    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length > 0) void attachFiles(dropped)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items ?? [])
    const fileItems = items.filter(item => item.kind === 'file')
    if (fileItems.length === 0) return
    e.preventDefault()
    const files: File[] = fileItems
      .map(item => item.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length > 0) void attachFiles(files)
  }

  const promptPickerShortcut = useMemo(
    () => chordLabel(effectiveChord('prompt-picker', shortcutOverrides)),
    [shortcutOverrides],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Let MentionPopover handle nav keys when open
    if ((mention || slash) && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      return
    }

    const ta = taRef.current
    const selectionStart = ta?.selectionStart ?? value.length
    const selectionEnd = ta?.selectionEnd ?? value.length
    const selectionCollapsed = selectionStart === selectionEnd
    const caretOnFirstLine = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) === -1
    const caretOnLastLine = value.indexOf('\n', selectionStart) === -1
    const plainArrow = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.nativeEvent.isComposing

    if (plainArrow && selectionCollapsed && e.key === 'ArrowUp' && caretOnFirstLine && sentMessageHistory.length > 0) {
      e.preventDefault()
      const browsingHistory = historyIndexRef.current >= 0 && sentMessageHistory[historyIndexRef.current] === value
      if (!browsingHistory) {
        historyDraftRef.current = value
        historyIndexRef.current = -1
      }
      const nextIndex = Math.min(historyIndexRef.current + 1, sentMessageHistory.length - 1)
      historyIndexRef.current = nextIndex
      const next = sentMessageHistory[nextIndex] ?? value
      onChange(next)
      focusTextareaEnd(next)
      return
    }

    const browsingHistory = historyIndexRef.current >= 0 && sentMessageHistory[historyIndexRef.current] === value
    if (plainArrow && selectionCollapsed && e.key === 'ArrowDown' && caretOnLastLine && browsingHistory) {
      e.preventDefault()
      const nextIndex = historyIndexRef.current - 1
      const next = nextIndex >= 0 ? (sentMessageHistory[nextIndex] ?? value) : historyDraftRef.current
      historyIndexRef.current = nextIndex
      if (nextIndex < 0) historyDraftRef.current = ''
      onChange(next)
      focusTextareaEnd(next)
      return
    }

    const tryAction = (id: ActionId, handler: () => void): boolean => {
      if (!matchesChord(e.nativeEvent, effectiveChord(id, shortcutOverrides))) return false
      e.preventDefault()
      handler()
      return true
    }

    if (tryAction('send-message', handleSend)) return
    if (tryAction('cycle-mode', () => {
      const idx = MODE_CYCLE.indexOf(mode)
      setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length])
    })) return
    if (tryAction('insert-context', () => insertAtCursor('@'))) return
    if (tryAction('switch-model', () => modelRowRef.current?.cycleModel(1))) return
  }

  return (
    <div
      className={`composer-wrap${isDragging ? ' is-dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="composer">
        <div className="composer-main">
          {queuedFollowUps.length > 0 && (
            <div className="composer-queue" aria-label="Queued follow-up messages">
              <div className="composer-queue-head">
                <Icon name="clock" size={12} />
                <span>{queuedFollowUps.length} queued follow-up{queuedFollowUps.length === 1 ? '' : 's'}</span>
              </div>
              <div className="composer-queue-list">
                {queuedFollowUps.slice(0, 3).map(item => (
                  <div key={item.id} className="composer-queue-item">
                    <span className="composer-queue-text">{item.text}</span>
                    <button type="button" className="composer-queue-remove" onClick={() => onRemoveQueuedFollowUp?.(item.id)} aria-label="Remove queued follow-up">
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))}
                {queuedFollowUps.length > 3 && <div className="composer-queue-more">+{queuedFollowUps.length - 3} more queued</div>}
              </div>
            </div>
          )}
          <AttachmentPreviewStrip
            attachments={attachments}
            workspacePath={workspacePath}
            variant="composer"
            onRemove={removeAttachment}
          />
          <div className="ta-wrap">
            <textarea
              ref={taRef}
              value={value}
              rows={1}
              placeholder={`${mode}: message ${repo} • ${branch}`}
              onChange={e => handleValueChange(e.target.value)}
              onKeyDown={onKeyDown}
              onKeyUp={updateMentionFromCaret}
              onClick={updateMentionFromCaret}
              onPaste={onPaste}
              onFocus={() => {
                if (inputBlurTimerRef.current !== null) window.clearTimeout(inputBlurTimerRef.current)
                inputBlurTimerRef.current = null
              }}
              onBlur={() => {
                if (inputBlurTimerRef.current !== null) window.clearTimeout(inputBlurTimerRef.current)
                inputBlurTimerRef.current = window.setTimeout(() => {
                  inputBlurTimerRef.current = null
                  setMention(null)
                  setSlash(null)
                }, 120)
              }}
            />
            {mention && (
              <MentionPopover
                files={files}
                query={mention.query}
                onPick={pickMention}
                onClose={() => setMention(null)}
              />
            )}
            {slash && (
              <SlashPopover
                items={slashItems.map(item => ({
                  id: item.id,
                  kind: item.kind,
                  title: item.title,
                  description: item.description,
                }))}
                query={slashCategory ? '' : slash.query}
                onPick={pickSlash}
                onClose={() => setSlash(null)}
              />
            )}
          </div>
          <div className="bar">
            <div className="left-bar">
              <div className="desktop-composer-actions">
                <button
                  className="ibtn"
                  title="attach files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Icon name="paperclip" />
                </button>
                <button
                  className="ibtn ibtn-prompts"
                  title={`prompts (${promptPickerShortcut ? `${promptPickerShortcut} · ` : ''}or type / to browse prompts & skills)`}
                  onClick={onOpenPrompts}
                  type="button"
                >
                  <NotepadIcon weight="duotone" />
                </button>
                {branchPicker && (
                  <ComposerBranchPicker
                    currentBranch={branchPicker.currentBranch}
                    branches={branchPicker.branches}
                    onCheckoutBranch={branchPicker.onCheckoutBranch}
                    onCreateBranch={branchPicker.onCreateBranch}
                    onRefresh={branchPicker.onRefresh}
                  />
                )}
              </div>
              <div className="mobile-composer-actions">
                <MobileComposerActionMenu
                  onAttach={() => fileInputRef.current?.click()}
                  onOpenPrompts={onOpenPrompts}
                  branchPicker={branchPicker}
                />
                <MobileComposerModelMenu
                  agents={agents}
                  activeAgentId={activeAgentId}
                  onSelectAgent={onSelectAgent}
                  model={model}
                  onSelectModel={onSelectModel}
                  effort={effort}
                  onSelectEffort={onSelectEffort}
                  mode={mode}
                  setMode={setMode}
                  mcpEnabled={mcpEnabled}
                  mcpServers={mcpServers}
                  selectedMcpIds={selectedMcpIds}
                  onToggleMcp={onToggleMcp}
                />
              </div>
              {dictationScopeId ? (
                <ComposerDictationButton
                  scopeId={dictationScopeId}
                  onTranscript={insertDictation}
                />
              ) : null}
            </div>
            <div className="composer-send-actions">
              {voiceControl ? (
                <VoiceOrb
                  control={voiceControl}
                  placement="composer"
                  shortcutOverrides={shortcutOverrides}
                />
              ) : null}
              {isRunning && composerHasText && (
                <button type="button" className="sendbtn stop ghost-stop" onClick={onStop}>
                  <Icon name="square" size={14} /> Stop
                </button>
              )}
              <button className={`sendbtn${isRunning && !composerHasText ? ' stop' : ''}`} onClick={handleSend} disabled={!canSend}>
                <Icon name={isRunning ? (composerHasText ? 'clock' : 'square') : 'send'} size={14} />
                {isRunning ? (composerHasText ? 'Queue' : 'Stop') : ''}
              </button>
            </div>
          </div>
        </div>
        {/* Desktop reveals this row from the lower hover strip. Mobile replaces
            it with the selected-model button in the main toolbar. */}
        <div className={`model-row-reveal${modelPickerOpen ? ' pinned' : ''}`}>
          <div className="model-row-handle" aria-hidden />
          <div className="model-row-slide">
            <ModelRow
              ref={modelRowRef}
              agents={agents}
              activeAgentId={activeAgentId}
              onSelectAgent={onSelectAgent}
              model={model}
              onSelectModel={onSelectModel}
              effort={effort}
              mode={mode}
              setMode={setMode}
              onSelectEffort={onSelectEffort}
              mcpEnabled={mcpEnabled}
              mcpServers={mcpServers}
              selectedMcpIds={selectedMcpIds}
              onToggleMcp={onToggleMcp}
              onOpenChange={setModelPickerOpen}
            />
          </div>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={onFileInputChange}
        style={{ display: 'none' }}
        aria-hidden
        tabIndex={-1}
      />
    </div>
  )
}
