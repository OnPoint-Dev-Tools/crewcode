import { mkdtempSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilesystemService } from './filesystem-service'
import * as remoteFs from './remote/remote-fs'

afterEach(() => vi.restoreAllMocks())
describe('image file reads', () => {
  it('allows images above the text ceiling but bounds them at the attachment ceiling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crewcode-image-'))
    const path = join(root, 'large.png')
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024 + 1))
    const service = new FilesystemService()
    expect(await service.readDataUrl(root, 'large.png')).toMatchObject({ ok: true, mimeType: 'image/png', size: 2 * 1024 * 1024 + 1 })
    truncateSync(path, 25 * 1024 * 1024 + 1)
    expect(await service.readDataUrl(root, 'large.png')).toEqual({ error: 'file too large (>25MB)' })
  })
  it('refuses local links that resolve outside the workspace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'crewcode-image-link-'))
    const root = join(parent, 'workspace')
    const outside = join(parent, 'outside')
    mkdirSync(root); mkdirSync(outside)
    writeFileSync(join(outside, 'private.png'), 'private')
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await new FilesystemService().readDataUrl(root, 'linked/private.png')).toEqual({ error: 'path escapes root' })
  })
  it('reads SSH image bytes with the same bounded API and returns connection errors', async () => {
    const remote = vi.spyOn(remoteFs, 'remoteReadBuffer').mockResolvedValueOnce({ ok: true, data: Buffer.from([1, 2, 3]) }).mockResolvedValueOnce({ error: 'SSH disconnected' })
    const service = new FilesystemService()
    expect(await service.readDataUrl('ssh://host/repo', 'image.png')).toMatchObject({ ok: true, dataUrl: 'data:image/png;base64,AQID' })
    expect(remote).toHaveBeenCalledWith('ssh://host/repo', 'image.png', 25 * 1024 * 1024)
    expect(await service.readDataUrl('ssh://host/repo', 'image.png')).toEqual({ error: 'SSH disconnected' })
  })
})
