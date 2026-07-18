import { atom } from 'nanostores';
// Bridges the active Library note / Study card (owned by those page components)
// to the note-chat Pane, which is mounted at the app-shell level — panes must be
// direct children of PaneShell, so the pane can't live inside the page. The page
// publishes its current context here; the pane reads it. Null when no note/card
// is in focus (or off the Library/Study routes), which also keeps the pane's
// disabled gate trivial.
export const $noteChatContext = atom(null);
export function setNoteChatContext(context) {
    $noteChatContext.set(context);
}
