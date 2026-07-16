import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('hermesDesktop', {
  getConnection: profile => ipcRenderer.invoke('hermes:connection', profile),
  revalidateConnection: () => ipcRenderer.invoke('hermes:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('hermes:backend:touch', profile),
  // Student build: hand the metering-proxy device key to main so the agent
  // backend gets pointed at the Nemesis LLM proxy (zero-setup model access).
  nemesisLlmSync: deviceKey => ipcRenderer.invoke('nemesis:llm:sync', { deviceKey }),
  // iOS companion mission dispatcher: hand main the current Supabase access
  // token (or null on sign-out) so it can start/stop polling agent_missions.
  nemesisMissionsSyncSession: accessToken => ipcRenderer.invoke('nemesis:missions:sync-session', { accessToken }),
  // On-device speech engine: accurate transcription in the main process
  // (model auto-downloads once; progress arrives via nemesis:asr:progress).
  nemesisAsrTranscribe: (samples, sampleRate) => ipcRenderer.invoke('nemesis:asr:transcribe', { sampleRate, samples }),
  onNemesisAsrProgress: callback => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('nemesis:asr:progress', listener)

    return () => ipcRenderer.removeListener('nemesis:asr:progress', listener)
  },
  // Silent auto-updater state, so the update banner cooperates instead of
  // telling users to download manually while a download is already running.
  nemesisUpdaterStatus: () => ipcRenderer.invoke('nemesis:updater:status'),
  nemesisUpdaterInstall: () => ipcRenderer.invoke('nemesis:updater:install'),
  getGatewayWsUrl: profile => ipcRenderer.invoke('hermes:gateway:ws-url', profile),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('hermes:window:openSession', sessionId, opts),
  openNewSessionWindow: () => ipcRenderer.invoke('hermes:window:openNewSession'),
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ bounds, screen }`; resolves with the screen bounds it actually used.
    open: request => ipcRenderer.invoke('hermes:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('hermes:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('hermes:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('hermes:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('hermes:pet-overlay:set-focusable', focusable),
    // Main renderer → overlay (forwarded by main): push the latest pet state.
    pushState: payload => ipcRenderer.send('hermes:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer submit.
    control: payload => ipcRenderer.send('hermes:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:state', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:control', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:control', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('hermes:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('hermes:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:test', payload),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:oauth-logout', remoteUrl),
  profile: {
    get: () => ipcRenderer.invoke('hermes:profile:get'),
    set: name => ipcRenderer.invoke('hermes:profile:set', name)
  },
  api: request => ipcRenderer.invoke('hermes:api', request),
  notify: payload => ipcRenderer.invoke('hermes:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('hermes:requestMicrophoneAccess'),
  readFileDataUrl: filePath => ipcRenderer.invoke('hermes:readFileDataUrl', filePath),
  readFileText: filePath => ipcRenderer.invoke('hermes:readFileText', filePath),
  selectPaths: options => ipcRenderer.invoke('hermes:selectPaths', options),
  writeClipboard: text => ipcRenderer.invoke('hermes:writeClipboard', text),
  saveImageFromUrl: url => ipcRenderer.invoke('hermes:saveImageFromUrl', url),
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('hermes:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('hermes:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('hermes:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('hermes:watchPreviewFile', url),
  stopPreviewFileWatch: id => ipcRenderer.invoke('hermes:stopPreviewFileWatch', id),
  setTitleBarTheme: payload => ipcRenderer.send('hermes:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('hermes:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('hermes:translucency', payload),
  setPreviewShortcutActive: active => ipcRenderer.send('hermes:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('hermes:openExternal', url),
  openPreviewInBrowser: url => ipcRenderer.invoke('hermes:openPreviewInBrowser', url),
  fetchLinkTitle: url => ipcRenderer.invoke('hermes:fetchLinkTitle', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('hermes:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('hermes:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:pick')
  },
  zoom: {
    // Current zoom of this window, as { level, percent }.
    get: () => ipcRenderer.invoke('hermes:zoom:get'),
    setPercent: percent => ipcRenderer.send('hermes:zoom:set-percent', percent),
    // Fires on every zoom change, including the Ctrl/Cmd +/-/0 shortcuts,
    // so the settings UI can stay in sync with the keyboard.
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:zoom:changed', listener)

      return () => ipcRenderer.removeListener('hermes:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('hermes:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('hermes:logs:recent'),
  readDir: dirPath => ipcRenderer.invoke('hermes:fs:readDir', dirPath),
  // App-managed agent browser (school-portal mirror in the chat right rail).
  schoolBrowser: {
    ensure: () => ipcRenderer.invoke('hermes:schoolBrowser:ensure'),
    list: () => ipcRenderer.invoke('hermes:schoolBrowser:list'),
    attach: targetId => ipcRenderer.invoke('hermes:schoolBrowser:attach', targetId),
    detach: () => ipcRenderer.invoke('hermes:schoolBrowser:detach'),
    exec: payload => ipcRenderer.invoke('hermes:schoolBrowser:exec', payload),
    onFrame: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:schoolBrowser:frame', listener)

      return () => ipcRenderer.removeListener('hermes:schoolBrowser:frame', listener)
    },
    onEvent: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:schoolBrowser:event', listener)

      return () => ipcRenderer.removeListener('hermes:schoolBrowser:event', listener)
    }
  },
  // Native school browser (WebContentsView tabs over the chat right rail).
  schoolView: {
    getState: () => ipcRenderer.invoke('hermes:schoolView:getState'),
    debugBounds: () => ipcRenderer.invoke('hermes:schoolView:debugBounds'),
    connectionStatus: origins => ipcRenderer.invoke('hermes:schoolView:connectionStatus', origins),
    disconnect: origin => ipcRenderer.invoke('hermes:schoolView:disconnect', origin),
    newTab: url => ipcRenderer.invoke('hermes:schoolView:newTab', url),
    setSession: key => ipcRenderer.invoke('hermes:schoolView:setSession', key),
    closeTab: id => ipcRenderer.invoke('hermes:schoolView:closeTab', id),
    activate: id => ipcRenderer.invoke('hermes:schoolView:activate', id),
    navigate: url => ipcRenderer.invoke('hermes:schoolView:navigate', url),
    history: direction => ipcRenderer.invoke('hermes:schoolView:history', direction),
    reload: () => ipcRenderer.invoke('hermes:schoolView:reload'),
    setBounds: rect => ipcRenderer.invoke('hermes:schoolView:setBounds', rect),
    setVisible: visible => ipcRenderer.invoke('hermes:schoolView:setVisible', visible),
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:schoolView:state', listener)

      return () => ipcRenderer.removeListener('hermes:schoolView:state', listener)
    },
    onDownload: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:schoolView:download', listener)

      return () => ipcRenderer.removeListener('hermes:schoolView:download', listener)
    }
  },
  gitRoot: startPath => ipcRenderer.invoke('hermes:fs:gitRoot', startPath),
  revealPath: targetPath => ipcRenderer.invoke('hermes:fs:reveal', targetPath),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('hermes:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('hermes:fs:writeText', filePath, content),
  writeBinaryFile: (filePath, base64) => ipcRenderer.invoke('hermes:fs:writeBinary', filePath, base64),
  makeDir: dirPath => ipcRenderer.invoke('hermes:fs:mkdir', dirPath),
  trashPath: targetPath => ipcRenderer.invoke('hermes:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('hermes:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('hermes:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('hermes:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('hermes:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('hermes:git:branchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('hermes:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('hermes:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('hermes:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('hermes:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('hermes:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('hermes:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('hermes:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('hermes:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('hermes:git:review:shipInfo', repoPath),
      createPr: repoPath => ipcRenderer.invoke('hermes:git:review:createPr', repoPath)
    }
  },
  terminal: {
    dispose: id => ipcRenderer.invoke('hermes:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('hermes:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('hermes:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('hermes:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `hermes:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `hermes:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:close-preview-requested', listener)

    return () => ipcRenderer.removeListener('hermes:close-preview-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-updates', listener)

    return () => ipcRenderer.removeListener('hermes:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:deep-link', listener)

    return () => ipcRenderer.removeListener('hermes:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('hermes:deep-link-ready'),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:window-state-changed', listener)

    return () => ipcRenderer.removeListener('hermes:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('hermes:focus-session', listener)

    return () => ipcRenderer.removeListener('hermes:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:notification-action', listener)

    return () => ipcRenderer.removeListener('hermes:notification-action', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:preview-file-changed', listener)

    return () => ipcRenderer.removeListener('hermes:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:backend-exit', listener)

    return () => ipcRenderer.removeListener('hermes:backend-exit', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:power-resume', listener)

    return () => ipcRenderer.removeListener('hermes:power-resume', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:boot-progress', listener)

    return () => ipcRenderer.removeListener('hermes:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.ts (apps/desktop/electron/bootstrap-runner.ts).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('hermes:bootstrap:get'),
  resetBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:bootstrap:event', listener)

    return () => ipcRenderer.removeListener('hermes:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('hermes:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('hermes:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('hermes:uninstall:summary'),
    run: mode => ipcRenderer.invoke('hermes:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('hermes:updates:check'),
    apply: opts => ipcRenderer.invoke('hermes:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('hermes:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('hermes:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:updates:progress', listener)

      return () => ipcRenderer.removeListener('hermes:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('hermes:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('hermes:vscode-theme:search', query)
  }
})
