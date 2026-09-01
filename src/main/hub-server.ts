import { createPublicKey } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { extname, join, normalize, sep } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { remotePeerKey, RemoteAccessRateLimiter } from './remote-access-security'
import { HubConnectionTicketIssuer } from './hub-connection-tickets'
import { HubRelayTrafficLimiter } from './hub-relay-limits'
import {
  HUB_RELAY_ABSOLUTE_TIMEOUT_MS,
  HUB_RELAY_IDLE_TIMEOUT_MS,
  HUB_RELAY_MAX_FRAME_BYTES,
  type BrainAccessScope,
  type HubRelayControlFrame,
} from '../shared/hub-relay-types'
import { HubAuth } from './hub-auth'
import { HubDeviceEnrollmentIssuer, HubEnrollmentIssuer, HUB_MACHINE_ONLINE_WINDOW_MS } from './hub-machine-enrollment'
import { HubStore, type HubSession } from './hub-store'
import QRCode from 'qrcode'

const MAX_BODY_BYTES = 1024 * 1024
const HUB_AUTH_ATTEMPTS_PER_MINUTE = 30
const HUB_MACHINE_ATTEMPTS_PER_MINUTE = 60
const HUB_MAX_CONNECTIONS_PER_MACHINE = 4
const HUB_MAX_CONNECTIONS_PER_USER = 8
const HUB_RELAY_EXPIRY_SWEEP_MS = 30_000
const HUB_LATE_BRAIN_FRAME_GRACE_MS = 30_000
const HUB_MAX_RECENTLY_RELEASED_CONNECTIONS = 1_000
const SESSION_COOKIE_HTTP = 'crewcode_hub_session'
const SESSION_COOKIE_HTTPS = '__Host-crewcode_hub_session'
const HUB_BROWSER_RELAY_PROTOCOL = 'crewcode.browser.v1'
const HUB_BRAIN_RELAY_PROTOCOL = 'crewcode.brain.v1'
const VALID_BRAIN_SCOPES = new Set<BrainAccessScope>(['workspace:read', 'workspace:write', 'terminal', 'agent'])

export interface HubServerOptions {
  host?: string
  port?: number
  dataDir: string
  publicOrigin?: string
  webRoot?: string
  now?: () => number
}

export interface RunningHubServer {
  host: string
  port: number
  url: string
  publicOrigin: string
  bootstrapToken?: string
  bootstrapUrl?: string
  ownerConfigured: () => boolean
  enrollLocalMachine: (input: {
    publicKey: string
    name: string
    platform: string | null
    version: string | null
  }) => { machineId: string; token: string }
  close: () => Promise<void>
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body exceeds 1MB limit')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required')
  return parsed as Record<string, unknown>
}

function cookies(request: IncomingMessage): Map<string, string> {
  const values = new Map<string, string>()
  for (const item of String(request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 1) continue
    values.set(item.slice(0, separator).trim(), decodeURIComponent(item.slice(separator + 1).trim()))
  }
  return values
}

function boundedString(value: unknown, field: string, maximum: number, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === '')) return null
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${field} must contain 1 to ${maximum} characters`)
  return normalized
}

export function hubRelayExpiryReason(
  connection: { openedAt: number; lastActivityAt: number },
  at: number,
): 'idle timeout' | 'absolute timeout' | null {
  if (at - connection.openedAt >= HUB_RELAY_ABSOLUTE_TIMEOUT_MS) return 'absolute timeout'
  if (at - connection.lastActivityAt >= HUB_RELAY_IDLE_TIMEOUT_MS) return 'idle timeout'
  return null
}

function requestedBrainScopes(value: unknown): BrainAccessScope[] {
  if (!Array.isArray(value) || value.length > VALID_BRAIN_SCOPES.size) throw new Error('requestedScopes must be a bounded array')
  const scopes = value.map(item => String(item) as BrainAccessScope)
  if (scopes.some(scope => !VALID_BRAIN_SCOPES.has(scope)) || new Set(scopes).size !== scopes.length) throw new Error('requestedScopes contains an invalid or duplicate scope')
  return scopes
}

function machinePublicKey(value: unknown): string {
  const encoded = boundedString(value, 'publicKey', 256) as string
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('publicKey must be base64url encoded')
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type')
    return key.export({ format: 'der', type: 'spki' }).toString('base64url')
  } catch {
    throw new Error('publicKey must contain a valid Ed25519 public key')
  }
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return ''
  return authorization.slice(7)
}

function hubBrowserOriginAllowed(request: IncomingMessage, publicOrigin: string): boolean {
  const supplied = request.headers.origin
  if (supplied === undefined) return true
  if (Array.isArray(supplied) || supplied === 'null') return false
  try {
    const url = new URL(supplied)
    return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && url.origin === publicOrigin
  } catch {
    return false
  }
}

function cookieName(publicOrigin: string): string {
  return new URL(publicOrigin).protocol === 'https:' ? SESSION_COOKIE_HTTPS : SESSION_COOKIE_HTTP
}

function setSessionCookie(response: ServerResponse, publicOrigin: string, token: string): void {
  const secure = new URL(publicOrigin).protocol === 'https:' ? '; Secure' : ''
  response.setHeader('set-cookie', `${cookieName(publicOrigin)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}`)
}

function clearSessionCookie(response: ServerResponse, publicOrigin: string): void {
  const secure = new URL(publicOrigin).protocol === 'https:' ? '; Secure' : ''
  response.setHeader('set-cookie', `${cookieName(publicOrigin)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`)
}

function hubHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CrewCode Hub</title><link rel="stylesheet" href="/hub.css"></head>
<body><main><section class="card"><p class="eyebrow">CREWCODE</p><h1>Self-hosted Hub</h1><p id="status">Checking Hub…</p>
<div id="setup" hidden><label>Owner name<input id="owner" maxlength="64" autocomplete="username" value="Owner"></label><button id="setup-button">Create owner passkey</button></div>
<div id="signin" hidden><button id="signin-button">Sign in with passkey</button></div>
<div id="dashboard" hidden><div class="row"><strong id="username"></strong><button id="logout-button" class="quiet">Sign out</button></div><div id="mobile" hidden><h2>Connect a phone</h2><p class="muted">Scan to open this HTTPS Hub. The QR contains only this Hub URL.</p><img id="mobile-qr" width="220" height="220" alt="CrewCode mobile Hub QR code"><p><code id="mobile-url"></code></p></div><div id="pending-wrap" hidden><h2>Pending machine approvals</h2><p class="muted">Approve only when the code and fingerprint match the PC terminal.</p><div id="pending-machines" class="machines"></div></div><h2>Machines</h2><div id="machines" class="machines"></div><button id="enrollment-button">Legacy enrollment token</button><pre id="enrollment" hidden></pre></div>
<p id="error" class="error"></p></section></main><script src="/hub.js"></script></body></html>`
}

