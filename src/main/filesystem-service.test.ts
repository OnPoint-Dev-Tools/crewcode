import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { FilesystemService } from './filesystem-service'

function fixture(): { root: string; service: FilesystemService } {
  return { root: mkdtempSync(join(tmpdir(), 'crewcode-fs-')), service: new FilesystemService() }
}

describe('FilesystemService', () => {
  it('reads and writes files under a workspace root', () => {
    const { root, service } = fixture()
    expect(service.writeFile(root, 'src/index.ts', 'export {}')).toEqual({ ok: true })
    expect(service.readFile(root, 'src/index.ts')).toMatchObject({ ok: true, text: 'export {}', name: 'index.ts' })
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export {}')
  })

  it('rejects path traversal', () => {
    const { root, service } = fixture()
    expect(service.readFile(root, '../secret')).toEqual({ error: 'path escapes root' })
    expect(service.writeFile(root, '../secret', 'no')).toEqual({ error: 'path escapes root' })
  })

  it('supports browser editor mutations without escaping the workspace', () => {
    const { root, service } = fixture()
    expect(service.mkdir(root, 'src/nested')).toEqual({ ok: true })
    expect(service.writeFile(root, 'src/nested/old.ts', 'value')).toEqual({ ok: true })
    expect(service.rename(root, 'src/nested/old.ts', 'new.ts')).toEqual({ ok: true, rel: join('src', 'nested', 'new.ts') })
    expect(service.rename(root, 'src/nested/new.ts', '../escape.ts')).toEqual({ error: 'invalid name' })
    expect(service.delete(root, '')).toEqual({ error: 'path escapes root' })
    expect(service.delete(root, 'src/nested')).toEqual({ ok: true })
    expect(existsSync(join(root, 'src', 'nested'))).toBe(false)
  })

  it('returns sandboxed data URLs for attachment previews', () => {
    const { root, service } = fixture()
    writeFileSync(join(root, 'pixel.png'), Buffer.from([1, 2, 3]))
    expect(service.readDataUrl(root, 'pixel.png')).toMatchObject({ ok: true, dataUrl: 'data:image/png;base64,AQID', mimeType: 'image/png' })
    expect(service.readDataUrl(root, '../pixel.png')).toEqual({ error: 'path escapes root' })
  })

  it('lists directories while hiding ignored dependency trees', () => {
    const { root, service } = fixture()
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'visible.ts'), 'ok')
    writeFileSync(join(root, 'node_modules', 'hidden.js'), 'no')
    const result = service.readDir(root)
    expect('nodes' in result ? result.nodes?.map(node => node.name) : []).toEqual(['visible.ts'])
  })
})
