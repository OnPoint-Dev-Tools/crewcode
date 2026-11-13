import type { AgentBridge } from './bridge-types'

/** Stop is a teardown request, not a wait for a provider cancellation acknowledgement. */
export async function stopRuntime(bridge: Pick<AgentBridge, 'abort' | 'stop'>): Promise<void> {
  try { void bridge.abort().catch(() => {}) } catch { /* teardown still has to run */ }
  await bridge.stop()
}