const HUB_CSS = `:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0f120f;color:#d7e0dc}*{box-sizing:border-box}body{margin:0}main{min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(640px,100%);border:1px solid #1c2f2f;padding:28px;background:#0f120f}.eyebrow{font:600 11px/1.4 monospace;letter-spacing:.18em;color:#79958a}h1{margin:.25rem 0 1.25rem;font-size:26px}h2{font-size:15px;margin-top:24px}label{display:grid;gap:8px;margin:20px 0;font-size:13px}input,button{border:1px solid #285a48;background:#131a17;color:inherit;padding:10px 12px;font:inherit}button{cursor:pointer;background:#285a48}.quiet{background:transparent}.row,.machine{display:flex;align-items:center;justify-content:space-between;gap:16px}.machines{border-top:1px solid #1c2f2f;margin-bottom:14px;color:#8da49a;font:13px/1.5 monospace}.machine{padding:10px 0;border-bottom:1px solid #1c2f2f}.machine button{padding:5px 8px}.muted{color:#8da49a;font-size:13px}#mobile{text-align:center}#mobile-qr{background:#fff;padding:8px;max-width:100%;height:auto}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #1c2f2f;padding:12px;color:#8da49a}.error{color:#d89595;min-height:1.4em}`

const HUB_JS = `(()=>{'use strict';
const $=id=>document.getElementById(id),status=$('status'),error=$('error');let csrf='',pendingProbe=false;
const b64=b=>{const bytes=new Uint8Array(b);let s='';for(const x of bytes)s+=String.fromCharCode(x);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
const bytes=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const raw=atob(s);return Uint8Array.from(raw,c=>c.charCodeAt(0))};
const json=async(url,opts={})=>{const r=await fetch(url,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});const body=await r.json();if(!r.ok)throw new Error(body.error||('Request failed: '+r.status));return body};
const credentialJSON=c=>({id:c.id,rawId:b64(c.rawId),type:c.type,authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults(),response:c.response.attestationObject?{clientDataJSON:b64(c.response.clientDataJSON),attestationObject:b64(c.response.attestationObject),transports:c.response.getTransports?c.response.getTransports():[]}:{clientDataJSON:b64(c.response.clientDataJSON),authenticatorData:b64(c.response.authenticatorData),signature:b64(c.response.signature),userHandle:c.response.userHandle?b64(c.response.userHandle):undefined}});
const creation=o=>({...o,challenge:bytes(o.challenge),user:{...o.user,id:bytes(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(c=>({...c,id:bytes(c.id)}))});
const request=o=>({...o,challenge:bytes(o.challenge),allowCredentials:(o.allowCredentials||[]).map(c=>({...c,id:bytes(c.id)}))});
const authError=e=>{const message=e&&e.message?e.message:String(e);if(!window.isSecureContext)return'Passkeys require a secure browser context. Open the exact localhost URL printed by CrewCode, or use the configured HTTPS Hub origin.';if(message.includes('InsecureLocalhostNotAllowed'))return'This browser or passkey provider refuses passkeys over HTTP localhost. For local testing, try current Chrome or Chromium. Otherwise run the Hub at its final HTTPS origin and create the passkey there.';return message};
function view(name){for(const id of ['setup','signin','dashboard'])$(id).hidden=id!==name}
async function refresh(){error.textContent='';const s=await json('/api/v1/hub/status');if(!s.ownerConfigured){view('setup');status.textContent=location.hash.includes('bootstrap=')?'Register the first owner passkey.':'Open the one-time setup URL printed by crewcode hub.';return}try{const me=await json('/api/v1/hub/session');csrf=me.csrf;if(window.matchMedia('(max-width: 768px)').matches&&!new URLSearchParams(location.search).has('hub-admin')){location.replace('/app?hub=mobile');return}view('dashboard');status.textContent='Hub ready';$('username').textContent=me.user.username;const mobile=$('mobile');mobile.hidden=location.protocol!=='https:';if(!mobile.hidden){$('mobile-url').textContent=location.origin;$('mobile-qr').src='/api/v1/hub/mobile-qr.svg'}const pending=await json('/api/v1/hub/device-enrollments'),pendingWrap=$('pending-wrap'),pendingList=$('pending-machines');pendingList.textContent='';pendingWrap.hidden=!pending.requests.length;for(const x of pending.requests){const row=document.createElement('div');row.className='machine';const label=document.createElement('span');label.textContent=x.name+' · code '+x.userCode+' · fingerprint '+x.publicKeyFingerprint+(x.platform?' · '+x.platform:'');row.append(label);const actions=document.createElement('span');const approve=document.createElement('button');approve.textContent='Approve';approve.onclick=async()=>{try{await json('/api/v1/hub/device-enrollments/'+encodeURIComponent(x.id)+'/approve',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'});await refresh()}catch(e){error.textContent=e.message}};const reject=document.createElement('button');reject.className='quiet';reject.textContent='Reject';reject.onclick=async()=>{try{await json('/api/v1/hub/device-enrollments/'+encodeURIComponent(x.id)+'/reject',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'});await refresh()}catch(e){error.textContent=e.message}};actions.append(approve,reject);row.append(actions);pendingList.append(row)}const m=await json('/api/v1/hub/machines'),list=$('machines');list.textContent='';if(!m.machines.length)list.textContent='No machines enrolled yet.';for(const x of m.machines){const row=document.createElement('div');row.className='machine';const label=document.createElement('span');label.textContent=x.name+' · '+x.status+(x.platform?' · '+x.platform:'');row.append(label);const actions=document.createElement('span');if(x.status==='online'){const open=document.createElement('button');open.textContent='Open';open.onclick=()=>{location.href='/app?machine='+encodeURIComponent(x.id)};actions.append(open)}if(x.status!=='revoked'){const revoke=document.createElement('button');revoke.className='quiet';revoke.textContent='Revoke';revoke.onclick=async()=>{try{await json('/api/v1/hub/machines/'+encodeURIComponent(x.id)+'/revoke',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'});await refresh()}catch(e){error.textContent=e.message}};actions.append(revoke)}row.append(actions);list.append(row)}}catch{view('signin');status.textContent='Sign in to view your machines.'}}
$('setup-button').onclick=async()=>{try{error.textContent='';const token=new URLSearchParams(location.hash.slice(1)).get('bootstrap')||'';const username=$('owner').value;const start=await json('/api/v1/hub/bootstrap/options',{method:'POST',body:JSON.stringify({token,username})});const credential=await navigator.credentials.create({publicKey:creation(start.options)});const done=await json('/api/v1/hub/bootstrap/verify',{method:'POST',body:JSON.stringify({token,username,flowId:start.flowId,response:credentialJSON(credential)})});csrf=done.csrf;history.replaceState(null,'',location.pathname);await refresh()}catch(e){error.textContent=authError(e)}};
$('signin-button').onclick=async()=>{try{error.textContent='';const start=await json('/api/v1/hub/auth/options',{method:'POST',body:'{}'});const credential=await navigator.credentials.get({publicKey:request(start.options)});const done=await json('/api/v1/hub/auth/verify',{method:'POST',body:JSON.stringify({flowId:start.flowId,response:credentialJSON(credential)})});csrf=done.csrf;await refresh()}catch(e){error.textContent=authError(e)}};
$('enrollment-button').onclick=async()=>{try{error.textContent='';const issued=await json('/api/v1/hub/enrollments',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'}),out=$('enrollment');out.hidden=false;out.textContent='Enrollment token (single use; do not share):\\n'+issued.token+'\\n\\nRun on the machine within 10 minutes, then paste the token when prompted:\\ncrewcode enroll --hub '+location.origin}catch(e){error.textContent=e.message}};
$('logout-button').onclick=async()=>{try{await json('/api/v1/hub/logout',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'});csrf='';$('enrollment').hidden=true;$('enrollment').textContent='';await refresh()}catch(e){error.textContent=e.message}};
setInterval(()=>{if($('dashboard').hidden||!$('pending-wrap').hidden||pendingProbe)return;pendingProbe=true;json('/api/v1/hub/device-enrollments').then(p=>{if(p.requests.length)return refresh()}).catch(()=>{}).finally(()=>{pendingProbe=false})},3000);
refresh().catch(e=>{status.textContent='Could not connect';error.textContent=e.message});})();`

