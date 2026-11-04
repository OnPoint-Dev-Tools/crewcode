import { describe, expect, it } from 'vitest'
import { crewCoderQuestionAnswer, parseCrewCoderQuestion } from './crewcoder-question'

const base = { version: 1, requestId: 'question-1', kind: 'question', title: 'Which approach?' }
describe('CrewCoder structured question cards', () => {
  it('keeps arbitrary option values and descriptions separate from permissions', () => {
    const question = parseCrewCoderQuestion({ ...base, options: [{ label: 'Small change', value: 'minimal', description: 'Keep the current design' }] }, 'turn-1')
    expect(question.request).toMatchObject({ kind: 'select', turnId: 'turn-1', options: [{ id: 'choice-0', label: 'Small change', description: 'Keep the current design' }] })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'submit', optionId: 'choice-0' })).toEqual({ cancelled: false, value: 'minimal' })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'accept' })).toEqual({ cancelled: true })
  })
  it('renders free text and Other without inventing empty answers', () => {
    const question = parseCrewCoderQuestion({ ...base, allowFreeform: true, secret: true, options: [{ label: 'Yes', value: 'yes' }] })
    expect(question.request).toMatchObject({ kind: 'prompt', secret: true })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'submit', value: 'my own answer' })).toEqual({ cancelled: false, value: 'my own answer' })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'submit', value: ' ' })).toEqual({ cancelled: true })
    expect(parseCrewCoderQuestion(base).request.kind).toBe('prompt')
  })
  it('maps sandbox approval buttons to once-only decisions and displays exact access', () => {
    const question = parseCrewCoderQuestion({ ...base, kind: 'permission', detail: 'filesystem.write: /repo/.git',
      options: [{ label: 'Allow once', value: 'turn' }, { label: 'Allow session', value: 'session' }, { label: 'Decline', value: 'decline' }] })
    expect(question.request).toMatchObject({ kind: 'permission', detail: 'filesystem.write: /repo/.git' })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'accept' })).toEqual({ cancelled: false, value: 'turn' })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'decline' })).toEqual({ cancelled: false, value: 'decline' })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'cancel' })).toEqual({ cancelled: true })
    expect(question.request.options?.some(option => option.label === 'Allow session')).toBe(false)
  })
  it('preserves multiple choices and Other through the shared toggle card', () => {
    const question = parseCrewCoderQuestion({ ...base, multiple: true, allowFreeform: true, options: [
      { label: 'First', value: 'first' }, { label: 'Second', value: 'second' },
    ] })
    expect(question.request).toMatchObject({ kind: 'prompt', multiple: true })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'submit', optionIds: ['choice-1', 'choice-0'], value: 'custom' }))
      .toEqual({ cancelled: false, values: ['first', 'second', 'custom'] })
    expect(crewCoderQuestionAnswer(question, { requestId: 'ui', action: 'submit', optionIds: ['unknown'] })).toEqual({ cancelled: true })
  })
})
