import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir as osTmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CREWCODE_REMOTE_PROTOCOL_VERSION } from '../shared/remote-access-types'
import { startRemoteAccessServer, type RunningRemoteAccessServer } from './remote-access-server'
import WebSocket from 'ws'

// The server realpaths every incoming path before checking it against the
// allowed roots. On macOS os.tmpdir() is /var/folders/... which is a symlink to
// /private/var/folders/..., so an unresolved root matches nothing and every
// workspace call comes back 403 / "path escapes root". Resolve once, up front.
const tmpdir = (): string => realpathSync.native(osTmpdir())

let running: RunningRemoteAccessServer | null = null
afterEach(async () => { await running?.close(); running = null })

async function start(): Promise<RunningRemoteAccessServer> {
  running = await startRemoteAccessServer({ dataDir: mkdtempSync(join(tmpdir(), 'crewcode-remote-')), allowedWorkspaceRoots: [tmpdir()] })
  return running
}

describe('remote access server', () => {
  it('stores allowlisted catalogue continuity on the Brain', async () => {
    const server = await start()
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    const rpc = (id: string, method: string, params: Record<string, unknown>) => fetch(`${server.url}/api/v1/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, method, params }),
    })

    expect(await (await rpc('empty', 'continuity.get', {})).json()).toMatchObject({ ok: true, result: { version: 1, revision: 0, values: {} } })
    const updated = await (await rpc('patch', 'continuity.update', { values: { 'crewcode:activeWorkspaceId': 'workspace-one' } })).json()
    expect(updated).toMatchObject({ ok: true, result: { revision: 1, values: { 'crewcode:activeWorkspaceId': 'workspace-one' } } })
    expect(await (await rpc('forbidden', 'continuity.update', { values: { 'crewcode:secret': 'no' } })).json()).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('continuity key is not allowed') },
    })
  })

  it('keeps desktop Brain stop control separate from browser sessions', async () => {
    const onStop = vi.fn()
    running = await startRemoteAccessServer({
      dataDir: mkdtempSync(join(tmpdir(), 'crewcode-desktop-control-')),
      allowedWorkspaceRoots: [tmpdir()],
      desktopControl: { token: 'desktop-control-secret', onStop },
    })
    expect((await fetch(`${running.url}/api/v1/desktop/status`)).status).toBe(401)
    const status = await fetch(`${running.url}/api/v1/desktop/status`, { headers: { authorization: 'Bearer desktop-control-secret' } })
    expect(await status.json()).toMatchObject({ ok: true, pid: process.pid })
    const stopped = await fetch(`${running.url}/api/v1/desktop/stop`, { method: 'POST', headers: { authorization: 'Bearer desktop-control-secret' } })
    expect(stopped.status).toBe(202)
    await new Promise(resolve => setImmediate(resolve))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('publishes an unauthenticated protocol handshake', async () => {
    const server = await start()
    const response = await fetch(`${server.url}/api/v1/capabilities`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ protocolVersion: 1, runtime: 'server', features: { workspaces: true, filesystem: true, git: true } })
  })

  it('requires a session and exchanges a pairing credential only once', async () => {
    const server = await start()
    const envelope = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: 'one', method: 'workspaces.list', params: {} }
    expect((await fetch(`${server.url}/api/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })).status).toBe(401)
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    expect(sessionToken).toBeTruthy()
    expect((await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })).status).toBe(401)
    const rpc = await fetch(`${server.url}/api/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` }, body: JSON.stringify(envelope) })
    expect(await rpc.json()).toMatchObject({ id: 'one', ok: true, result: [] })
  })

  it('restricts project onboarding to configured roots and creates projects there', async () => {
    const server = await start()
    const parent = mkdtempSync(join(tmpdir(), 'crewcode-project-parent-'))
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    const rpc = async (id: string, method: string, params: Record<string, unknown>) => fetch(`${server.url}/api/v1/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ protocolVersion: 1, id, method, params }),
    })

    const inspect = await rpc('inspect', 'workspaces.inspectPath', { path: parent })
    expect(await inspect.json()).toMatchObject({ ok: true, result: { path: parent } })
    const created = await rpc('init-project', 'workspaces.initProject', { parentDir: parent, folderName: 'browser-project', asGit: true })
    expect(await created.json()).toMatchObject({ ok: true, result: { ok: true, path: join(parent, 'browser-project') } })
    const added = await rpc('add-project', 'workspaces.add', { path: join(parent, 'browser-project') })
    expect(await added.json()).toMatchObject({ ok: true, result: { workspace: { name: 'browser-project' } } })

    const forbidden = await rpc('outside-root', 'workspaces.add', { path: '/etc' })
    expect(forbidden.status).toBe(403)
  })

  it('serves authenticated filesystem RPC with traversal protection', async () => {
    const server = await start()
    const root = mkdtempSync(join(tmpdir(), 'crewcode-rpc-fs-'))
    mkdirSync(join(root, 'src'))
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    const add = await fetch(`${server.url}/api/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ protocolVersion: 1, id: 'add', method: 'workspaces.add', params: { path: root } }) })
    expect((await add.json() as { ok: boolean }).ok).toBe(true)
    const response = await fetch(`${server.url}/api/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ protocolVersion: 1, id: 'fs', method: 'fs.writeFile', params: { root, sub: '../escape', text: 'no' } }) })
    expect(await response.json()).toMatchObject({ ok: true, result: { error: 'path escapes root' } })
  })

  it('streams authenticated PTY output over WebSocket', async () => {
    const server = await start()
    const root = mkdtempSync(join(tmpdir(), 'crewcode-rpc-pty-'))
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    const rpc = (id: string, method: string, params: Record<string, unknown>) => fetch(`${server.url}/api/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ protocolVersion: 1, id, method, params }) })
    await rpc('add-pty', 'workspaces.add', { path: root })
    const socket = new WebSocket(server.url.replace(/^http/, 'ws') + '/api/v1/events', ['crewcode.v1', sessionToken])
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const output = new Promise<string>((resolve, reject) => {
      // ConPTY can split even a short write across several data frames, so match
      // on the accumulated stream instead of any single message. The buffer goes
      // into the timeout message to make a CI-only failure diagnosable.
      let seen = ''
      const timeout = setTimeout(() => reject(new Error(`PTY output timeout (saw ${JSON.stringify(seen)})`)), 15_000)
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { channel: string; event: { type: string; data?: string } }
        if (message.channel === 'pty' && message.event.type === 'data') {
          seen += message.event.data ?? ''
          if (seen.includes('remote-pty-ok')) { clearTimeout(timeout); resolve(seen) }
        }
      })
    })
    // Exercise the same default OS shell CrewCode opens for a real terminal.
    // Treating Node as a shell is not portable: macOS node-pty can reject it via
    // posix_spawnp, while ConPTY may launch it without honoring the -e fixture.
    const create = await rpc('pty', 'pty.create', { paneId: 'web-test', cwd: root })
    expect(create.status).toBe(200)
    const createBody = await create.json() as { ok: boolean; result?: { ok?: boolean; error?: string } }
    expect(createBody).toMatchObject({ ok: true, result: { ok: true } })
    const enter = process.platform === 'win32' ? '\r' : '\n'
    const write = await rpc('pty-write', 'pty.write', { paneId: 'web-test', data: `echo remote-pty-ok${enter}` })
    expect(write.status).toBe(200)
    await expect(output).resolves.toContain('remote-pty-ok')
    socket.close()
  })

  it('uploads attachments only into an authenticated registered workspace', async () => {
    const server = await start()
    const root = mkdtempSync(join(tmpdir(), 'crewcode-rpc-attachment-'))
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    const rpc = (id: string, method: string, params: Record<string, unknown>) => fetch(`${server.url}/api/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ protocolVersion: 1, id, method, params }) })
    await rpc('add-attachment', 'workspaces.add', { path: root })

    const upload = await fetch(`${server.url}/api/v1/attachments?root=${encodeURIComponent(root)}&name=${encodeURIComponent('../note.txt')}`, {
      method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }, body: 'hello remote',
    })
    expect(upload.status).toBe(200)
    const { rel } = await upload.json() as { rel: string }
    expect(rel).toMatch(/^\.crewcode\/attachments\//)
    expect(readFileSync(join(root, rel), 'utf8')).toBe('hello remote')

    const forbidden = await fetch(`${server.url}/api/v1/attachments?root=${encodeURIComponent(tmpdir())}&name=x`, {
      method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }, body: 'no',
    })
    expect(forbidden.status).toBe(403)

    const tunneled = Buffer.from('encrypted relay attachment')
    const beginBody = await (await rpc('begin-tunnel', 'attachments.begin', { root, name: '../../tunneled.txt', size: tunneled.byteLength })).json() as { result: { uploadId: string } }
    const uploadId = beginBody.result.uploadId
    expect(await (await rpc('chunk-tunnel', 'attachments.chunk', { uploadId, sequence: 0, data: tunneled.toString('base64') })).json())
      .toMatchObject({ ok: true, result: { received: tunneled.byteLength } })
    const digest = createHash('sha256').update(tunneled).digest('hex')
    const finished = await (await rpc('finish-tunnel', 'attachments.finish', { uploadId, sha256: digest })).json() as { result: { rel: string } }
    expect(finished.result.rel).toMatch(/^\.crewcode\/attachments\//)
    expect(finished.result.rel).toMatch(/tunneled\.txt$/)
    expect(readFileSync(join(root, finished.result.rel), 'utf8')).toBe('encrypted relay attachment')

    if (process.platform !== 'win32') {
      const symlinkRoot = mkdtempSync(join(tmpdir(), 'crewcode-rpc-attachment-link-'))
      const outside = mkdtempSync(join(tmpdir(), 'crewcode-rpc-attachment-outside-'))
      symlinkSync(outside, join(symlinkRoot, '.crewcode'))
      await rpc('add-symlink-root', 'workspaces.add', { path: symlinkRoot })
      const escaped = await rpc('begin-symlink-escape', 'attachments.begin', { root: symlinkRoot, name: 'escape.txt', size: 1 })
      expect(escaped.status).toBe(403)
    }

    const badBegin = await (await rpc('begin-bad-digest', 'attachments.begin', { root, name: 'bad.txt', size: 1 })).json() as { result: { uploadId: string } }
    await rpc('chunk-bad-digest', 'attachments.chunk', { uploadId: badBegin.result.uploadId, sequence: 0, data: Buffer.from('x').toString('base64') })
    expect((await rpc('finish-bad-digest', 'attachments.finish', { uploadId: badBegin.result.uploadId, sha256: '0'.repeat(64) })).status).toBe(500)
  })

  it('forbids agent startup outside registered workspaces', async () => {
    const server = await start()
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    const response = await fetch(`${server.url}/api/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ protocolVersion: 1, id: 'agent-forbidden', method: 'bridge.start', params: { bridgeId: 'bad', provider: 'codex', cwd: '/tmp' } }) })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('forbids filesystem access outside registered workspaces', async () => {
    const server = await start()
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    const response = await fetch(`${server.url}/api/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ protocolVersion: 1, id: 'forbidden', method: 'fs.readFile', params: { root: '/', sub: 'etc/passwd' } }) })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('lists sanitized sessions and revokes them through authenticated RPC', async () => {
    const server = await start()
    const pair = await fetch(`${server.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: server.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    const sessionId = sessionToken.slice(0, sessionToken.indexOf('.'))
    const rpc = (id: string, method: string, params: Record<string, unknown>) => fetch(`${server.url}/api/v1/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ protocolVersion: 1, id, method, params }),
    })

    const listed = await rpc('sessions', 'auth.sessions', {})
    const listedBody = await listed.json()
    expect(listedBody).toMatchObject({ ok: true, result: [{ id: sessionId, status: 'active' }] })
    expect(JSON.stringify(listedBody)).not.toContain(sessionToken)
    expect(await (await rpc('revoke', 'auth.revoke', { sessionId })).json()).toMatchObject({ ok: true, result: { revoked: true } })
    expect((await rpc('after-revoke', 'workspaces.list', {})).status).toBe(401)
  })

  it('restores device sessions when the server restarts with the same data directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crewcode-remote-persist-'))
    running = await startRemoteAccessServer({ dataDir, allowedWorkspaceRoots: [tmpdir()] })
    const pair = await fetch(`${running.url}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: running.pairingToken }) })
    const { sessionToken } = await pair.json() as { sessionToken: string }
    await running.close()
    running = await startRemoteAccessServer({ dataDir, allowedWorkspaceRoots: [tmpdir()] })

    const response = await fetch(`${running.url}/api/v1/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ protocolVersion: 1, id: 'restored', method: 'workspaces.list', params: {} }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, id: 'restored' })
  })

  it('rejects cross-origin browser API requests while allowing exact same-origin requests', async () => {
    const server = await start()
    const rejected = await fetch(`${server.url}/api/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ token: server.pairingToken }),
    })
    expect(rejected.status).toBe(403)

    const accepted = await fetch(`${server.url}/api/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token: server.pairingToken }),
    })
    expect(accepted.status).toBe(200)
  })

  it('rate limits repeated pairing attempts by peer address', async () => {
    const server = await start()
    const statuses: number[] = []
    for (let index = 0; index < 11; index += 1) {
      const response = await fetch(`${server.url}/api/v1/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'invalid.token' }),
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401))
    expect(statuses[10]).toBe(429)
  })
})