function serveHubApp(webRoot: string | undefined, pathname: string, response: ServerResponse): boolean {
  if (!webRoot || (pathname !== '/app' && !pathname.startsWith('/assets/'))) return false
  const candidate = pathname === '/app' ? join(webRoot, 'index.html') : normalize(join(webRoot, pathname.replace(/^\/+/, '')))
  const normalizedRoot = normalize(webRoot)
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + sep)) return false
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return false
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
  const body = readFileSync(candidate)
  response.writeHead(200, {
    'content-type': mime[extname(candidate)] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': pathname === '/app' ? 'no-store' : 'public, max-age=300',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
  return true
}

function serveAsset(pathname: string, response: ServerResponse): boolean {
  let body: string
  let type: string
  if (pathname === '/' || pathname === '/setup') { body = hubHtml(); type = 'text/html; charset=utf-8' }
  else if (pathname === '/hub.css') { body = HUB_CSS; type = 'text/css; charset=utf-8' }
  else if (pathname === '/hub.js') { body = HUB_JS; type = 'text/javascript; charset=utf-8' }
  else return false
  response.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    // Hub setup/dashboard assets are tiny and contain deployment control flow.
    // Never let a phone retain stale enrollment or bootstrap behavior.
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
  return true
}

export async function startHubServer(options: HubServerOptions): Promise<RunningHubServer> {
  const host = options.host ?? '127.0.0.1'
  const now = options.now ?? Date.now
  const store = new HubStore(join(options.dataDir, 'hub.sqlite'))
  const authLimiter = new RemoteAccessRateLimiter(HUB_AUTH_ATTEMPTS_PER_MINUTE)
  const machineLimiter = new RemoteAccessRateLimiter(HUB_MACHINE_ATTEMPTS_PER_MINUTE)
  const enrollments = new HubEnrollmentIssuer(now)
  const deviceEnrollments = new HubDeviceEnrollmentIssuer(now)
  const tickets = new HubConnectionTicketIssuer(now)
  let publicOrigin = options.publicOrigin ?? ''
  let auth: HubAuth

  const currentSession = (request: IncomingMessage): HubSession | null => {
    const token = cookies(request).get(cookieName(publicOrigin)) ?? ''
    return store.authenticateSession(token, now())
  }

  const validCsrf = (request: IncomingMessage, session: HubSession): boolean => {
    const csrf = typeof request.headers['x-crewcode-csrf'] === 'string' ? request.headers['x-crewcode-csrf'] : ''
    return store.validateCsrf(session.id, csrf)
  }

  const brainSockets = new Map<string, WebSocket>()
  const relaySockets = new Set<WebSocket>()
  const relayPeer = new WeakMap<IncomingMessage, { kind: 'brain'; machineId: string } | { kind: 'browser'; ticket: string }>()
  const relayConnections = new Map<string, {
    machineId: string
    userId: string
    browserSessionId: string
    brain: WebSocket
    browser: WebSocket
    openedAt: number
    lastActivityAt: number
    traffic: HubRelayTrafficLimiter
  }>()
  const recentlyReleasedBrowserConnections = new Map<string, number>()
  const rememberReleasedBrowserConnection = (connectionId: string): void => {
    recentlyReleasedBrowserConnections.delete(connectionId)
    recentlyReleasedBrowserConnections.set(connectionId, now())
    while (recentlyReleasedBrowserConnections.size > HUB_MAX_RECENTLY_RELEASED_CONNECTIONS) {
      const oldest = recentlyReleasedBrowserConnections.keys().next().value as string | undefined
      if (!oldest) break
      recentlyReleasedBrowserConnections.delete(oldest)
    }
  }

  const terminateRelayConnection = (
    connectionId: string,
    connection: (typeof relayConnections extends Map<string, infer Value> ? Value : never),
    code: number,
    reason: string,
    auditType: string,
    metadata: Record<string, unknown> = {},
  ): void => {
    if (connection.brain.readyState === WebSocket.OPEN) {
      connection.brain.send(JSON.stringify({ type: 'close', connectionId, reason } satisfies HubRelayControlFrame))
    }
    if (connection.browser.readyState === WebSocket.OPEN) connection.browser.close(code, reason)
    relayConnections.delete(connectionId)
    store.audit(auditType, connection.userId, connection.machineId, {
      connectionId,
      browserSessionId: connection.browserSessionId,
      ...metadata,
    }, now())
  }

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname.startsWith('/api/') && !hubBrowserOriginAllowed(request, publicOrigin)) {
        sendJson(response, 403, { error: 'browser origin is not allowed' })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/hub/status') {
        sendJson(response, 200, {
          service: 'crewcode-hub',
          protocolVersion: 1,
          ownerConfigured: store.owner() !== null,
          publicOrigin,
        })
        return
      }
      if (request.method === 'POST' && (pathname.startsWith('/api/v1/hub/bootstrap/') || pathname.startsWith('/api/v1/hub/auth/'))) {
        const limited = authLimiter.consume(remotePeerKey(request), now())
        if (!limited.allowed) {
          response.setHeader('retry-after', String(limited.retryAfterSeconds))
          sendJson(response, 429, { error: `too many authentication attempts; retry in ${limited.retryAfterSeconds}s` })
          return
        }
      }
      if (request.method === 'POST' && (pathname.startsWith('/api/v1/hub/machines/') || pathname === '/api/v1/hub/enrollments' || pathname.startsWith('/api/v1/hub/device-enrollments'))) {
        const limited = machineLimiter.consume(remotePeerKey(request), now())
        if (!limited.allowed) {
          response.setHeader('retry-after', String(limited.retryAfterSeconds))
          sendJson(response, 429, { error: `too many machine requests; retry in ${limited.retryAfterSeconds}s` })
          return
        }
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/bootstrap/options') {
        const body = await readJson(request)
        sendJson(response, 200, await auth.registrationOptions(String(body.token ?? ''), String(body.username ?? '')))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/bootstrap/verify') {
        const body = await readJson(request)
        const result = await auth.verifyRegistration({ token: String(body.token ?? ''), flowId: String(body.flowId ?? ''), username: String(body.username ?? ''), response: body.response as RegistrationResponseJSON })
        setSessionCookie(response, publicOrigin, result.token)
        sendJson(response, 200, { user: result.user, csrf: result.csrf })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/auth/options') {
        sendJson(response, 200, await auth.authenticationOptions())
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/auth/verify') {
        const body = await readJson(request)
        const result = await auth.verifyAuthentication({ flowId: String(body.flowId ?? ''), response: body.response as AuthenticationResponseJSON })
        setSessionCookie(response, publicOrigin, result.token)
        sendJson(response, 200, { user: result.user, csrf: result.csrf })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/hub/session') {
        const session = currentSession(request)
        const owner = store.owner()
        if (!session || !owner || session.userId !== owner.id) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        sendJson(response, 200, { user: owner, csrf: store.rotateCsrf(session.id) })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/device-enrollments/request') {
        const owner = store.owner()
        if (!owner) { sendJson(response, 409, { error: 'Hub owner must be configured before enrolling a machine' }); return }
        const body = await readJson(request)
        const publicKey = machinePublicKey(body.publicKey)
        const name = boundedString(body.name, 'name', 80) as string
        const platform = boundedString(body.platform, 'platform', 80, true)
        const version = boundedString(body.version, 'version', 80, true)
        const issued = deviceEnrollments.request({ publicKey, name, platform, version })
        store.audit('hub.device-enrollment.requested', owner.id, null, { requestId: issued.requestId, name, platform, expiresAt: issued.expiresAt }, now())
        sendJson(response, 201, issued)
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/device-enrollments/poll') {
        const body = await readJson(request)
        const requestToken = boundedString(body.requestToken, 'requestToken', 256) as string
        const result = deviceEnrollments.poll(requestToken)
        if (!result) { sendJson(response, 401, { error: 'device enrollment request is invalid or expired' }); return }
        if (result.status === 'pending') { sendJson(response, 202, result); return }
        if (result.status === 'rejected') { sendJson(response, 403, { error: 'device enrollment was rejected' }); return }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/hub/device-enrollments') {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        sendJson(response, 200, { requests: deviceEnrollments.list() })
        return
      }
      const deviceDecision = request.method === 'POST' ? pathname.match(/^\/api\/v1\/hub\/device-enrollments\/([a-f0-9]{32})\/(approve|reject)$/) : null
      if (deviceDecision) {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        if (!validCsrf(request, session)) { sendJson(response, 403, { error: 'valid CSRF token required' }); return }
        const pending = deviceEnrollments.pendingRequest(deviceDecision[1])
        if (!pending) { sendJson(response, 404, { error: 'pending device enrollment not found' }); return }
        if (deviceDecision[2] === 'reject') {
          deviceEnrollments.reject(pending.id)
          store.audit('hub.device-enrollment.rejected', session.userId, null, { requestId: pending.id, name: pending.name }, now())
          sendJson(response, 200, { rejected: true })
          return
        }
        const created = store.createMachine({ userId: session.userId, publicKey: pending.publicKey, name: pending.name, platform: pending.platform, version: pending.version, now: now() })
        if (!deviceEnrollments.approve(pending.id, { machineId: created.machine.id, token: created.token })) {
          // The pending request can only disappear through expiry in this
          // synchronous section; revoke the just-created credential fail-closed.
          store.revokeMachine(session.userId, created.machine.id, now())
          sendJson(response, 409, { error: 'device enrollment expired during approval' })
          return
        }
        store.audit('hub.device-enrollment.approved', session.userId, created.machine.id, { requestId: pending.id, name: pending.name }, now())
        sendJson(response, 201, { approved: true, machineId: created.machine.id })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/hub/mobile-qr.svg') {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        const svg = await QRCode.toString(publicOrigin, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
        response.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': Buffer.byteLength(svg), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        response.end(svg)
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/hub/machines') {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        sendJson(response, 200, { machines: store.machinesForUser(session.userId, now(), HUB_MACHINE_ONLINE_WINDOW_MS) })
        return
      }
      const ticketMatch = request.method === 'POST' ? pathname.match(/^\/api\/v1\/hub\/machines\/([a-f0-9]{32})\/tickets$/) : null
      if (ticketMatch) {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        if (!validCsrf(request, session)) { sendJson(response, 403, { error: 'valid CSRF token required' }); return }
        const machine = store.machineAuthorityForUser(session.userId, ticketMatch[1])
        if (!machine) { sendJson(response, 404, { error: 'active machine not found' }); return }
        if (!brainSockets.has(machine.id)) { sendJson(response, 409, { error: 'machine relay is offline' }); return }
        const body = await readJson(request)
        const requestedScopes = requestedBrainScopes(body.requestedScopes)
        const issued = tickets.issue({ userId: session.userId, browserSessionId: session.id, machineId: machine.id, requestedScopes })
        store.audit('hub.connection.ticket-issued', session.userId, machine.id, { browserSessionId: session.id, requestedScopes, expiresAt: issued.expiresAt }, now())
        sendJson(response, 201, { ...issued, machineId: machine.id, machinePublicKey: machine.publicKey, requestedScopes })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/enrollments') {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        if (!validCsrf(request, session)) { sendJson(response, 403, { error: 'valid CSRF token required' }); return }
        const issued = enrollments.issue(session.userId)
        store.audit('hub.enrollment.issued', session.userId, null, { expiresAt: issued.expiresAt }, now())
        sendJson(response, 201, issued)
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/machines/enroll') {
        const body = await readJson(request)
        const enrollmentToken = boundedString(body.enrollmentToken, 'enrollmentToken', 256) as string
        const publicKey = machinePublicKey(body.publicKey)
        const name = boundedString(body.name, 'name', 80) as string
        const platform = boundedString(body.platform, 'platform', 80, true)
        const version = boundedString(body.version, 'version', 80, true)
        const enrollment = enrollments.consume(enrollmentToken)
        if (!enrollment) { sendJson(response, 401, { error: 'valid unexpired enrollment token required' }); return }
        const created = store.createMachine({ userId: enrollment.userId, publicKey, name, platform, version, now: now() })
        sendJson(response, 201, { machineId: created.machine.id, token: created.token })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/machines/heartbeat') {
        const machine = store.authenticateMachine(bearerToken(request))
        if (!machine) { sendJson(response, 401, { error: 'valid machine credential required' }); return }
        const body = await readJson(request)
        const platform = boundedString(body.platform, 'platform', 80, true)
        const version = boundedString(body.version, 'version', 80, true)
        if (!store.heartbeatMachine(machine.id, platform, version, now())) { sendJson(response, 401, { error: 'machine credential is no longer active' }); return }
        sendJson(response, 200, { ok: true })
        return
      }
      const revokeMatch = request.method === 'POST' ? pathname.match(/^\/api\/v1\/hub\/machines\/([a-f0-9]{32})\/revoke$/) : null
      if (revokeMatch) {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        if (!validCsrf(request, session)) { sendJson(response, 403, { error: 'valid CSRF token required' }); return }
        if (!store.revokeMachine(session.userId, revokeMatch[1], now())) { sendJson(response, 404, { error: 'active machine not found' }); return }
        brainSockets.get(revokeMatch[1])?.close(4003, 'machine revoked')
        for (const [connectionId, connection] of relayConnections) {
          if (connection.machineId !== revokeMatch[1]) continue
          connection.browser.close(4003, 'machine revoked')
          relayConnections.delete(connectionId)
        }
        sendJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/logout') {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        if (!validCsrf(request, session)) { sendJson(response, 403, { error: 'valid CSRF token required' }); return }
        store.revokeSession(session.id, now())
        clearSessionCookie(response, publicOrigin)
        sendJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && serveHubApp(options.webRoot, pathname, response)) return
      if (request.method === 'GET' && serveAsset(pathname, response)) return
      sendJson(response, 404, { error: 'route not found' })
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message })
    }
  })

  const websocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols: protocols => protocols.has(HUB_BRAIN_RELAY_PROTOCOL)
      ? HUB_BRAIN_RELAY_PROTOCOL
      : protocols.has(HUB_BROWSER_RELAY_PROTOCOL) ? HUB_BROWSER_RELAY_PROTOCOL : false,
  })
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean)
    const protocol = protocols.find(value => value === HUB_BRAIN_RELAY_PROTOCOL || value === HUB_BROWSER_RELAY_PROTOCOL)
    const credential = protocols.find(value => value !== protocol) ?? ''
    if (pathname !== '/api/v1/hub/relay' || !protocol || !credential) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (protocol === HUB_BRAIN_RELAY_PROTOCOL) {
      const machine = store.authenticateMachine(credential)
      if (!machine) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
      relayPeer.set(request, { kind: 'brain', machineId: machine.id })
    } else {
      if (!hubBrowserOriginAllowed(request, publicOrigin)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
      relayPeer.set(request, { kind: 'browser', ticket: credential })
    }
    websocketServer.handleUpgrade(request, socket, head, ws => websocketServer.emit('connection', ws, request))
  })
  websocketServer.on('connection', (socket, request) => {
    const peer = relayPeer.get(request)
    if (!peer) { socket.close(4001, 'relay authentication missing'); return }
    relaySockets.add(socket)
    if (peer.kind === 'brain') {
      const previous = brainSockets.get(peer.machineId)
      if (previous && previous !== socket) previous.close(4000, 'replaced by a newer brain relay')
      brainSockets.set(peer.machineId, socket)
      socket.send(JSON.stringify({ type: 'brainReady', machineId: peer.machineId } satisfies HubRelayControlFrame))
    } else {
      const claims = tickets.consume(peer.ticket)
      if (!claims) { socket.close(4001, 'invalid or expired connection ticket'); return }
      const brain = brainSockets.get(claims.machineId)
      const machine = store.machineAuthorityForUser(claims.userId, claims.machineId)
      if (!brain || brain.readyState !== WebSocket.OPEN || !machine) { socket.close(4004, 'machine relay is offline'); return }
      const activeConnections = [...relayConnections.values()]
      if (activeConnections.filter(connection => connection.machineId === claims.machineId).length >= HUB_MAX_CONNECTIONS_PER_MACHINE
        || activeConnections.filter(connection => connection.userId === claims.userId).length >= HUB_MAX_CONNECTIONS_PER_USER) {
        socket.close(4008, 'relay connection limit reached')
        return
      }
      const connectionId = randomBytes(16).toString('hex')
      const openedAt = now()
      relayConnections.set(connectionId, {
        machineId: claims.machineId, userId: claims.userId, browserSessionId: claims.browserSessionId,
        brain, browser: socket, openedAt, lastActivityAt: openedAt,
        traffic: new HubRelayTrafficLimiter(openedAt),
      })
      const connect: HubRelayControlFrame = { type: 'connect', connectionId, userId: claims.userId, browserSessionId: claims.browserSessionId, requestedScopes: claims.requestedScopes }
      const ready: HubRelayControlFrame = { type: 'ready', connectionId, machineId: claims.machineId, machinePublicKey: machine.publicKey, requestedScopes: claims.requestedScopes }
      brain.send(JSON.stringify(connect))
      socket.send(JSON.stringify(ready))
      store.audit('hub.connection.opened', claims.userId, claims.machineId, { connectionId, browserSessionId: claims.browserSessionId }, now())
    }
    socket.on('message', (raw, binary) => {
      const encoded = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)
      if (binary || encoded.byteLength > HUB_RELAY_MAX_FRAME_BYTES) { socket.close(4009, 'relay frame rejected'); return }
      let frame: HubRelayControlFrame
      try { frame = JSON.parse(encoded.toString()) as HubRelayControlFrame } catch { socket.close(4002, 'invalid relay frame'); return }
      if (!frame || !('connectionId' in frame) || typeof frame.connectionId !== 'string') { socket.close(4002, 'invalid relay frame'); return }
      const connectionId = frame.connectionId
      const connection = relayConnections.get(connectionId)
      if (!connection) {
        // A browser close and an in-flight Brain RPC result can cross in
        // transit. Drop late opaque frames only for bounded connection ids the
        // Hub itself recently released; arbitrary unknown ids still fail closed.
        const releasedAt = recentlyReleasedBrowserConnections.get(connectionId)
        if (peer.kind === 'brain' && releasedAt !== undefined && now() - releasedAt < HUB_LATE_BRAIN_FRAME_GRACE_MS) return
        if (releasedAt !== undefined) recentlyReleasedBrowserConnections.delete(connectionId)
        socket.close(4004, 'unknown relay connection')
        return
      }
      const fromBrowser = socket === connection.browser
      const allowed = fromBrowser
        ? frame.type === 'clientHello' || frame.type === 'encrypted' || frame.type === 'close'
        : socket === connection.brain && (frame.type === 'serverHello' || frame.type === 'encrypted' || frame.type === 'close')
      if (!allowed) { socket.close(4003, 'relay direction is not allowed'); return }
      const receivedAt = now()
      const trafficLimit = connection.traffic.consume(encoded.byteLength, receivedAt)
      if (trafficLimit) {
        terminateRelayConnection(connectionId, connection, 4011, trafficLimit, 'hub.connection.rate-limited', {
          reason: trafficLimit,
          frameBytes: encoded.byteLength,
          direction: fromBrowser ? 'browser-to-brain' : 'brain-to-browser',
        })
        return
      }
      connection.lastActivityAt = receivedAt
      const target = fromBrowser ? connection.brain : connection.browser
      if (target.readyState !== WebSocket.OPEN || target.bufferedAmount > HUB_RELAY_MAX_FRAME_BYTES * 4) {
        socket.close(4010, 'relay backpressure limit reached')
        target.close(4010, 'relay backpressure limit reached')
        relayConnections.delete(frame.connectionId)
        return
      }
      target.send(encoded.toString())
      if (frame.type === 'close') {
        if (fromBrowser) rememberReleasedBrowserConnection(connectionId)
        relayConnections.delete(connectionId)
      }
    })
    socket.on('close', (code, reasonBuffer) => {
      relaySockets.delete(socket)
      if (peer.kind === 'brain' && brainSockets.get(peer.machineId) === socket) brainSockets.delete(peer.machineId)
      for (const [connectionId, connection] of relayConnections) {
        if (connection.brain !== socket && connection.browser !== socket) continue
        const closedPeer = connection.brain === socket ? 'brain' : 'browser'
        // Hub shutdown sets `closed` before closing sockets and may close the
        // SQLite store as soon as the HTTP server drains. That lifecycle is
        // already observed by the caller; audit only unexpected/live-server
        // peer closure so late WebSocket callbacks never touch a closed store.
        if (!closed) {
          store.audit('hub.connection.closed', connection.userId, connection.machineId, {
            connectionId,
            browserSessionId: connection.browserSessionId,
            closedPeer,
            code,
            reason: reasonBuffer.toString(),
          }, now())
        }
        if (connection.brain === socket) {
          if (connection.browser.readyState === WebSocket.OPEN) connection.browser.close(4000, 'Brain relay disconnected')
        } else if (connection.brain.readyState === WebSocket.OPEN) {
          // The Brain socket is the machine's persistent outbound transport and
          // can multiplex browser sessions. Closing one browser must release
          // only that logical session, not disconnect the enrolled machine.
          rememberReleasedBrowserConnection(connectionId)
          connection.brain.send(JSON.stringify({ type: 'close', connectionId, reason: 'browser disconnected' } satisfies HubRelayControlFrame))
        }
        relayConnections.delete(connectionId)
      }
    })
  })

  const relayExpirySweep = setInterval(() => {
    const at = now()
    for (const [connectionId, releasedAt] of recentlyReleasedBrowserConnections) {
      if (at - releasedAt >= HUB_LATE_BRAIN_FRAME_GRACE_MS) recentlyReleasedBrowserConnections.delete(connectionId)
    }
    for (const [connectionId, connection] of relayConnections) {
      const reason = hubRelayExpiryReason(connection, at)
      if (!reason) continue
      terminateRelayConnection(connectionId, connection, 4000, reason, 'hub.connection.expired', {
        reason,
        openedAt: connection.openedAt,
        lastActivityAt: connection.lastActivityAt,
      })
    }
  }, HUB_RELAY_EXPIRY_SWEEP_MS)
  relayExpirySweep.unref()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Hub did not bind a TCP address')
  const displayHost = host === '127.0.0.1' ? 'localhost' : host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host
  const url = `http://${displayHost}:${address.port}`
  publicOrigin ||= url
  auth = new HubAuth(store, publicOrigin, now)
  const bootstrap = auth.issueBootstrap()
  let closed = false
  return {
    host,
    port: address.port,
    url,
    publicOrigin,
    ...(bootstrap ? { bootstrapToken: bootstrap.token, bootstrapUrl: `${publicOrigin}/#bootstrap=${encodeURIComponent(bootstrap.token)}` } : {}),
    ownerConfigured: () => !closed && store.owner() !== null,
    enrollLocalMachine: input => {
      if (closed) throw new Error('Hub is shutting down')
      const owner = store.owner()
      if (!owner) throw new Error('Hub owner must be configured before enrolling the local Brain')
      const name = boundedString(input.name, 'name', 80) as string
      const created = store.createMachine({
        userId: owner.id,
        publicKey: machinePublicKey(input.publicKey),
        name,
        platform: boundedString(input.platform, 'platform', 80, true),
        version: boundedString(input.version, 'version', 80, true),
        now: now(),
      })
      store.audit('hub.local-brain.enrolled', owner.id, created.machine.id, { name }, now())
      return { machineId: created.machine.id, token: created.token }
    },
    close: () => new Promise<void>((resolve, reject) => {
      closed = true
      clearInterval(relayExpirySweep)
      for (const socket of relaySockets) socket.close(1001, 'Hub shutting down')
      websocketServer.close()
      server.close(error => {
        store.close()
        error ? reject(error) : resolve()
      })
    }),
  }
}
