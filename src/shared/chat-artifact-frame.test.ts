import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { CHAT_ARTIFACT_FRAME_HTML, CHAT_ARTIFACT_HEADERS, CHAT_ARTIFACT_MAX_CHARS, chatArtifactFrameUrl } from './chat-artifact-frame'

describe('isolated artifact document', () => {
  it('keeps scripts and forms behind an opaque, header-enforced sandbox', () => {
    const policy = CHAT_ARTIFACT_HEADERS['content-security-policy']
    expect(policy).toContain('sandbox allow-scripts;')
    expect(policy).not.toContain('allow-same-origin')
    expect(policy).not.toContain('allow-top-navigation')
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(CHAT_ARTIFACT_HEADERS['cache-control']).toBe('no-store')
    expect(CHAT_ARTIFACT_HEADERS['referrer-policy']).toBe('no-referrer')
  })
  it('transfers content in the fragment rather than a server request', () => {
    const html = '<h1>Private #artifact</h1><script>1+1</script>'
    const url = new URL(chatArtifactFrameUrl(html, 'https://crew.test/crewcode-artifact-frame'))
    expect(url.search).toBe('')
    const document = { open: vi.fn(), write: vi.fn(), close: vi.fn(), body: { textContent: '' } }
    const script = CHAT_ARTIFACT_FRAME_HTML.match(/<script>([\s\S]*)<\/script>/)![1]
    runInNewContext(script, { location: { hash: url.hash }, document })
    expect(document.write).toHaveBeenCalledWith(html)
    expect(document.close).toHaveBeenCalledOnce()
  })
  it('bounds content before creating a preview URL', () => {
    expect(() => chatArtifactFrameUrl('x'.repeat(CHAT_ARTIFACT_MAX_CHARS + 1), 'https://crew.test/crewcode-artifact-frame')).toThrow('preview limit')
  })
})
