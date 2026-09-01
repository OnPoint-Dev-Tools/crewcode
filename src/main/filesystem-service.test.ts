import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { FilesystemService } from './filesystem-service'

function fixture(): { root: string; service: FilesystemService } {
  return { root: mkdtempSync(join(tmpdir(), 'crewcode-fs-')), service: new FilesystemService() }
}

describe('FilesystemService', () => {
  it('reads and writes files under a workspace root', async () => {
    const { root, service } = fixture()
    expect(service.writeFile(root, 'src/index.ts', 'export {}')).toEqual({ ok: true })
    expect(await service.readFile(root, 'src/index.ts')).toMatchObject({ ok: true, text: 'export {}', name: 'index.ts' })
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export {}')
  })

  it('rejects path traversal', async () => {
    const { root, service } = fixture()
    expect(await service.readFile(root, '../secret')).toEqual({ error: 'path escapes root' })
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

  it('copies files and folders without escaping the workspace', () => {
    const { root, service } = fixture()
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'dest'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
    writeFileSync(join(root, 'readme.md'), '# hi')
    mkdirSync(join(root, 'src', 'lib'))
    writeFileSync(join(root, 'src', 'lib', 'util.ts'), 'ok')

    expect(service.copyFile(root, 'readme.md')).toMatchObject({ ok: true, rel: 'readme copy.md' })
    expect(readFileSync(join(root, 'readme copy.md'), 'utf8')).toBe('# hi')
    expect(service.copyFile(root, 'src/index.ts', 'dest')).toMatchObject({ ok: true, rel: join('dest', 'index.ts') })
    expect(readFileSync(join(root, 'dest', 'index.ts'), 'utf8')).toBe('export {}')
    expect(service.copyFile(root, 'src/index.ts', 'dest')).toMatchObject({ ok: true, rel: join('dest', 'index copy.ts') })
    expect(service.copyFile(root, 'src/lib', 'dest')).toMatchObject({ ok: true, rel: join('dest', 'lib') })
    expect(readFileSync(join(root, 'dest', 'lib', 'util.ts'), 'utf8')).toBe('ok')
    expect(service.copyFile(root, 'src/lib', 'src/lib')).toEqual({ error: 'cannot copy a folder into itself' })
    expect(service.move(root, 'dest/index.ts', '')).toMatchObject({ ok: true, rel: 'index.ts' })
    expect(existsSync(join(root, 'dest', 'index.ts'))).toBe(false)
    expect(readFileSync(join(root, 'index.ts'), 'utf8')).toBe('export {}')
    expect(service.move(root, 'src/lib', 'src/lib')).toEqual({ error: 'cannot move a folder into itself' })
    expect(service.move(root, '../secret', 'dest')).toEqual({ error: 'source escapes root' })
    expect(service.copyFile(root, '../secret')).toEqual({ error: 'path escapes root' })
    expect(service.copyFile(root, 'readme.md', '../')).toEqual({ error: 'destination escapes root' })
  })

  it('lists directories while hiding ignored dependency trees', async () => {
    const { root, service } = fixture()
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'visible.ts'), 'ok')
    writeFileSync(join(root, 'node_modules', 'hidden.js'), 'no')
    const result = await service.readDir(root)
    expect(result.nodes?.map(node => node.name) ?? []).toEqual(['visible.ts'])
  })
})
