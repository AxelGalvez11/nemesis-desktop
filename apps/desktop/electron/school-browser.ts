// App-managed agent browser ("school browser"): a persistent Chromium the agent
// drives over CDP (config.yaml browser.cdp_url → http://127.0.0.1:9333) and the
// renderer mirrors live in the chat right rail. All CDP traffic (target list,
// screencast frames, forwarded input) relays through THIS module over IPC — the
// renderer cannot talk to the CDP endpoints itself (no CORS on /json/*), and the
// main process keeps exactly one mirrored target per renderer window.
//
// The profile dir persists cookies (Blackboard/Outlook logins) across restarts;
// the student types credentials INTO THE MIRROR (forwarded as trusted CDP input)
// or into the real window — never into the chat.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ipcMain } from 'electron'

const PORT = 9333
const ORIGIN = `http://127.0.0.1:${PORT}`
const PROFILE_DIR = path.join(os.homedir(), '.hermes', 'browser_auth', 'school-profile')
const START_URL = 'https://www.google.com'
const HTTP_TIMEOUT_MS = 2_500
const SPAWN_WAIT_MS = 12_000
// Headless Chromium blocks file downloads by default — a click on a Blackboard
// slide/PDF or an Outlook attachment would silently no-op. We set download
// behavior at BROWSER scope (applies to the agent's own CDP session too, not
// just the mirror) so captured files land here; the school-portal skill moves
// them into Library/School/<Course>.
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads')

// Only these CDP methods may be forwarded from the renderer — the mirror needs
// input + navigation + viewport-matching, nothing else (no Runtime.evaluate
// from the renderer).
const ALLOWED_FORWARD_METHODS = new Set([
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setDeviceMetricsOverride',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.navigate',
  'Page.reload'
])

function httpJson(url: string, init?: { method?: string }) {
  return fetch(url, {
    method: init?.method ?? 'GET',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  }).then(async res => {
    const text = await res.text()

    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })
}

/** Playwright's Chrome-for-Testing build — the same binary the agent's own
 *  headless launcher uses, so one install serves both. */
function findChromeBinary(): null | string {
  if (process.platform !== 'darwin') {
    return null
  }

  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')

  try {
    const builds = fs
      .readdirSync(cache)
      .filter(name => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()

    for (const build of builds) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac']) {
        const bin = path.join(
          cache,
          build,
          arch,
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing'
        )

        if (fs.existsSync(bin)) {
          return bin
        }
      }
    }
  } catch {
    // No playwright cache — reported as not-installed below.
  }

  return null
}

async function isRunning(): Promise<boolean> {
  try {
    const version = await httpJson(`${ORIGIN}/json/version`)

    return Boolean(version && typeof version === 'object' && 'webSocketDebuggerUrl' in version)
  } catch {
    return false
  }
}

// One long-lived browser-scope CDP connection whose only job is to keep
// download-to-disk enabled. Held open because the behavior can reset when the
// setting client disconnects; re-armed by ensureBrowser().
let downloadWs: WebSocket | null = null

async function enableDownloads(): Promise<void> {
  if (downloadWs && downloadWs.readyState === WebSocket.OPEN) {
    return
  }

  let version: unknown

  try {
    version = await httpJson(`${ORIGIN}/json/version`)
  } catch {
    return
  }

  const wsUrl =
    version && typeof version === 'object' ? (version as Record<string, unknown>).webSocketDebuggerUrl : null

  if (typeof wsUrl !== 'string') {
    return
  }

  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
  } catch {
    // Downloads dir almost always exists; ignore.
  }

  const ws = new WebSocket(wsUrl)

  const opened = await new Promise<boolean>(resolve => {
    ws.onopen = () => resolve(true)
    ws.onerror = () => resolve(false)
    setTimeout(() => resolve(false), HTTP_TIMEOUT_MS)
  })

  if (!opened) {
    return
  }

  downloadWs = ws
  ws.onclose = () => {
    if (downloadWs === ws) {
      downloadWs = null
    }
  }
  // 'allow' keeps the site's suggested filename (the skill's move step needs a
  // human name, not a GUID). Browser scope → covers the agent's download clicks.
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: DOWNLOAD_DIR, eventsEnabled: true }
    })
  )
}

