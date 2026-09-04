import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer'

import { clearGitTabMemory, readGitTabMemory, resetGitTabMemoryForTests, writeGitTabMemory } from './git-tab-memory'
import { GitPageCommit } from './GitPageCommit'

const page = readFileSync(fileURLToPath(new URL('./GitPage.tsx', import.meta.url)), 'utf8')
const pageCommit = readFileSync(fileURLToPath(new URL('./GitPageCommit.tsx', import.meta.url)), 'utf8')
const sidebar = readFileSync(fileURLToPath(new URL('./GitSidebar.tsx', import.meta.url)), 'utf8')
const createPullRequest = readFileSync(fileURLToPath(new URL('./PullRequestModal.tsx', import.meta.url)), 'utf8')
const browser = readFileSync(fileURLToPath(new URL('./PullRequestBrowser.tsx', import.meta.url)), 'utf8')

describe('Git tab session memory', () => {
  afterEach(resetGitTabMemoryForTests)

  it('keeps independent drafts per exact tab/worktree key', () => {
    writeGitTabMemory('tab-a:commit', { message: 'first', amend: false })
    writeGitTabMemory('tab-b:commit', { message: 'second', amend: true })

    expect(readGitTabMemory('tab-a:commit')).toEqual({ message: 'first', amend: false })
    expect(readGitTabMemory('tab-b:commit')).toEqual({ message: 'second', amend: true })
    clearGitTabMemory('tab-a:commit')
    expect(readGitTabMemory('tab-a:commit')).toBeUndefined()
    expect(readGitTabMemory('tab-b:commit')).toEqual({ message: 'second', amend: true })
  })

  it('wires meaningful Git and PR drafts to session memory', () => {
    expect(page).toContain('pageMemoryKey')
    expect(page).toContain('memoryKey={`${stateKey}:page-commit`}')
    expect(pageCommit).toContain('writeGitTabMemory<GitCommitDraft>')
    expect(sidebar).toContain('sidebarMemoryKey')
    expect(sidebar).toContain('memoryKey={`${stateKey ?? workspace.path}:sidebar-commit`}')
    expect(createPullRequest).toContain('writeGitTabMemory<PullRequestCreationDraft>')
    expect(createPullRequest).toContain('clearGitTabMemory(memoryKey)')
    expect(browser).toContain('pendingCommentsByNumber?:')
    expect(browser).toContain('reviewBody, pendingCommentsByNumber')
  })

  it('restores a commit draft after the Git tab unmounts', () => {
    const props = { memoryKey: 'workspace:tab:commit', branch: 'dev', stagedCount: 1, onCommit: async () => true }
    let renderer!: ReactTestRenderer
    act(() => { renderer = TestRenderer.create(createElement(GitPageCommit, props)) })
    act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'keep this commit message' } }))
    act(() => renderer.root.findByType('input').props.onChange({ target: { checked: true } }))
    act(() => renderer.unmount())
    act(() => { renderer = TestRenderer.create(createElement(GitPageCommit, props)) })

    expect(renderer.root.findByType('textarea').props.value).toBe('keep this commit message')
    expect(renderer.root.findByType('input').props.checked).toBe(true)
    act(() => renderer.unmount())
  })

  it('keeps the commit draft when the Git operation fails', async () => {
    const props = { memoryKey: 'workspace:tab:failed', branch: 'dev', stagedCount: 1, onCommit: async () => false }
    let renderer!: ReactTestRenderer
    act(() => { renderer = TestRenderer.create(createElement(GitPageCommit, props)) })
    act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'retry this commit' } }))
    const commitButton = renderer.root.findAllByType('button').find(button => button.props.children?.some?.((child: unknown) => child === ' commit'))
    expect(commitButton).toBeDefined()
    await act(async () => { commitButton!.props.onClick() })

    expect(renderer.root.findByType('textarea').props.value).toBe('retry this commit')
    act(() => renderer.unmount())
  })
})
