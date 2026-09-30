import { describe, expect, it } from 'vitest'

import {
  CODEX_REQUEST_USER_INPUT_METHODS,
  codexQuestionAnswer,
  codexQuestionRequest,
  parseCodexUserInputQuestions,
} from './codex-user-input'

// Shape from codex-cli 0.157.1 ToolRequestUserInputParams.
const params = {
  threadId: 't1',
  turnId: 'turn-1',
  itemId: 'item-1',
  isBlocking: true,
  questions: [
    { id: 'confirm', header: 'Deploy', question: 'Deploy to staging?', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] },
    { id: 'branch', header: 'Branch', question: 'Which branch name?', isOther: true, options: [{ label: 'main', description: 'default' }] },
    { id: 'token', header: 'Token', question: 'Paste the API token', isSecret: true, options: null },
  ],
}

describe('codex request_user_input', () => {
  it('listens on the real v2 method and keeps the legacy alias', () => {
    expect(CODEX_REQUEST_USER_INPUT_METHODS.has('item/tool/requestUserInput')).toBe(true)
    expect(CODEX_REQUEST_USER_INPUT_METHODS.has('tool/requestUserInput')).toBe(true)
  })

  it('parses every question with stable ids', () => {
    const questions = parseCodexUserInputQuestions(params)
    expect(questions.map(q => q.id)).toEqual(['confirm', 'branch', 'token'])
    expect(questions[0].options).toEqual([{ label: 'Yes' }, { label: 'No' }])
  })

  it('maps option-only questions to button cards and "other" questions to input cards', () => {
    const [confirm, branch, token] = parseCodexUserInputQuestions(params)
    expect(codexQuestionRequest(confirm, 0, 3, 'turn-1')).toMatchObject({
      kind: 'select',
      title: 'Deploy to staging?',
      message: 'Codex asks: Deploy Question 1 of 3.',
      options: [{ id: 'opt-0', label: 'Yes' }, { id: 'opt-1', label: 'No' }],
      turnId: 'turn-1',
      source: 'codex',
    })
    expect(codexQuestionRequest(branch, 1, 3)).toMatchObject({ kind: 'prompt', placeholder: 'reply to Codex…' })
    expect(codexQuestionRequest(token, 2, 3)).toMatchObject({ kind: 'prompt', secret: true, options: undefined })
  })

  it('answers with the option label or typed text', () => {
    const [confirm, branch] = parseCodexUserInputQuestions(params)
    expect(codexQuestionAnswer(confirm, { requestId: 'r', action: 'submit', optionId: 'opt-1' })).toEqual(['No'])
    expect(codexQuestionAnswer(branch, { requestId: 'r', action: 'submit', value: ' feature/x ' })).toEqual(['feature/x'])
  })

  it('never turns a cancel, empty reply, or disallowed free text into an answer', () => {
    const [confirm, branch] = parseCodexUserInputQuestions(params)
    expect(codexQuestionAnswer(confirm, { requestId: 'r', action: 'cancel' })).toBeNull()
    expect(codexQuestionAnswer(branch, { requestId: 'r', action: 'submit', value: '   ' })).toBeNull()
    expect(codexQuestionAnswer(confirm, { requestId: 'r', action: 'submit', value: 'maybe' })).toBeNull()
  })

  it('accepts the legacy single-prompt shape as a free-text question', () => {
    const [legacy] = parseCodexUserInputQuestions({ title: 'Input', prompt: 'Name the file' })
    expect(legacy).toMatchObject({ id: 'input', question: 'Name the file', isOther: true })
  })
})