async function ensureBrowser(): Promise<{ ok: boolean; reason?: string }> {
  if (await isRunning()) {
    await enableDownloads()

    return { ok: true }
  }

  const bin = findChromeBinary()

  if (!bin) {
    return { ok: false, reason: 'no-binary' }
  }

  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true })
    const child = spawn(
      bin,
      [
        // Headless on purpose: the chat rail mirror IS the browser's only
        // window — no duplicate Chrome floating on the desktop, and screencast
        // frames match the emulated viewport exactly (no window-shaped
        // letterboxing). Cookies persist in the profile either way; if a login
        // page ever refuses headless, the runbook has a one-off headed command
        // against this same profile.
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1000,1400',
        START_URL
      ],
      { detached: true, stdio: 'ignore' }
    )
    child.unref()
  } catch {
    return { ok: false, reason: 'spawn-failed' }
  }

  const deadline = Date.now() + SPAWN_WAIT_MS

  while (Date.now() < deadline) {
    if (await isRunning()) {
      await enableDownloads()

      return { ok: true }
    }

    await new Promise(resolve => setTimeout(resolve, 400))
  }

  return { ok: false, reason: 'timeout' }
}

async function listTabs() {
  try {
    const targets = await httpJson(`${ORIGIN}/json/list`)

    if (!Array.isArray(targets)) {
      return { running: false, tabs: [] }
    }

    const tabs = targets
      .filter(t => t?.type === 'page' && typeof t.id === 'string' && !String(t.url ?? '').startsWith('devtools://'))
      .map(t => ({ id: t.id as string, title: String(t.title ?? ''), url: String(t.url ?? '') }))

    return { running: true, tabs }
  } catch {
    return { running: false, tabs: [] }
  }
}

interface MirrorSession {
  ws: WebSocket
  targetId: string
  nextId: number
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
}

// One mirrored target per renderer window (keyed by webContents id).
const sessions = new Map<number, MirrorSession>()

function closeSession(senderId: number) {
  const session = sessions.get(senderId)

  if (!session) {
    return
  }

  sessions.delete(senderId)

  try {
    session.ws.close()
  } catch {
    // Already closed.
  }

  for (const waiter of session.pending.values()) {
    waiter.reject(new Error('mirror detached'))
  }

  session.pending.clear()
}

function sessionCommand(session: MirrorSession, method: string, params?: Record<string, unknown>) {
  return new Promise((resolve, reject) => {
    const id = ++session.nextId
    session.pending.set(id, { reject, resolve })

    try {
      session.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    } catch (error) {
      session.pending.delete(id)
      reject(error instanceof Error ? error : new Error('send failed'))
    }
  })
}

