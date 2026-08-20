import { createPublicKey } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { join } from 'path'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { remotePeerKey, RemoteAccessRateLimiter } from './remote-access-security'
import { HubAuth } from './hub-auth'
import { HubEnrollmentIssuer, HUB_MACHINE_ONLINE_WINDOW_MS } from './hub-machine-enrollment'
import { HubStore, type HubSession } from './hub-store'

const MAX_BODY_BYTES = 1024 * 1024
const HUB_AUTH_ATTEMPTS_PER_MINUTE = 30
const HUB_MACHINE_ATTEMPTS_PER_MINUTE = 60
const SESSION_COOKIE_HTTP = 'crewcode_hub_session'
const SESSION_COOKIE_HTTPS = '__Host-crewcode_hub_session'

export interface HubServerOptions {
  host?: string
  port?: number
  dataDir: string
  publicOrigin?: string
  now?: () => number
}

export interface RunningHubServer {
  host: string
  port: number
  url: string
  publicOrigin: string
  bootstrapToken?: string
  bootstrapUrl?: string
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
<div id="dashboard" hidden><div class="row"><strong id="username"></strong><button id="logout-button" class="quiet">Sign out</button></div><h2>Machines</h2><div id="machines" class="machines"></div><button id="enrollment-button">Enroll a machine</button><pre id="enrollment" hidden></pre></div>
<p id="error" class="error"></p></section></main><script src="/hub.js"></script></body></html>`
}

const HUB_CSS = `:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0f120f;color:#d7e0dc}*{box-sizing:border-box}body{margin:0}main{min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(640px,100%);border:1px solid #1c2f2f;padding:28px;background:#0f120f}.eyebrow{font:600 11px/1.4 monospace;letter-spacing:.18em;color:#79958a}h1{margin:.25rem 0 1.25rem;font-size:26px}h2{font-size:15px;margin-top:24px}label{display:grid;gap:8px;margin:20px 0;font-size:13px}input,button{border:1px solid #285a48;background:#131a17;color:inherit;padding:10px 12px;font:inherit}button{cursor:pointer;background:#285a48}.quiet{background:transparent}.row,.machine{display:flex;align-items:center;justify-content:space-between;gap:16px}.machines{border-top:1px solid #1c2f2f;margin-bottom:14px;color:#8da49a;font:13px/1.5 monospace}.machine{padding:10px 0;border-bottom:1px solid #1c2f2f}.machine button{padding:5px 8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #1c2f2f;padding:12px;color:#8da49a}.error{color:#d89595;min-height:1.4em}`

const HUB_JS = `(()=>{'use strict';
const $=id=>document.getElementById(id),status=$('status'),error=$('error');let csrf='';
const b64=b=>{const bytes=new Uint8Array(b);let s='';for(const x of bytes)s+=String.fromCharCode(x);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
const bytes=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const raw=atob(s);return Uint8Array.from(raw,c=>c.charCodeAt(0))};
const json=async(url,opts={})=>{const r=await fetch(url,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});const body=await r.json();if(!r.ok)throw new Error(body.error||('Request failed: '+r.status));return body};
const credentialJSON=c=>({id:c.id,rawId:b64(c.rawId),type:c.type,authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults(),response:c.response.attestationObject?{clientDataJSON:b64(c.response.clientDataJSON),attestationObject:b64(c.response.attestationObject),transports:c.response.getTransports?c.response.getTransports():[]}:{clientDataJSON:b64(c.response.clientDataJSON),authenticatorData:b64(c.response.authenticatorData),signature:b64(c.response.signature),userHandle:c.response.userHandle?b64(c.response.userHandle):undefined}});
const creation=o=>({...o,challenge:bytes(o.challenge),user:{...o.user,id:bytes(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(c=>({...c,id:bytes(c.id)}))});
const request=o=>({...o,challenge:bytes(o.challenge),allowCredentials:(o.allowCredentials||[]).map(c=>({...c,id:bytes(c.id)}))});
const authError=e=>{const message=e&&e.message?e.message:String(e);if(!window.isSecureContext)return'Passkeys require a secure browser context. Open the exact localhost URL printed by CrewCode, or use the configured HTTPS Hub origin.';if(message.includes('InsecureLocalhostNotAllowed'))return'This browser or passkey provider refuses passkeys over HTTP localhost. For local testing, try current Chrome or Chromium. Otherwise run the Hub at its final HTTPS origin and create the passkey there.';return message};
function view(name){for(const id of ['setup','signin','dashboard'])$(id).hidden=id!==name}
async function refresh(){error.textContent='';const s=await json('/api/v1/hub/status');if(!s.ownerConfigured){view('setup');status.textContent=location.hash.includes('bootstrap=')?'Register the first owner passkey.':'Open the one-time setup URL printed by crewcode hub.';return}try{const me=await json('/api/v1/hub/session');csrf=me.csrf;view('dashboard');status.textContent='Hub ready';$('username').textContent=me.user.username;const m=await json('/api/v1/hub/machines'),list=$('machines');list.textContent='';if(!m.machines.length)list.textContent='No machines enrolled yet.';for(const x of m.machines){const row=document.createElement('div');row.className='machine';const label=document.createElement('span');label.textContent=x.name+' · '+x.status+(x.platform?' · '+x.platform:'');row.append(label);if(x.status!=='revoked'){const revoke=document.createElement('button');revoke.className='quiet';revoke.textContent='Revoke';revoke.onclick=async()=>{try{await json('/api/v1/hub/machines/'+encodeURIComponent(x.id)+'/revoke',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'});await refresh()}catch(e){error.textContent=e.message}};row.append(revoke)}list.append(row)}}catch{view('signin');status.textContent='Sign in to view your machines.'}}
$('setup-button').onclick=async()=>{try{error.textContent='';const token=new URLSearchParams(location.hash.slice(1)).get('bootstrap')||'';const username=$('owner').value;const start=await json('/api/v1/hub/bootstrap/options',{method:'POST',body:JSON.stringify({token,username})});const credential=await navigator.credentials.create({publicKey:creation(start.options)});const done=await json('/api/v1/hub/bootstrap/verify',{method:'POST',body:JSON.stringify({token,username,flowId:start.flowId,response:credentialJSON(credential)})});csrf=done.csrf;history.replaceState(null,'',location.pathname);await refresh()}catch(e){error.textContent=authError(e)}};
$('signin-button').onclick=async()=>{try{error.textContent='';const start=await json('/api/v1/hub/auth/options',{method:'POST',body:'{}'});const credential=await navigator.credentials.get({publicKey:request(start.options)});const done=await json('/api/v1/hub/auth/verify',{method:'POST',body:JSON.stringify({flowId:start.flowId,response:credentialJSON(credential)})});csrf=done.csrf;await refresh()}catch(e){error.textContent=authError(e)}};
$('enrollment-button').onclick=async()=>{try{error.textContent='';const issued=await json('/api/v1/hub/enrollments',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'}),out=$('enrollment');out.hidden=false;out.textContent='Enrollment token (single use; do not share):\\n'+issued.token+'\\n\\nRun on the machine within 10 minutes, then paste the token when prompted:\\ncrewcode enroll --hub '+location.origin}catch(e){error.textContent=e.message}};
$('logout-button').onclick=async()=>{try{await json('/api/v1/hub/logout',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'});csrf='';$('enrollment').hidden=true;$('enrollment').textContent='';await refresh()}catch(e){error.textContent=e.message}};
refresh().catch(e=>{status.textContent='Could not connect';error.textContent=e.message});})();`

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
    'cache-control': pathname === '/' ? 'no-store' : 'public, max-age=300',
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

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname.startsWith('/api/') && !hubBrowserOriginAllowed(request, publicOrigin)) {
        sendJson(response, 403, { error: 'browser origin is not allowed' })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/hub/status') {
        sendJson(response, 200, { service: 'crewcode-hub', protocolVersion: 1, ownerConfigured: store.owner() !== null })
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
      if (request.method === 'POST' && (pathname.startsWith('/api/v1/hub/machines/') || pathname === '/api/v1/hub/enrollments')) {
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
      if (request.method === 'GET' && pathname === '/api/v1/hub/machines') {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        sendJson(response, 200, { machines: store.machinesForUser(session.userId, now(), HUB_MACHINE_ONLINE_WINDOW_MS) })
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
      if (request.method === 'GET' && serveAsset(pathname, response)) return
      sendJson(response, 404, { error: 'route not found' })
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message })
    }
  })

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
  return {
    host,
    port: address.port,
    url,
    publicOrigin,
    ...(bootstrap ? { bootstrapToken: bootstrap.token, bootstrapUrl: `${publicOrigin}/#bootstrap=${encodeURIComponent(bootstrap.token)}` } : {}),
    close: () => new Promise<void>((resolve, reject) => server.close(error => {
      store.close()
      error ? reject(error) : resolve()
    })),
  }
}
