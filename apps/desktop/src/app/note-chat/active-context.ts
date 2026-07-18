import { atom } from 'nanostores'

import type { NoteChatContext } from './context'

// Bridges the active Library note / Study card (owned by those page components)
// to the note-chat Pane, which is mounted at the app-shell level — panes must be
// direct children of PaneShell, so the pane can't live inside the page. The page
// publishes its current context here; the pane reads it. Null when no note/card
// is in focus (or off the Library/Study routes), which also keeps the pane's
// disabled gate trivial.
export const $noteChatContext = atom<NoteChatContext | null>(null)

export function setNoteChatContext(context: NoteChatContext | null): void {
  $noteChatContext.set(context)
}

// Pane id for the docked mini-chat panel (Library / Study), registered in the
// app-wide PaneShell. Shared so the pages can open it via setPaneOpen.
export const NOTE_CHAT_PANE_ID = 'note-chat'
