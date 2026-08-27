import {
  buildUnifiedDiff,
  extractProviderPatchChanges,
  normalizePatchForPierre,
  pathField,
} from '../../hooks/turn-file-edit-detect'
import type { Message, ToolCallMessage, TurnFileChange } from '../../types'

export interface TurnChangeEntry {
  turnId:  string
  time:    string
  userMsg: string | null
  changes: TurnFileChange[]
}

export interface TurnChangeTarget {
  turnId:   string
  filePath: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Every renderable file change carried by one tool transcript row. */
export function changesFromToolMessage(message: ToolCallMessage): TurnFileChange[] {
  const captured = message.fileChanges ?? (message.fileChange ? [message.fileChange] : [])
  if (captured.length > 0) return captured

  const providerPatches = extractProviderPatchChanges(message.metadata, message.args, message.result)
  if (providerPatches.length > 0) {
    return providerPatches.map(change => ({
      path: change.path,
      beforeText: '',
      afterText: '',
      patch: change.patch,
    }))
  }

  const args = asRecord(message.args) ?? {}
  const metadata = message.metadata ?? {}
  const path = pathField(args)
  const rawPatch = asString(metadata.diff) ?? asString(args.patch) ?? asString(message.result)
  if (!path || !rawPatch || !/^diff --git |^--- |^@@ /m.test(rawPatch)) return []
  return [{ path, beforeText: '', afterText: '', patch: normalizePatchForPierre(path, rawPatch) }]
}

function hasSnapshot(change: TurnFileChange): boolean {
  return change.beforeText !== '' || change.afterText !== ''
}

function canonicalPatchHeader(path: string, patch: string): string {
  const name = path.replace(/^\/+/, '') || 'file'
  const lines = patch.split('\n')
  const firstHunk = lines.findIndex(line => line.startsWith('@@ '))
  const source = firstHunk >= 0 ? lines.slice(0, firstHunk) : []
  const header = source.filter(line => !line.startsWith('diff --git '))
  const hasOld = header.some(line => line.startsWith('--- '))
  const hasNew = header.some(line => line.startsWith('+++ '))
  return [
    `diff --git a/${name} b/${name}`,
    ...header,
    ...(!hasOld ? [`--- a/${name}`] : []),
    ...(!hasNew ? [`+++ b/${name}`] : []),
  ].join('\n')
}

function patchHunks(patch: string): string {
  const lines = patch.split('\n')
  const firstHunk = lines.findIndex(line => line.startsWith('@@ '))
  if (firstHunk < 0) return ''
  return lines.slice(firstHunk).join('\n').trimEnd()
}

/** Keep repeated provider edits parseable as one single-file Pierre patch. */
function mergeProviderPatches(path: string, first: string, next: string): string {
  if (first === next) return first
  const hunks = [patchHunks(first), patchHunks(next)].filter(Boolean)
  if (hunks.length === 0) return next || first
  return `${canonicalPatchHeader(path, first)}\n${hunks.join('\n')}\n`
}

/**
 * Merge repeated edits without dropping earlier hunks. Snapshot-backed edits
 * become one before→final patch; provider-only patches remain concatenated in
 * execution order so every reported mutation stays inspectable.
 */
export function mergeTurnFileChanges(changes: TurnFileChange[]): TurnFileChange[] {
  const byPath = new Map<string, TurnFileChange>()
  for (const change of changes) {
    const current = byPath.get(change.path)
    if (!current) {
      byPath.set(change.path, { ...change })
      continue
    }

    if (hasSnapshot(current) && hasSnapshot(change)) {
      const patch = buildUnifiedDiff(change.path, current.beforeText, change.afterText)
      byPath.set(change.path, {
        path: change.path,
        beforeText: current.beforeText,
        afterText: change.afterText,
        patch: patch || change.patch || current.patch,
      })
      continue
    }

    byPath.set(change.path, {
      path: change.path,
      beforeText: current.beforeText,
      afterText: change.afterText,
      patch: mergeProviderPatches(change.path, current.patch, change.patch),
    })
  }
  return [...byPath.values()]
}

/** One complete, ordered entry per turn for the drawer and work-log chips. */
export function collectTurnChangeEntries(messages: Message[]): TurnChangeEntry[] {
  const agentByTurn = new Map<string, { index: number; time: string }>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.kind === 'agent' && message.turnId) {
      agentByTurn.set(message.turnId, { index, time: message.time })
    }
  }

  const byTurn = new Map<string, TurnChangeEntry>()
  for (const message of messages) {
    if (message.kind !== 'toolcall') continue
    const changes = changesFromToolMessage(message)
    if (changes.length === 0) continue
    const agent = agentByTurn.get(message.turnId)
    let entry = byTurn.get(message.turnId)
    if (!entry) {
      const user = agent && agent.index > 0
        ? [...messages.slice(0, agent.index)].reverse().find(candidate => candidate.kind === 'user')
        : null
      entry = {
        turnId: message.turnId,
        time: agent?.time ?? message.time,
        userMsg: user?.kind === 'user' ? user.text : null,
        changes: [],
      }
      byTurn.set(message.turnId, entry)
    }
    entry.changes.push(...changes)
  }

  return [...byTurn.values()]
    .map(entry => ({ ...entry, changes: mergeTurnFileChanges(entry.changes) }))
    .reverse()
}

export function changesForToolMessages(messages: ToolCallMessage[]): TurnFileChange[] {
  return mergeTurnFileChanges(messages.flatMap(changesFromToolMessage))
}
