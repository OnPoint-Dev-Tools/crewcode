import { randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { BrainDesktopConnection } from '../shared/brain-desktop-types'
import { CREWCODE_BRAIN_DESKTOP_VERSION } from '../shared/brain-desktop-types'

export function brainDesktopConnectionPath(dataDir: string): string {
  return join(dataDir, 'desktop-connection.json')
}

export function brainDesktopPreferencesPath(dataDir: string): string {
  return join(dataDir, 'desktop-preferences.json')
}

export function readBrainDesktopConnection(path: string): BrainDesktopConnection | null {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BrainDesktopConnection>
    if (value.version !== CREWCODE_BRAIN_DESKTOP_VERSION
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url)
      || typeof value.sessionToken !== 'string' || !value.sessionToken.includes('.')
      || typeof value.controlToken !== 'string' || value.controlToken.length < 32
      || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return null
    return value as BrainDesktopConnection
  } catch {
    return null
  }
}

export function writeBrainDesktopConnection(path: string, connection: BrainDesktopConnection): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { chmodSync(dirname(path), 0o700) } catch { /* Windows has no POSIX modes */ }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify(connection, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
  try { chmodSync(path, 0o600) } catch { /* Windows has no POSIX modes */ }
}

/** Never let an older stopping Brain erase a newer process's rendezvous. */
export function removeBrainDesktopConnection(path: string, controlToken: string): void {
  const current = readBrainDesktopConnection(path)
  if (current?.controlToken !== controlToken) return
  try { rmSync(path, { force: true }) } catch { /* stale status is rejected by the live probe */ }
}

export function readBrainDesktopEnabled(path: string): boolean {
  if (!existsSync(path)) return false
  try { return JSON.parse(readFileSync(path, 'utf8'))?.enabled === true } catch { return false }
}

export function writeBrainDesktopEnabled(path: string, enabled: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  try { chmodSync(path, 0o600) } catch { /* Windows has no POSIX modes */ }
}
