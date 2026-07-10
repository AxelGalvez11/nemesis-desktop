// The agent-browser mirror tab in the chat right rail ("watch the agent work").
// Open/visible state only — the mirror itself (screencast, tabs, input) lives in
// BrowserMirror + the school-browser IPC. Close handling that must coordinate
// with the preview/file tabs lives in store/preview.ts (avoids an import cycle).
import { atom } from 'nanostores'

import { PREVIEW_PANE_ID, RIGHT_RAIL_BROWSER_TAB_ID, selectRightRailTab } from './layout'
import { setPaneOpen } from './panes'

export const $browserRailOpen = atom(false)

/** Show the agent-browser tab in the right rail and focus it. */
export function openBrowserRail() {
  $browserRailOpen.set(true)
  setPaneOpen(PREVIEW_PANE_ID, true)
  selectRightRailTab(RIGHT_RAIL_BROWSER_TAB_ID)
}
