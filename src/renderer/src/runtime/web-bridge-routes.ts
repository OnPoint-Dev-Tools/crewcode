export interface WebBridgeRoute {
  bridgeId: string
  tabId: string
  cwd?: string
  provider?: string
}

const STORAGE_KEY = 'crewcode:web-bridge-routes:v1'
const MAX_ROUTES = 100

function loadRoutes(): Map<string, WebBridgeRoute> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return new Map()
    return new Map(parsed.slice(-MAX_ROUTES).flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const route = value as Partial<WebBridgeRoute>
      if (typeof route.bridgeId !== 'string' || !route.bridgeId || typeof route.tabId !== 'string' || !route.tabId) return []
      return [[route.bridgeId, {
        bridgeId: route.bridgeId,
        tabId: route.tabId,
        cwd: typeof route.cwd === 'string' ? route.cwd : undefined,
        provider: typeof route.provider === 'string' ? route.provider : undefined,
      }]]
    }))
  } catch { return new Map() }
}

function persistRoutes(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...routes.values()].slice(-MAX_ROUTES))) } catch { /* recovery remains available in this page */ }
}

// This stores only opaque browser chat/resource ids and an optional workspace
// path. It grants no authority: every recovery still needs a fresh ticket,
// authenticated owner, E2EE tunnel, and Brain-local agent scope.
const routes = loadRoutes()
// Process-local proof that this page's encrypted session successfully claimed a
// Brain execution. Persisted route metadata is never ownership authority.
const claimedRouteIds = new Set<string>()

export function markClaimedWebBridgeRoutes(bridgeIds: Iterable<string>): void {
  for (const bridgeId of bridgeIds) if (routes.has(bridgeId)) claimedRouteIds.add(bridgeId)
}

export function clearClaimedWebBridgeRoutes(): void {
  claimedRouteIds.clear()
}

export function claimedWebBridgeRoutes(): WebBridgeRoute[] {
  return [...claimedRouteIds].flatMap(bridgeId => {
    const route = routes.get(bridgeId)
    return route ? [route] : []
  })
}

export function rememberWebBridgeRoutes(next: WebBridgeRoute[]): void {
  for (const route of next) {
    if (!route.bridgeId || !route.tabId) continue
    routes.delete(route.bridgeId)
    routes.set(route.bridgeId, route)
  }
  persistRoutes()
}

export function webBridgeRoutes(): WebBridgeRoute[] {
  return [...routes.values()]
}

export function forgetWebBridgeRoute(bridgeId: string): void {
  claimedRouteIds.delete(bridgeId)
  routes.delete(bridgeId)
  persistRoutes()
}
