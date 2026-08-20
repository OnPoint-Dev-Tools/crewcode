import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { join } from 'path'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { remotePeerKey, RemoteAccessRateLimiter } from './remote-access-security'
import { HubAuth } from './hub-auth'
import { HubStore, type HubSession } from './hub-store'

const MAX_BODY_BYTES = 1024 * 1024
const HUB_AUTH_ATTEMPTS_PER_MINUTE = 30
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
<div id="dashboard" hidden><div class="row"><strong id="username"></strong><button id="logout-button" class="quiet">Sign out</button></div><h2>Machines</h2><div id="machines" class="machines"></div></div>
<p id="error" class="error"></p></section></main><script src="/hub.js"></script></body></html>`
}

const HUB_CSS = `:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0f120f;color:#d7e0dc}*{box-sizing:border-box}body{margin:0}main{min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(560px,100%);border:1px solid #1c2f2f;padding:28px;background:#0f120f}.eyebrow{font:600 11px/1.4 monospace;letter-spacing:.18em;color:#79958a}h1{margin:.25rem 0 1.25rem;font-size:26px}h2{font-size:15px;margin-top:24px}label{display:grid;gap:8px;margin:20px 0;font-size:13px}input,button{border:1px solid #285a48;background:#131a17;color:inherit;padding:10px 12px;font:inherit}button{cursor:pointer;background:#285a48}.quiet{background:transparent}.row{display:flex;align-items:center;justify-content:space-between;gap:16px}.machines{border-top:1px solid #1c2f2f;padding-top:14px;color:#8da49a;font:13px/1.5 monospace}.error{color:#d89595;min-height:1.4em}`

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
async function refresh(){error.textContent='';const s=await json('/api/v1/hub/status');if(!s.ownerConfigured){view('setup');status.textContent=location.hash.includes('bootstrap=')?'Register the first owner passkey.':'Open the one-time setup URL printed by crewcode hub.';return}try{const me=await json('/api/v1/hub/session');csrf=me.csrf;view('dashboard');status.textContent='Hub ready';$('username').textContent=me.user.username;const m=await json('/api/v1/hub/machines');$('machines').textContent=m.machines.length?m.machines.map(x=>x.name+' · '+x.status).join('\\n'):'No machines enrolled yet.'}catch{view('signin');status.textContent='Sign in to view your machines.'}}
$('setup-button').onclick=async()=>{try{error.textContent='';const token=new URLSearchParams(location.hash.slice(1)).get('bootstrap')||'';const username=$('owner').value;const start=await json('/api/v1/hub/bootstrap/options',{method:'POST',body:JSON.stringify({token,username})});const credential=await navigator.credentials.create({publicKey:creation(start.options)});const done=await json('/api/v1/hub/bootstrap/verify',{method:'POST',body:JSON.stringify({token,username,flowId:start.flowId,response:credentialJSON(credential)})});csrf=done.csrf;history.replaceState(null,'',location.pathname);await refresh()}catch(e){error.textContent=authError(e)}};
$('signin-button').onclick=async()=>{try{error.textContent='';const start=await json('/api/v1/hub/auth/options',{method:'POST',body:'{}'});const credential=await navigator.credentials.get({publicKey:request(start.options)});const done=await json('/api/v1/hub/auth/verify',{method:'POST',body:JSON.stringify({flowId:start.flowId,response:credentialJSON(credential)})});csrf=done.csrf;await refresh()}catch(e){error.textContent=authError(e)}};
$('logout-button').onclick=async()=>{try{await json('/api/v1/hub/logout',{method:'POST',headers:{'x-crewcode-csrf':csrf},body:'{}'});csrf='';await refresh()}catch(e){error.textContent=e.message}};
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
  let publicOrigin = options.publicOrigin ?? ''
  let auth: HubAuth

  const currentSession = (request: IncomingMessage): HubSession | null => {
    const token = cookies(request).get(cookieName(publicOrigin)) ?? ''
    return store.authenticateSession(token, now())
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
        sendJson(response, 200, { machines: store.machinesForUser(session.userId) })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/hub/logout') {
        const session = currentSession(request)
        if (!session) { sendJson(response, 401, { error: 'valid Hub session required' }); return }
        const csrf = typeof request.headers['x-crewcode-csrf'] === 'string' ? request.headers['x-crewcode-csrf'] : ''
        if (!store.validateCsrf(session.id, csrf)) { sendJson(response, 403, { error: 'valid CSRF token required' }); return }
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
