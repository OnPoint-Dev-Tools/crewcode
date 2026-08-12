import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir as osTmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
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
    // /bin/sh does not exist on Windows. node is the one interpreter guaranteed
    // to be present wherever this suite runs.
    // Keep the process alive briefly after the write completes. A zero-lived
    // process can exit before macOS's native PTY dispatches its final data event.
    const script = 'process.stdout.write("remote-pty-ok", () => setTimeout(() => process.exit(0), 50))'
    const create = await rpc('pty', 'pty.create', { paneId: 'web-test', cwd: root, shell: process.execPath, argv: ['-e', script] })
    expect(create.status).toBe(200)
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
})
