// Native school browser: the agent's browser rendered as real Electron
// WebContentsViews layered over the chat right rail — no screencast, no
// pixel streaming, native input. This replaces the headless-Chrome mirror
// (school-browser.ts, kept as a config fallback) as the default on the
// student build.
//
// How the agent drives it: the app itself opens Chromium's remote-debugging
// port (same 9333 the headless Chrome used, so ~/.hermes/config.yaml's
// browser.cdp_url keeps working). Every WebContentsView here is an ordinary
// CDP page target. Two Electron quirks shape the Python side (browser_tool.py):
//   - Target.createTarget is "Not supported" → new tabs are created by
//     evaluating window.open() in an existing school tab; each view's
//     setWindowOpenHandler below turns that into a first-class tab.
//   - The app window itself is also a CDP target (file:// URL) → the tool
//     steers away from file:// targets, and wireCommonWindowHandlers()
//     restores the app shell if anything ever navigates it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app, BrowserWindow, ipcMain, session, WebContentsView } from 'electron'

const PORT = 9333
const PARTITION = 'persist:school'
const START_URL = 'https://www.google.com'
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads')
// Legacy headless-Chrome profile dir — only used to kill a stale instance
// that would otherwise still own port 9333 when native mode boots.
const LEGACY_PROFILE_MARKER = 'browser_auth/school-profile'

type SchoolViewMode = 'mirror' | 'native'

interface TabState {
  id: number
  view: WebContentsView
  url: string
  title: string
}

interface PanelRect {
  x: number
  y: number
  width: number
  height: number
}

/** Mode is decided before app-ready (the debug port switch must be set then),
 *  so it reads a tiny sync config: userData/school-browser.json. Missing file
 *  or missing key = native (the student-build default); {"mode":"mirror"}
 *  flips back to the headless-Chrome screencast path wholesale. */
function readMode(): SchoolViewMode {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'school-browser.json'), 'utf8')
    const parsed = JSON.parse(raw) as { mode?: unknown }

    if (parsed.mode === 'mirror') {
      return 'mirror'
    }
  } catch {
    // No config → default.
  }

  return 'native'
}

export const SCHOOL_VIEW_MODE: SchoolViewMode = readMode()

// Pre-ready side effects: free the port, then claim it. Both are inert in
// mirror mode. pkill -f matches the legacy Chrome's --user-data-dir argument;
// nothing else on the machine carries that path in its argv.
if (SCHOOL_VIEW_MODE === 'native') {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      spawnSync('pkill', ['-f', LEGACY_PROFILE_MARKER], { timeout: 3_000 })
    } catch {
      // Best effort — if the legacy browser isn't running, nothing to do.
    }
  }

  app.commandLine.appendSwitch('remote-debugging-port', String(PORT))
}

const tabs = new Map<number, TabState>()
const tabOrder: number[] = []
let activeTabId: null | number = null
let hostWindow: BrowserWindow | null = null
let panelRect: PanelRect | null = null
let panelVisible = false
let sessionPrepared = false

function schoolSession() {
  return session.fromPartition(PARTITION)
}

/** One-time session prep: a normal-Chrome UA (Blackboard/Microsoft login
 *  flows sometimes refuse UAs carrying an Electron token) and downloads that
 *  land in ~/Downloads under the site's suggested filename — same contract
 *  the school-portal skill relies on with the headless browser. */
function prepareSession() {
  if (sessionPrepared) {
    return
  }

  sessionPrepared = true
  const ses = schoolSession()
  const cleanUa = ses
    .getUserAgent()
    .replace(/\sHermes\/[\d.]+/i, '')
    .replace(/\sNemesis\/[\d.]+/i, '')
    .replace(/\sElectron\/[\d.]+/i, '')
  ses.setUserAgent(cleanUa)

  ses.on('will-download', (_event, item) => {
    try {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
    } catch {
      // Almost always exists.
    }

    const suggested = item.getFilename() || 'download'
    const parsed = path.parse(suggested)
    let candidate = path.join(DOWNLOAD_DIR, suggested)
    let counter = 1

    while (fs.existsSync(candidate)) {
      candidate = path.join(DOWNLOAD_DIR, `${parsed.name} (${counter})${parsed.ext}`)
      counter += 1
    }

    item.setSavePath(candidate)
    item.once('done', (_doneEvent, state) => {
      broadcast('hermes:schoolView:download', {
        filename: path.basename(candidate),
        path: candidate,
        state
      })
    })
  })
}

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

