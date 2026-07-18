import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { cn } from '@/lib/utils'
import { getNoteChatStore } from '@/store/note-chat'

import type { NoteChatContext } from './context'
import { buildQuickActionPrompt, QUICK_ACTIONS } from './quick-actions'

/**
 * The compact per-note/per-card chat panel. Binds to the scoped mini-chat store
 * (its own conversation, walled off from the main chat) via useSyncExternalStore,
 * keyed by the context's scope key so switching note/card switches the thread.
 * Used both docked in a Pane (Library / Study browse) and as a slide-in overlay
 * during flashcard review — `onClose` drives the overlay's dismiss control.
 */
export function NoteChatPanel({ context, onClose }: { context: NoteChatContext; onClose?: () => void }) {
  const store = getNoteChatStore()
  const scopeKey = context.scopeKey
  const subscribe = useCallback((cb: () => void) => store.subscribeScope(scopeKey, cb), [store, scopeKey])
  const snapshot = useSyncExternalStore(subscribe, () => store.getScopeSnapshot(scopeKey))
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const surfaceWord = context.kind === 'note' ? 'note' : 'card'
  const hasMessages = snapshot.messages.length > 0

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || snapshot.busy) return
      void store.sendTurn(scopeKey, trimmed)
      setDraft('')
    },
    [scopeKey, snapshot.busy, store]
  )

  // Keep the newest message in view as the reply streams in.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [snapshot.messages])

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{context.title}</div>
          <div className="truncate text-xs text-muted-foreground">About this {surfaceWord}</div>
        </div>
        {onClose && (
          <button
            aria-label="Close chat"
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            <svg
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </header>

      <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
        {QUICK_ACTIONS.map(action => (
          <button
            className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            disabled={snapshot.busy}
            key={action.id}
            onClick={() => send(buildQuickActionPrompt(action.id, context))}
            type="button"
          >
            {action.label(context.kind)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" ref={scrollRef}>
        {hasMessages ? (
          <ul className="flex flex-col gap-3">
            {snapshot.messages.map((message, index) => (
              <li
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                  message.role === 'user'
                    ? 'self-end bg-[color-mix(in_srgb,var(--ui-accent)_16%,transparent)] text-foreground'
                    : 'self-start bg-muted text-foreground',
                  message.error && 'border border-border bg-transparent text-muted-foreground'
                )}
                key={index}
              >
                {message.text || (message.streaming ? '…' : '')}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-muted-foreground">
            Ask anything about this {surfaceWord}, or tap a button above.
          </div>
        )}
      </div>

      <form
        className="border-t border-border p-2"
        onSubmit={event => {
          event.preventDefault()
          send(draft)
        }}
      >
        <textarea
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[var(--ui-accent)]"
          disabled={snapshot.busy}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send(draft)
            }
          }}
          placeholder={`Ask about this ${surfaceWord}...`}
          rows={2}
          value={draft}
        />
      </form>
    </aside>
  )
}
