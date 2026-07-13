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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app, BrowserWindow, ipcMain, session, WebContentsView } from 'electron'

const PORT = 9444
const PARTITION = 'persist:school'
const START_URL = 'https://www.google.com'
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads')

type SchoolViewMode = 'mirror' | 'native'

interface TabState {
  id: number
  view: WebContentsView
  url: string
  title: string
  // Chat session this tab belongs to. Tabs are per-conversation: switching
  // chats switches the visible tab set. 'global' = created before any chat
  // claimed the browser (startup home tab); adopted by the first session.
  sessionKey: string
}

// The placeholder rect the renderer measured, in CSS px, plus the CSS viewport
// (window.innerWidth/Height) it was measured in. Main converts CSS→DIP itself at
// apply time using getContentBounds()/viewport — the EMPIRICAL device scale — so
// it never depends on a zoom percent that can disagree with the real device scale
// (that mismatch is what parked the native view out over the chat).
interface PanelRect {
  x: number
  y: number
  width: number
  height: number
  vw: number
  vh: number
}

/** Mode is decided before app-ready (the debug port switch must be set then),
 *  so it reads a tiny sync config: userData/school-browser.json. Missing file
 *  or missing key = native (the student-build default); {"mode":"mirror"}
 *  flips back to the headless-Chrome screencast path wholesale. */