function serializeState() {
  return {
    activeId: activeTabId,
    mode: SCHOOL_VIEW_MODE,
    tabs: tabOrder
      .map(id => tabs.get(id))
      .filter((tab): tab is TabState => Boolean(tab))
      .map(tab => ({ id: tab.id, title: tab.title, url: tab.url })),
    visible: panelVisible
  }
}

function pushState() {
  broadcast('hermes:schoolView:state', serializeState())
}

function applyLayout() {
  if (!hostWindow || hostWindow.isDestroyed()) {
    return
  }

  for (const tab of tabs.values()) {
    const isActive = tab.id === activeTabId
    const show = panelVisible && isActive && Boolean(panelRect)
    tab.view.setVisible(show)

    if (show && panelRect) {
      // panelRect is already in DIP — the renderer did the CSS→DIP conversion
      // with the live zoom factor (see native-browser-panel.tsx). Apply it
      // verbatim; no scaling here, so main can never fight the renderer over
      // the factor.
      tab.view.setBounds({
        height: Math.max(0, Math.round(panelRect.height)),
        width: Math.max(0, Math.round(panelRect.width)),
        x: Math.round(panelRect.x),
        y: Math.round(panelRect.y)
      })
    }
  }
}

function normalizeUrl(raw: string): null | string {
  const value = (raw || '').trim()

  if (!value) {
    return null
  }

  if (/^about:blank$/i.test(value)) {
    return 'about:blank'
  }

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  // Bare "blackboard.uthsc.edu" style input from the URL bar.
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(value)) {
    return `https://${value}`
  }

  return null
}

function createTab(rawUrl?: string): null | TabState {
  if (!hostWindow || hostWindow.isDestroyed()) {
    return null
  }

  prepareSession()

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
      sandbox: true
    }
  })

  const id = view.webContents.id
  const tab: TabState = { id, title: '', url: '', view }
  tabs.set(id, tab)
  tabOrder.push(id)

  // window.open from any school page becomes a sibling tab. This doubles as
  // the agent's only tab-creation path (Target.createTarget is unsupported
  // in Electron), so it must stay allow-by-default for http(s).
  view.webContents.setWindowOpenHandler(details => {
    const target = normalizeUrl(details.url) ?? 'about:blank'
    const created = createTab(target)

    if (created) {
      activeTabId = created.id
      applyLayout()
      pushState()
    }

    return { action: 'deny' }
  })

  view.webContents.on('page-title-updated', (_event, title) => {
    tab.title = title
    pushState()
  })

  const refreshUrl = () => {
    tab.url = tab.view.webContents.getURL()
    pushState()
  }
  view.webContents.on('did-navigate', refreshUrl)
  view.webContents.on('did-navigate-in-page', refreshUrl)

  view.webContents.on('render-process-gone', () => {
    closeTab(id)
  })

  hostWindow.contentView.addChildView(view)
  view.setVisible(false)

  const initial = normalizeUrl(rawUrl ?? '') ?? START_URL
  tab.url = initial
  void view.webContents.loadURL(initial).catch(() => undefined)

  return tab
}

function closeTab(id: number) {
  const tab = tabs.get(id)

  if (!tab) {
    return
  }

  tabs.delete(id)
  const orderIndex = tabOrder.indexOf(id)

  if (orderIndex >= 0) {
    tabOrder.splice(orderIndex, 1)
  }

  if (hostWindow && !hostWindow.isDestroyed()) {
    try {
      hostWindow.contentView.removeChildView(tab.view)
    } catch {
      // Window teardown races are fine.
    }
  }

  try {
    tab.view.webContents.close()
  } catch {
    // Already gone.
  }

  if (activeTabId === id) {
    activeTabId = tabOrder[Math.min(orderIndex, tabOrder.length - 1)] ?? null
  }

  // Min-one-tab invariant: the panel always has something to show and the
  // agent always has a school tab to window.open() from — never the app
  // shell's file:// target.
  if (tabOrder.length === 0) {
    const fresh = createTab(START_URL)
    activeTabId = fresh?.id ?? null
  }

  applyLayout()
  pushState()
}

function activeTab(): null | TabState {
  return (activeTabId != null && tabs.get(activeTabId)) || null
}