async function attachMirror(sender: Electron.WebContents, targetId: string): Promise<boolean> {
  closeSession(sender.id)

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/${targetId}`)
  const session: MirrorSession = { nextId: 0, pending: new Map(), targetId, ws }

  const opened = await new Promise<boolean>(resolve => {
    ws.onopen = () => resolve(true)
    ws.onerror = () => resolve(false)
    setTimeout(() => resolve(false), HTTP_TIMEOUT_MS)
  })

  if (!opened) {
    return false
  }

  sessions.set(sender.id, session)

  ws.onmessage = event => {
    let message: {
      id?: number
      error?: { message?: string }
      result?: unknown
      method?: string
      params?: Record<string, unknown>
    }

    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }

    if (message.id && session.pending.has(message.id)) {
      const waiter = session.pending.get(message.id)!
      session.pending.delete(message.id)
      message.error ? waiter.reject(new Error(message.error.message ?? 'cdp error')) : waiter.resolve(message.result)

      return
    }

    if (message.method === 'Page.screencastFrame') {
      const params = message.params ?? {}
      // Ack immediately or the stream stalls after a few frames.
      void sessionCommand(session, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined)

      if (!sender.isDestroyed()) {
        sender.send('hermes:schoolBrowser:frame', {
          data: params.data,
          metadata: params.metadata,
          targetId
        })
      }

      return
    }

    if (message.method === 'Page.frameNavigated') {
      const frame = (message.params?.frame ?? {}) as { parentId?: string; url?: string }

      if (!frame.parentId && !sender.isDestroyed()) {
        sender.send('hermes:schoolBrowser:event', { targetId, type: 'url-changed', url: frame.url ?? '' })
      }
    }
  }

  ws.onclose = () => {
    if (sessions.get(sender.id) === session) {
      sessions.delete(sender.id)

      if (!sender.isDestroyed()) {
        sender.send('hermes:schoolBrowser:event', { targetId, type: 'detached' })
      }
    }
  }

  sender.once('destroyed', () => closeSession(sender.id))

  await sessionCommand(session, 'Page.enable').catch(() => undefined)
  await sessionCommand(session, 'Page.startScreencast', {
    // PNG (lossless) keeps text crisp — JPEG softens small type; with the browser
    // forced to 2x density the frames arrive at retina resolution. Generous
    // max dims so the 2x panel-shaped viewport is never downscaled.
    format: 'png',
    maxHeight: 3600,
    maxWidth: 3000
  }).catch(() => undefined)

  return true
}

interface ForwardPayload {
  method?: string
  params?: Record<string, unknown>
}

async function execCommand(sender: Electron.WebContents, payload: ForwardPayload | Record<string, unknown>) {
  const kind = String((payload as Record<string, unknown>).kind ?? 'cdp')

  // Tab management rides the HTTP endpoints (works without an attached mirror).
  if (kind === 'tab-new') {
    const url = String((payload as Record<string, unknown>).url ?? START_URL)

    return httpJson(`${ORIGIN}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  }

  if (kind === 'tab-close') {
    return httpJson(`${ORIGIN}/json/close/${String((payload as Record<string, unknown>).targetId ?? '')}`)
  }

  if (kind === 'tab-activate') {
    return httpJson(`${ORIGIN}/json/activate/${String((payload as Record<string, unknown>).targetId ?? '')}`)
  }

  if (kind === 'history') {
    const session = sessions.get(sender.id)

    if (!session) {
      return null
    }

    const direction = String((payload as Record<string, unknown>).direction ?? 'back')
    const history = (await sessionCommand(session, 'Page.getNavigationHistory')) as {
      currentIndex: number
      entries: { id: number }[]
    }
    const nextIndex = history.currentIndex + (direction === 'forward' ? 1 : -1)
    const entry = history.entries[nextIndex]

    if (entry) {
      await sessionCommand(session, 'Page.navigateToHistoryEntry', { entryId: entry.id })
    }

    return null
  }

  // Plain CDP forward (input + navigation), allowlisted.
  const { method, params } = payload as ForwardPayload

  if (!method || !ALLOWED_FORWARD_METHODS.has(method)) {
    throw new Error(`method not allowed: ${String(method)}`)
  }

  const session = sessions.get(sender.id)

  if (!session) {
    return null
  }

  return sessionCommand(session, method, params)
}

export function registerSchoolBrowserIpc() {
  ipcMain.handle('hermes:schoolBrowser:ensure', () => ensureBrowser())
  ipcMain.handle('hermes:schoolBrowser:list', () => listTabs())
  ipcMain.handle('hermes:schoolBrowser:attach', (event, targetId) => attachMirror(event.sender, String(targetId)))
  ipcMain.handle('hermes:schoolBrowser:detach', event => {
    closeSession(event.sender.id)

    return true
  })
  ipcMain.handle('hermes:schoolBrowser:exec', (event, payload) => execCommand(event.sender, payload ?? {}))
}
