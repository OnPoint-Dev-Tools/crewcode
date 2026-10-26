import { describe, expect, it, vi } from 'vitest'
import { answerCodexMcpElicitation } from './codex-mcp-elicitation'

const consent = { serverName: 'browser', mode: 'form', message: 'Access http://127.0.0.1:5198', requestedSchema: { type: 'object', properties: {} } }
describe('Codex MCP elicitation', () => {
  it('returns actual consent in Full Access instead of an empty RPC result', async () => {
    expect(await answerCodexMcpElicitation(consent, true)).toEqual({ action: 'accept', content: {} })
  })
  it('routes interactive consent and preserves denial', async () => {
    const request = vi.fn().mockResolvedValue({ action: 'decline' })
    expect(await answerCodexMcpElicitation(consent, false, request)).toEqual({ action: 'decline' })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'permission', message: consent.message }), undefined)
    expect(await answerCodexMcpElicitation(consent, false)).toEqual({ action: 'cancel' })
  })
  it('does not invent form data or claim URL authentication happened', async () => {
    const form = { ...consent, requestedSchema: { properties: { name: { type: 'string' } } } }
    expect(await answerCodexMcpElicitation(form, true)).toEqual({ action: 'cancel' })
    expect(await answerCodexMcpElicitation({ ...consent, mode: 'url', url: 'https://example.com/auth' }, true)).toEqual({ action: 'cancel' })
    const request = vi.fn().mockResolvedValue({ action: 'submit', value: '{"name":"Cj"}' })
    expect(await answerCodexMcpElicitation(form, true, request)).toEqual({ action: 'accept', content: { name: 'Cj' } })
    request.mockResolvedValue({ action: 'submit', value: '' })
    await expect(answerCodexMcpElicitation(form, false, request)).rejects.toThrow('JSON object')
  })
  it('withdraws consent when Stop wins the response race', async () => {
    const controller = new AbortController()
    const request = vi.fn().mockImplementation(async () => { controller.abort(); return { action: 'accept' } })
    expect(await answerCodexMcpElicitation(consent, false, request, controller.signal)).toEqual({ action: 'cancel' })
  })
})