/** Called from createWindow() once the main window exists. Native mode boots
 *  with one home tab so the agent's CDP endpoint always exposes at least one
 *  non-file:// page target from the first moment it can connect. */
export function installSchoolView(win: BrowserWindow) {
  if (SCHOOL_VIEW_MODE !== 'native') {
    return
  }

  hostWindow = win
  win.on('resize', () => applyLayout())
  win.on('closed', () => {
    hostWindow = null
    tabs.clear()
    tabOrder.length = 0
    activeTabId = null
  })

  // The home tab must NOT attach before the window's first paint: the main
  // window is created with show:false and revealed on ready-to-show, and
  // adding a WebContentsView to the still-hidden window wedges first-frame
  // compositing (window never paints, rAF never fires). Deferring to 'show'
  // sidesteps that and costs nothing — the agent/panel can't need a tab
  // before the window exists on screen.
  const createHomeTab = () => {
    if (tabOrder.length === 0 && hostWindow && !hostWindow.isDestroyed()) {
      const tab = createTab(START_URL)
      activeTabId = tab?.id ?? null
      pushState()
    }
  }

  if (win.isVisible()) {
    createHomeTab()
  } else {
    win.once('show', () => createHomeTab())
  }
}

export function registerSchoolViewIpc() {
  ipcMain.handle('hermes:schoolView:getState', () => serializeState())

  // Diagnostics: the active view's real DIP bounds + the host content size, so
  // a harness can confirm the page sits inside the rail (no cross-process
  // scaling drift) without needing an OS-level composite screenshot.
  ipcMain.handle('hermes:schoolView:debugBounds', () => {
    const tab = activeTab()
    const content = hostWindow && !hostWindow.isDestroyed() ? hostWindow.getContentBounds() : null

    return {
      content: content ? { height: content.height, width: content.width } : null,
      panelRect,
      view: tab ? tab.view.getBounds() : null,
      visible: panelVisible
    }
  })

  ipcMain.handle('hermes:schoolView:newTab', (_event, rawUrl) => {
    const tab = createTab(typeof rawUrl === 'string' ? rawUrl : undefined)

    if (tab) {
      activeTabId = tab.id
      applyLayout()
      pushState()
    }

    return serializeState()
  })

  ipcMain.handle('hermes:schoolView:closeTab', (_event, id) => {
    closeTab(Number(id))

    return serializeState()
  })

  ipcMain.handle('hermes:schoolView:activate', (_event, id) => {
    if (tabs.has(Number(id))) {
      activeTabId = Number(id)
      applyLayout()
      pushState()
    }

    return serializeState()
  })

  ipcMain.handle('hermes:schoolView:navigate', (_event, rawUrl) => {
    const tab = activeTab()
    const url = normalizeUrl(String(rawUrl ?? ''))

    if (tab && url) {
      void tab.view.webContents.loadURL(url).catch(() => undefined)
    }

    return serializeState()
  })

  ipcMain.handle('hermes:schoolView:history', (_event, direction) => {
    const tab = activeTab()

    if (tab) {
      const nav = tab.view.webContents.navigationHistory

      if (direction === 'forward' && nav.canGoForward()) {
        nav.goForward()
      } else if (direction !== 'forward' && nav.canGoBack()) {
        nav.goBack()
      }
    }

    return serializeState()
  })

  ipcMain.handle('hermes:schoolView:reload', () => {
    activeTab()?.view.webContents.reload()

    return serializeState()
  })

  ipcMain.handle('hermes:schoolView:setBounds', (event, rect) => {
    // Geometry only means anything in the HOST window's coordinate space — a
    // secondary session window's panel must not steer views it doesn't host.
    if (!hostWindow || event.sender !== hostWindow.webContents) {
      return false
    }

    const parsed = rect as Partial<PanelRect> | null

    if (
      parsed &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y) &&
      Number.isFinite(parsed.width) &&
      Number.isFinite(parsed.height)
    ) {
      panelRect = {
        height: Number(parsed.height),
        width: Number(parsed.width),
        x: Number(parsed.x),
        y: Number(parsed.y)
      }
      applyLayout()
    }

    return true
  })

  ipcMain.handle('hermes:schoolView:setVisible', (event, visible) => {
    if (!hostWindow || event.sender !== hostWindow.webContents) {
      return false
    }

    panelVisible = Boolean(visible)
    applyLayout()
    pushState()

    return true
  })
}
