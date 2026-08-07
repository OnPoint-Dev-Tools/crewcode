import { describe, expect, it } from 'vitest'

import { answerOpencodeQuestion, buildOpencodePromptBody, prepareOpencodeQuestionRequest, usageFromOpencodeMessageInfo } from './opencode-bridge'

describe('opencode question requests', () => {
  it('maps OpenCode question events to AgentRequestCard select requests', () => {
    const prepared = prepareOpencodeQuestionRequest({
      question: 'Which approach should we use?',
      header: 'Pick an approach',
      custom: false,
      options: [
        { label: 'Simple', description: 'Smallest change' },
        { label: 'Robust', description: 'More coverage' },
      ],
    })

    expect(prepared?.request).toMatchObject({
      kind: 'select',
      title: 'Which approach should we use?',
      message: 'OpenCode asks: Pick an approach',
      source: 'opencode',
      options: [
        { id: 'Simple', label: 'Simple', description: 'Smallest change' },
        { id: 'Robust', label: 'Robust', description: 'More coverage' },
      ],
    })
    expect(answerOpencodeQuestion(prepared!, { requestId: 'r', action: 'submit', optionId: 'Robust' })).toEqual(['Robust'])
  })

  it('keeps custom OpenCode questions text-submittable', () => {
    const prepared = prepareOpencodeQuestionRequest({
      question: 'What branch name?',
      header: 'Branch',
      options: [{ label: 'feature/foo', description: 'Use suggested branch' }],
    })

    expect(prepared?.request.kind).toBe('prompt')
    expect(prepared?.request.options).toHaveLength(1)
    expect(answerOpencodeQuestion(prepared!, { requestId: 'r', action: 'submit', value: 'feature/bar' })).toEqual(['feature/bar'])
  })
})

describe('opencode prompt body', () => {
  it('passes reasoning effort as the model variant', () => {
    expect(buildOpencodePromptBody('Build this', 'build', 'openai/gpt-5.4', 'high')).toMatchObject({ variant: 'high' })
    expect(buildOpencodePromptBody('Build this', 'build', 'openai/gpt-5.4', 'off')).not.toHaveProperty('variant')
  })

  it('encodes mode instructions as text, not rejected system parts', () => {
    const body = buildOpencodePromptBody('Explain this repo', 'ask', 'opencode/kimi-k2.6')

    expect(body.parts).toHaveLength(1)
    expect(body.parts[0]).toMatchObject({ type: 'text' })
    expect(body.parts[0].text).toContain('You are in Ask mode')
    expect(body.parts[0].text).toContain('Explain this repo')
    expect(body.parts.map(part => part.type)).not.toContain('system')
    expect(body.model).toEqual({ providerID: 'opencode', modelID: 'kimi-k2.6' })
  })

  it('leaves build mode prompts unwrapped', () => {
    const body = buildOpencodePromptBody('Build this', 'build')

    expect(body).toEqual({ parts: [{ type: 'text', text: 'Build this' }] })
  })

  it('does not send an empty provider for unqualified model names', () => {
    const body = buildOpencodePromptBody('Build this', 'build', 'deepseek-v4-pro')

    expect(body).toEqual({ parts: [{ type: 'text', text: 'Build this' }] })
  })

  it('does not count cache-hit billing tokens as live context usage', () => {
    const usage = usageFromOpencodeMessageInfo({
      modelID: 'opencode/claude-opus-4-8',
      tokens: {
        input: 18_000,
        output: 500,
        reasoning: 200,
        cache: { read: 4_000_000, write: 20_000 },
      },
    }, undefined)

    expect(usage).toMatchObject({
      inputTokens: 18_000,
      outputTokens: 700,
      totalTokens: 18_700,
      contextTokens: 18_500,
      model: 'opencode/claude-opus-4-8',
    })
  })
})
