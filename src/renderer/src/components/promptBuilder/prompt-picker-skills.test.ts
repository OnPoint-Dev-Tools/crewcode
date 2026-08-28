import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const picker = readFileSync(fileURLToPath(new URL('./PromptPicker.tsx', import.meta.url)), 'utf8')
const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/prompt-builder.css', import.meta.url)), 'utf8')

describe('composer prompt and skill picker', () => {
  it('separates prompts and skills into accessible tabs', () => {
    expect(picker).toContain("type PickerTab = 'prompts' | 'skills'")
    expect(picker).toContain('role="tablist"')
    expect(picker).toContain('Prompts <span>{prompts.length}</span>')
    expect(picker).toContain('Skills <span>{skills.length}</span>')
  })

  it('keeps prompt insertion and skill toggling as distinct actions', () => {
    expect(picker).toContain('prompt ? pickPrompt(prompt) : skill && onToggleSkill(skill)')
    expect(picker).toContain("tab === 'prompts' ? 'insert' : 'toggle'")
    expect(app).toContain('skills={promptBuilderLib.skills}')
    expect(app).toContain('const sessionId = promptPickerTarget?.sessionId ?? promptBuilderSessionId')
    expect(app).toContain('toggleSkillForSession(sessionId, skill.id)')
    expect(app).toContain("promptLib.incUsage('skills', skill.id)")
  })

  it('captures the exact composer and session when opened from embedded chat surfaces', () => {
    expect(app).toContain('setPromptPickerTarget({ sessionId, composerId })')
    expect(app).toContain('openPromptPicker(chatSessions.getActiveSession(pane.id)?.id, pane.id)')
    expect(app).toContain('openPromptPicker(tabActiveSession?.id, pinnedSessionId ?? tabId)')
    expect(app).toContain('openPromptPicker(chatSessions.getActiveSession(tabId)?.id, tabId)')
    expect(app).toContain('composerDraftActions().set(promptPickerTarget.composerId')
  })

  it('shows session-scoped enabled state and keeps skill rows multi-select', () => {
    expect(picker).toContain('aria-pressed={skill ? skill.enabled : undefined}')
    expect(picker).toContain("skill.enabled ? 'enabled' : 'enable'")
    expect(picker).not.toMatch(/onToggleSkill\(skill\)[\s\S]{0,80}onClose\(\)/)
    expect(styles).toContain('.ppicker-skill-state.enabled')
  })

  it('keeps phone tabs and list rows comfortably tappable', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.ppicker-tab \{ min-height: 44px; \}/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.ppicker-item \{ min-height: 48px; \}/)
  })
})
