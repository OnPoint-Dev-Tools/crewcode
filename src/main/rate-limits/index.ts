import { ipcMain } from 'electron'
import { RateLimitService } from './service'

export { RateLimitService } from './service'

export function registerRateLimitIpc(service: RateLimitService): void {
  ipcMain.handle('rateLimits:get', () => service.getState())
  ipcMain.handle('rateLimits:refresh', () => service.refresh())
  ipcMain.handle('rateLimits:setPollingInterval', (_event, ms: number) =>
    service.setPollingInterval(ms)
  )
}