function readMode(): SchoolViewMode {
  // Never expose the packaged app renderer through Chromium's unauthenticated
  // remote-debugging port. Production uses the separate app-managed browser
  // process in school-browser.ts, which keeps account tokens out of CDP.
  if (app.isPackaged || process.env.HERMES_DESKTOP_IS_PACKAGED) {
    return 'mirror'
  }

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

// Pre-ready side effect for development-only native mode. Packaged builds stay
// in mirror mode and never expose the Electron renderer over CDP.
if (SCHOOL_VIEW_MODE === 'native') {
  app.commandLine.appendSwitch('remote-debugging-port', String(PORT))
}

const tabs = new Map<number, TabState>()
const tabOrder: number[] = []
let activeTabId: null | number = null
let activeSessionKey = 'global'
// Remembered active tab per session, so switching back to a chat restores the
// tab that chat was looking at.
const activeTabBySession = new Map<string, number>()

function sessionTabIds(sessionKey = activeSessionKey): number[] {
  return tabOrder.filter(id => tabs.get(id)?.sessionKey === sessionKey)
}
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
    sessionKey: activeSessionKey,
    tabs: sessionTabIds()
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

  const win = hostWindow

  for (const tab of tabs.values()) {
    const isActive = tab.id === activeTabId && tab.sessionKey === activeSessionKey
    const show = panelVisible && isActive && Boolean(panelRect)
    tab.view.setVisible(show)

    if (show && panelRect) {
      // panelRect is CSS px measured in a viewport of (vw × vh). Convert to the
      // window's DIP space using its OWN current content bounds — the exact
      // CSS→DIP ratio, whatever the zoom/display scale — so the view lands
      // precisely over the placeholder instead of spilling onto the chat.
      const content = win.getContentBounds()
      const sx = panelRect.vw > 0 ? content.width / panelRect.vw : 1
      const sy = panelRect.vh > 0 ? content.height / panelRect.vh : 1

      tab.view.setBounds({
        height: Math.max(0, Math.round(panelRect.height * sy)),
        width: Math.max(0, Math.round(panelRect.width * sx)),
        x: Math.round(panelRect.x * sx),
        y: Math.round(panelRect.y * sy)
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

function createTab(rawUrl?: string, sessionKey = activeSessionKey): null | TabState {
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
  const tab: TabState = { id, sessionKey, title: '', url: '', view }
  tabs.set(id, tab)
  tabOrder.push(id)

  // window.open from any school page becomes a sibling tab. This doubles as
  // the agent's only tab-creation path (Target.createTarget is unsupported
  // in Electron), so it must stay allow-by-default for http(s). The child
  // inherits the opener's session so a background chat's agent can't push
  // tabs into whichever conversation the student happens to be viewing.
  view.webContents.setWindowOpenHandler(details => {
    const target = normalizeUrl(details.url) ?? 'about:blank'
    const created = createTab(target, tab.sessionKey)

    if (created) {
      activeTabBySession.set(created.sessionKey, created.id)

      if (created.sessionKey === activeSessionKey) {
        activeTabId = created.id
        applyLayout()
        pushState()
      }
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

  const remaining = sessionTabIds(tab.sessionKey)

  if (activeTabBySession.get(tab.sessionKey) === id) {
    const fallback = remaining[Math.min(orderIndex, remaining.length - 1)] ?? remaining.at(-1)

    if (fallback != null) {
      activeTabBySession.set(tab.sessionKey, fallback)
    } else {
      activeTabBySession.delete(tab.sessionKey)
    }
  }

  if (activeTabId === id) {
    activeTabId = activeTabBySession.get(tab.sessionKey) ?? null
  }

  // Min-one-tab invariant, per session: the CURRENT session's panel always has
  // something to show and the agent always has a school tab to window.open()
  // from — never the app shell's file:// target. Other sessions may go empty.
  if (tab.sessionKey === activeSessionKey && remaining.length === 0) {
    const fresh = createTab(START_URL, tab.sessionKey)
    activeTabId = fresh?.id ?? null

    if (fresh) {
      activeTabBySession.set(tab.sessionKey, fresh.id)
    }
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

      if (tab) {
        activeTabBySession.set(tab.sessionKey, tab.id)
      }

      pushState()
    }
  }

  if (win.isVisible()) {
    createHomeTab()
  } else {
    win.once('show', () => createHomeTab())
  }
}

/** "Connected" = the school session holds at least one cookie for the portal's
 *  registrable-ish domain. A logged-in Blackboard/Outlook/Gmail session always
 *  leaves session cookies; an empty jar means the student never signed in (or
 *  signed out). Best-effort — any lookup error reports not-connected rather
 *  than throwing, so the Connections UI degrades to "Connect". */
async function connectionStatus(origins: string[]): Promise<Record<string, boolean>> {
  const ses = schoolSession()
  const out: Record<string, boolean> = {}

  await Promise.all(
    origins.map(async origin => {
      let host = origin

      try {
        host = new URL(origin).hostname
      } catch {
        // Treat a bare host string as-is.
      }

      // Match cookies on the base domain (last two labels) so a login on
      // login.microsoftonline.com counts for outlook.cloud.microsoft, etc.
      const parts = host.split('.')
      const base = parts.length > 2 ? parts.slice(-2).join('.') : host

      try {
        const cookies = await ses.cookies.get({ domain: base })
        out[origin] = cookies.length > 0
      } catch {
        out[origin] = false
      }
    })
  )

  return out
}

/** Sign out of a portal: drop every cookie whose domain matches it. */
async function disconnectOrigin(origin: string): Promise<void> {
  const ses = schoolSession()
  let host = origin

  try {
    host = new URL(origin).hostname
  } catch {
    // bare host
  }

  const parts = host.split('.')
  const base = parts.length > 2 ? parts.slice(-2).join('.') : host

  try {
    const cookies = await ses.cookies.get({ domain: base })

    await Promise.all(
      cookies.map(cookie => {
        const scheme = cookie.secure ? 'https' : 'http'
        const cookieHost = cookie.domain?.replace(/^\./, '') ?? base

        return ses.cookies.remove(`${scheme}://${cookieHost}${cookie.path ?? '/'}`, cookie.name).catch(() => undefined)
      })
    )
    await ses.cookies.flushStore()
  } catch {
    // best-effort sign-out
  }
}

export function registerSchoolViewIpc() {
  ipcMain.handle('hermes:schoolView:getState', () => serializeState())

  ipcMain.handle('hermes:schoolView:connectionStatus', (_event, origins) =>
    connectionStatus(Array.isArray(origins) ? origins.map(String) : [])
  )

  ipcMain.handle('hermes:schoolView:disconnect', async (_event, origin) => {
    await disconnectOrigin(String(origin ?? ''))

    return true
  })

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
      activeTabBySession.set(tab.sessionKey, tab.id)
      applyLayout()
      pushState()
    }

    return serializeState()
  })

  // Chat switch: the renderer tells us which conversation owns the browser
  // rail now. Tabs created before any chat claimed the browser ('global',
  // e.g. the startup home tab) are adopted by the first real session.
  ipcMain.handle('hermes:schoolView:setSession', (_event, rawKey) => {
    const key = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : 'global'

    if (key !== 'global') {
      for (const tab of tabs.values()) {
        if (tab.sessionKey === 'global') {
          tab.sessionKey = key
        }
      }

      const adoptedActive = activeTabBySession.get('global')

      if (adoptedActive != null) {
        activeTabBySession.delete('global')
        activeTabBySession.set(key, adoptedActive)
      }
    }

    activeSessionKey = key
    activeTabId = activeTabBySession.get(key) ?? sessionTabIds(key)[0] ?? null

    // The session the student is looking at keeps the min-one-tab invariant.
    if (activeTabId == null && panelVisible) {
      const fresh = createTab(START_URL, key)
      activeTabId = fresh?.id ?? null

      if (fresh) {
        activeTabBySession.set(key, fresh.id)
      }
    }

    applyLayout()
    pushState()

    return serializeState()
  })

  ipcMain.handle('hermes:schoolView:closeTab', (_event, id) => {
    closeTab(Number(id))

    return serializeState()
  })

  ipcMain.handle('hermes:schoolView:activate', (_event, id) => {
    const tab = tabs.get(Number(id))

    if (tab && tab.sessionKey === activeSessionKey) {
      activeTabId = tab.id
      activeTabBySession.set(tab.sessionKey, tab.id)
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
      // vw/vh absent (older renderer) → fall back to the window's own content
      // width/height so the scale is 1:1 and the rect is treated as DIP.
      const fallback = hostWindow.getContentBounds()

      panelRect = {
        height: Number(parsed.height),
        vh: Number.isFinite(parsed.vh) && Number(parsed.vh) > 0 ? Number(parsed.vh) : fallback.height,
        vw: Number.isFinite(parsed.vw) && Number(parsed.vw) > 0 ? Number(parsed.vw) : fallback.width,
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

    // Becoming visible in a session with no tabs (a chat that never browsed):
    // apply the min-one-tab invariant lazily, right when the rail opens.
    if (panelVisible && sessionTabIds().length === 0) {
      const fresh = createTab(START_URL)
      activeTabId = fresh?.id ?? null

      if (fresh) {
        activeTabBySession.set(fresh.sessionKey, fresh.id)
      }
    }

    applyLayout()
    pushState()

    return true
  })
}
