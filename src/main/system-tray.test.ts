import { describe, expect, it, vi } from 'vitest'
import { revealBrowserWindow, SystemTrayService } from './system-tray'

function harness(platform: NodeJS.Platform = 'linux') {
  const icon = { resize: vi.fn(), setTemplateImage: vi.fn() }
  icon.resize.mockReturnValue(icon)
  const handlers = new Map<string, () => void>()
  const tray = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler) }),
    destroy: vi.fn(),
  }
  let template: Electron.MenuItemConstructorOptions[] = []
  const menu = { id: 'tray-menu' }
  const showWindow = vi.fn()
  const quitApp = vi.fn()
  const createTray = vi.fn(() => tray as never)
  const service = new SystemTrayService({
    appName: 'CrewCode', platform,
    createTray,
    buildMenu: vi.fn(next => { template = next; return menu as never }),
    showWindow, quitApp,
  })
  return { icon, tray, template: () => template, menu, handlers, createTray, showWindow, quitApp, service }
}

describe('SystemTrayService', () => {
  it('creates an opt-in Open/Quit tray and removes it when disabled', () => {
    const h = harness()
    h.service.configure(true, h.icon as never)
    expect(h.tray.setToolTip).toHaveBeenCalledWith('CrewCode')
    expect(h.template().map(item => item.label ?? item.type)).toEqual(['Open CrewCode', 'separator', 'Quit CrewCode'])
    h.template()[0].click?.({} as never, undefined as never, {} as never)
    expect(h.showWindow).toHaveBeenCalledOnce()
    h.template()[2].click?.({} as never, undefined as never, {} as never)
    expect(h.quitApp).toHaveBeenCalledOnce()
    expect(h.service.interceptClose({ preventDefault: vi.fn() } as never, { hide: vi.fn() } as never)).toBe(false)
    h.service.configure(false, h.icon as never)
    expect(h.tray.destroy).toHaveBeenCalledOnce()
  })

  it('hides close attempts only while background mode is enabled', () => {
    const h = harness()
    const event = { preventDefault: vi.fn() }
    const window = { hide: vi.fn() }
    expect(h.service.interceptClose(event as never, window as never)).toBe(false)
    h.service.configure(true, h.icon as never)
    expect(h.service.interceptClose(event as never, window as never)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()
    h.service.prepareToQuit()
    expect(h.service.interceptClose(event as never, window as never)).toBe(false)
  })

  it('uses a macOS template icon without registering a double-click handler', () => {
    const h = harness('darwin')
    h.service.configure(true, h.icon as never)
    expect(h.icon.resize).toHaveBeenCalledWith({ width: 18, height: 18 })
    expect(h.icon.setTemplateImage).toHaveBeenCalledWith(true)
    expect(h.tray.on).not.toHaveBeenCalled()
  })

  it('keeps Linux tray activation on click and retains the menu instance', () => {
    const h = harness('linux')
    h.service.configure(true, h.icon as never, '/tmp/crewcode.png')
    expect(h.createTray).toHaveBeenCalledWith('/tmp/crewcode.png')
    expect(h.tray.setContextMenu).toHaveBeenCalledWith(h.menu)
    expect(h.service.keepsProcessAlive()).toBe(true)
    h.handlers.get('click')?.()
    expect(h.showWindow).toHaveBeenCalledOnce()
    h.handlers.get('double-click')?.()
    expect(h.showWindow).toHaveBeenCalledTimes(2)
    h.service.prepareToQuit()
    expect(h.service.keepsProcessAlive()).toBe(false)
  })

  it('forces a Linux hidden window above the stack when revealing it', () => {
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      moveTop: vi.fn(),
      setSkipTaskbar: vi.fn(),
      setAlwaysOnTop: vi.fn(),
    }
    revealBrowserWindow(window, 'linux')
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(false)
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.setAlwaysOnTop.mock.calls.map(call => call[0])).toEqual([true, false])
    expect(window.moveTop).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })
})
