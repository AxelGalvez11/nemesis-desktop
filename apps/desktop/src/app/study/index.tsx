// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import { IconCards, IconLayoutGrid, IconList, IconPlayerPause } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { markDeckFileImported, scanDeckFiles } from './deck-files'
import { parseCardPaste } from './import-cards'
import {
  addCard,
  buildQueue,
  deckStats,
  deleteCard,
  deleteDeck,
  freshId,
  gradeCard,
  groupDecks,
  loadState,
  previewIntervals,
  type QueueItem,
  reviewHeatmap,
  saveState,
  type StudyCard,
  type StudyDeck,
  studyMotivation,
  type StudyRating,
  type StudyState,
  toggleSuspendCard,
  updateCard
} from './model'

const GRADES: { key: string; label: string; rating: StudyRating }[] = [
  { key: '1', label: 'Again', rating: 'again' },
  { key: '2', label: 'Hard', rating: 'hard' },
  { key: '3', label: 'Good', rating: 'good' },
  { key: '4', label: 'Easy', rating: 'easy' }
]

type DeckViewMode = 'cards' | 'list'

const VIEW_MODE_KEY = 'nemesis.study.view'
const FLIP_KEY = 'nemesis.study.flip'

function loadViewMode(): DeckViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'cards'
  } catch {
    return 'cards'
  }
}

function loadFlip(): boolean {
  try {
    // Default on, but never fight a reduced-motion preference.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return false
    }

    return window.localStorage.getItem(FLIP_KEY) !== 'off'
  } catch {
    return true
  }
}

export function StudyView() {
  const [state, setState] = useState<StudyState>(() => loadState())
  const [reviewDeckId, setReviewDeckId] = useState<null | string>(null)
  const [browseDeckId, setBrowseDeckId] = useState<null | string>(null)
  const [reviewing, setReviewing] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [newDeckOpen, setNewDeckOpen] = useState(false)
  const [view, setView] = useState<DeckViewMode>(() => loadViewMode())
  const [flip, setFlip] = useState(() => loadFlip())
  const [matchDeckId, setMatchDeckId] = useState<null | string>(null)
  const [done, setDone] = useState(0)
  const [autoImported, setAutoImported] = useState<string[]>([])

  const now = useMemo(() => new Date(), [state, reviewing])
  const queue = useMemo(() => (reviewing ? buildQueue(state, reviewDeckId, now) : []), [state, reviewDeckId, reviewing, now])
  const current: QueueItem | undefined = queue[0]
  const totals = deckStats(state, null, now)

  const update = useCallback((next: StudyState) => {
    setState(next)
    saveState(next)
  }, [])

  // Agent-created decks: import any new deck files Nemesis wrote into the vault's
  // Flashcards folder (see deck-files.ts). Runs once per page visit.
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const candidates = await scanDeckFiles()

      if (cancelled || !candidates.length) {
        return
      }

      const importedNames: string[] = []

      setState(current => {
        let next = current

        for (const candidate of candidates) {
          markDeckFileImported(candidate.fileName)

          if (!candidate.cards.length) {
            continue
          }

          const deck: StudyDeck = {
            id: freshId('deck'),
            name: candidate.name,
            course: candidate.course,
            createdAt: new Date().toISOString(),
            cards: candidate.cards.map(card => ({ back: card.back, front: card.front, id: freshId('card'), tags: [] }))
          }
          next = { ...next, decks: [...next.decks, deck] }
          importedNames.push(candidate.name)
        }

        if (next !== current) {
          saveState(next)
        }

        return next
      })

      if (importedNames.length) {
        setAutoImported(importedNames)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startReview = useCallback((deckId: null | string) => {
    setReviewDeckId(deckId)
    setReviewing(true)
    setRevealed(false)
    setDone(0)
  }, [])

  const exitReview = useCallback(() => {
    setReviewing(false)
    setRevealed(false)
  }, [])

  const grade = useCallback(
    (rating: StudyRating) => {
      if (!current) {
        return
      }

      update(gradeCard(state, current.card.id, rating, new Date()))
      setRevealed(false)
      setDone(count => count + 1)
    },
    [current, state, update]
  )

  // Anki muscle memory: Space/Enter flips, 1-4 grades, Escape leaves the session.
  useEffect(() => {
    if (!reviewing) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null

      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }

      if (event.key === 'Escape') {
        exitReview()

        return
      }

      if (!current) {
        return
      }

      if (!revealed && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault()
        setRevealed(true)

        return
      }

      if (revealed) {
        const match = GRADES.find(option => option.key === event.key)

        if (match) {
          event.preventDefault()
          grade(match.rating)
        }
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [current, exitReview, grade, revealed, reviewing])

  const setViewMode = useCallback((mode: DeckViewMode) => {
    setView(mode)

    try {
      window.localStorage.setItem(VIEW_MODE_KEY, mode)
    } catch {
      // persistence is best-effort
    }
  }, [])

  const toggleFlip = useCallback(() => {
    setFlip(current => {
      const next = !current

      try {
        window.localStorage.setItem(FLIP_KEY, next ? 'on' : 'off')
      } catch {
        // persistence is best-effort
      }

      return next
    })
  }, [])

  const startMatch = useCallback(
    (deckId: string) => {
      setBrowseDeckId(null)
      exitReview()
      setMatchDeckId(deckId)
    },
    [exitReview]
  )

  const createDeck = useCallback(
    (name: string, course: string) => {
      const deck: StudyDeck = {
        id: freshId('deck'),
        name: name.trim() || 'New deck',
        course: course.trim() || undefined,
        createdAt: new Date().toISOString(),
        cards: []
      }

      update({ ...state, decks: [...state.decks, deck] })
      setNewDeckOpen(false)
      // Straight into the card browser so the first card is one click away.
      setBrowseDeckId(deck.id)
    },
    [state, update]
  )

  const removeDeck = useCallback(
    (deckId: string) => {
      update(deleteDeck(state, deckId))
      setBrowseDeckId(null)
    },
    [state, update]
  )

  const importCards = useCallback(
    (name: string, course: string, text: string) => {
      const parsed = parseCardPaste(text)

      if (!parsed.length) {
        return false
      }

      const deck: StudyDeck = {
        id: freshId('deck'),
        name: name.trim() || 'Imported deck',
        course: course.trim() || undefined,
        createdAt: new Date().toISOString(),
        cards: parsed.map(card => ({ id: freshId('card'), front: card.front, back: card.back, tags: [] }))
      }

      update({ ...state, decks: [...state.decks, deck] })
      setImportOpen(false)

      return true
    },
    [state, update]
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5">
        <div>
          <h1 className="text-lg font-semibold">Study</h1>
          <p className="text-xs text-muted-foreground">
            {totals.due} due · {totals.fresh} new · {totals.total} cards
          </p>
        </div>
        <div className="flex items-center gap-2">
          {reviewing || browseDeckId || matchDeckId ? (
            <Button
              onClick={() => {
                exitReview()
                setBrowseDeckId(null)
                setMatchDeckId(null)
              }}
              size="sm"
              variant="outline"
            >
              Back to decks
            </Button>
          ) : (
            <>
              <div className="mr-1 flex items-center overflow-hidden rounded-md border border-border">
                <button
                  className={cn(
                    'px-2 py-1.5 transition-colors',
                    view === 'cards' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setViewMode('cards')}
                  title="Card view"
                  type="button"
                >
                  <IconLayoutGrid size={14} />
                </button>
                <button
                  className={cn(
                    'px-2 py-1.5 transition-colors',
                    view === 'list' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setViewMode('list')}
                  title="List view"
                  type="button"
                >
                  <IconList size={14} />
                </button>
              </div>
              <button
                className={cn(
                  'rounded-md border border-border px-2 py-1.5 transition-colors',
                  flip ? 'text-(--theme-primary)' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={toggleFlip}
                title={flip ? 'Flip animation on' : 'Flip animation off'}
                type="button"
              >
                <IconCards size={14} />
              </button>
              <Button onClick={() => setNewDeckOpen(true)} size="sm" variant="outline">
                New deck
              </Button>
              <Button onClick={() => setImportOpen(true)} size="sm" variant="outline">
                Import cards
              </Button>
              <Button disabled={totals.due === 0} onClick={() => startReview(null)} size="sm">
                Study all
              </Button>
            </>
          )}
        </div>
      </header>

      {autoImported.length > 0 && !reviewing && !browseDeckId && (
        <div className="mx-6 mb-1 flex items-center justify-between rounded-md border border-(--theme-primary)/40 bg-(--theme-primary)/10 px-3 py-1.5 text-xs">
          <span>
            Nemesis added {autoImported.length === 1 ? 'a new deck' : `${autoImported.length} new decks`}:{' '}
            {autoImported.join(', ')}
          </span>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setAutoImported([])}
            type="button"
          >
            Dismiss
          </button>
        </div>
      )}

      {reviewing ? (
        current ? (
          <ReviewSurface
            done={done}
            flip={flip}
            item={current}
            intervals={previewIntervals(state, current.card.id, now)}
            onGrade={grade}
            onReveal={() => setRevealed(true)}
            remaining={queue.length}
            revealed={revealed}
          />
        ) : (
          <EmptyState
            className="flex-1"
            description={done > 0 ? `${done} card${done === 1 ? '' : 's'} reviewed. Come back when the next ones are due.` : 'Nothing is due right now.'}
            title="All caught up"
          />
        )
      ) : matchDeckId ? (
        <MatchGame deck={state.decks.find(deck => deck.id === matchDeckId) ?? null} onExit={() => setMatchDeckId(null)} />
      ) : browseDeckId ? (
        <CardBrowser
          deck={state.decks.find(deck => deck.id === browseDeckId) ?? null}
          onChange={update}
          onDeleteDeck={() => removeDeck(browseDeckId)}
          onMatch={() => startMatch(browseDeckId)}
          state={state}
        />
      ) : (
        <DeckBrowser onBrowse={setBrowseDeckId} onMatch={startMatch} onStudy={startReview} state={state} view={view} />
      )}

      <ImportDialog onImport={importCards} onOpenChange={setImportOpen} open={importOpen} />
      {newDeckOpen && <NewDeckDialog onClose={() => setNewDeckOpen(false)} onCreate={createDeck} />}
    </div>
  )
}

function NewDeckDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, course: string) => void }) {
  const [name, setName] = useState('')
  const [course, setCourse] = useState('')

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New deck</DialogTitle>
          <DialogDescription>Decks with the same course name group together on this page.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && name.trim()) {
                onCreate(name, course)
              }
            }}
            placeholder="Deck name (e.g. Renal pharm)"
            value={name}
          />
          <Input
            onChange={event => setCourse(event.target.value)}
            placeholder="Course / group (e.g. Pharmacology — optional)"
            value={course}
          />
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button disabled={!name.trim()} onClick={() => onCreate(name, course)}>
            Create deck
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeckBrowser({
  onBrowse,
  onMatch,
  onStudy,
  state,
  view
}: {
  onBrowse: (deckId: string) => void
  onMatch: (deckId: string) => void
  onStudy: (deckId: string) => void
  state: StudyState
  view: DeckViewMode
}) {
  const now = new Date()
  const groups = groupDecks(state, now)

  if (!state.decks.length) {
    return <EmptyState className="flex-1" description="Create a deck or import cards to get going." title="No decks yet" />
  }

  return (
    <div className="pb-8">
      <Heatmap state={state} />
      {groups.map(group => (
        <section className="px-6 pt-5" key={group.course}>
          <div className="mb-2 flex items-baseline justify-between border-b border-border pb-1.5">
            <h2 className="text-sm font-semibold">{group.course}</h2>
            <span className="text-xs text-muted-foreground">
              {group.stats.due} due · {group.decks.length} deck{group.decks.length === 1 ? '' : 's'} · {group.stats.total} cards
            </span>
          </div>
          {view === 'list' ? (
            <div className="overflow-hidden rounded-lg border border-border">
              {group.decks.map(deck => (
                <DeckRow deck={deck} key={deck.id} now={now} onBrowse={onBrowse} onMatch={onMatch} onStudy={onStudy} state={state} />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.decks.map(deck => (
                <DeckCard deck={deck} key={deck.id} now={now} onBrowse={onBrowse} onMatch={onMatch} onStudy={onStudy} state={state} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

function DeckRow({
  deck,
  now,
  onBrowse,
  onMatch,
  onStudy,
  state
}: {
  deck: StudyDeck
  now: Date
  onBrowse: (deckId: string) => void
  onMatch: (deckId: string) => void
  onStudy: (deckId: string) => void
  state: StudyState
}) {
  const stats = deckStats(state, deck.id, now)

  return (
    <div className="flex items-center gap-3 border-t border-border bg-card px-3 py-2 first:border-t-0 hover:bg-accent/50">
      <div className="min-w-0 flex-1 truncate text-sm">{deck.name}</div>
      <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
        {stats.total} cards · {stats.fresh} new
      </span>
      <span className="w-16 shrink-0 text-right">{stats.due > 0 && <Badge variant="muted">{stats.due} due</Badge>}</span>
      <div className="flex shrink-0 gap-1.5">
        <Button disabled={stats.due === 0} onClick={() => onStudy(deck.id)} size="sm" variant="secondary">
          Study
        </Button>
        <Button disabled={stats.total < 2} onClick={() => onMatch(deck.id)} size="sm" variant="outline">
          Match
        </Button>
        <Button onClick={() => onBrowse(deck.id)} size="sm" variant="outline">
          Cards
        </Button>
      </div>
    </div>
  )
}

function DeckCard({
  deck,
  now,
  onBrowse,
  onMatch,
  onStudy,
  state
}: {
  deck: StudyDeck
  now: Date
  onBrowse: (deckId: string) => void
  onMatch: (deckId: string) => void
  onStudy: (deckId: string) => void
  state: StudyState
}) {
  const stats = deckStats(state, deck.id, now)

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="truncate text-sm font-medium">{deck.name}</div>
          {stats.due > 0 && <Badge variant="muted">{stats.due} due</Badge>}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {stats.total} cards · {stats.fresh} new
        </div>
      </div>
      <div className="mt-auto flex gap-2">
        <Button className="flex-1" disabled={stats.due === 0} onClick={() => onStudy(deck.id)} size="sm" variant="secondary">
          {stats.due > 0 ? 'Study' : 'Done for now'}
        </Button>
        <Button disabled={stats.total < 2} onClick={() => onMatch(deck.id)} size="sm" variant="outline">
          Match
        </Button>
        <Button onClick={() => onBrowse(deck.id)} size="sm" variant="outline">
          Cards
        </Button>
      </div>
    </div>
  )
}

// Contribution grid of review activity with streak stats, month labels, hover tooltips,
// legend, and a today marker — the "dynamic" upgrade.
const HEAT_MIX = ['', '30%', '52%', '76%', '100%']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function heatColor(level: number): string {
  return level === 0
    ? 'color-mix(in srgb, gray 16%, transparent)'
    : `color-mix(in srgb, var(--theme-primary) ${HEAT_MIX[level]}, transparent)`
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-sm font-semibold text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function Heatmap({ state }: { state: StudyState }) {
  const todayIso = new Date().toISOString()
  const { cells, total } = useMemo(() => reviewHeatmap(state, todayIso), [state, todayIso])
  const stats = useMemo(() => studyMotivation(state, todayIso), [state, todayIso])
  const todayKey = todayIso.slice(0, 10)
  const weeks = Math.ceil(cells.length / 7)

  const monthLabels: { col: number; label: string }[] = []
  let lastMonth = -1

  for (let w = 0; w < weeks; w++) {
    const first = cells[w * 7]

    if (first) {
      const month = Number(first.date.slice(5, 7)) - 1

      if (month !== lastMonth) {
        monthLabels.push({ col: w, label: MONTHS[month] })
        lastMonth = month
      }
    }
  }

  return (
    <div className="px-6 pt-1">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
        <Stat label="day streak" value={stats.currentStreak} />
        <Stat label="longest" value={stats.longestStreak} />
        <Stat label="days active" value={`${stats.daysLearnedPct}%`} />
        {stats.retentionPct !== null && <Stat label="retention (30d)" value={`${stats.retentionPct}%`} />}
        <span className="text-muted-foreground">{total} reviews · 18 weeks</span>
      </div>

      <div className="inline-flex flex-col gap-1">
        <div className="relative h-3 text-[9px] text-muted-foreground" style={{ width: `${weeks * 14}px` }}>
          {monthLabels.map(m => (
            <span className="absolute" key={`${m.label}-${m.col}`} style={{ left: `${m.col * 14}px` }}>
              {m.label}
            </span>
          ))}
        </div>
        <div className="grid grid-flow-col grid-rows-7 gap-[3px]" style={{ gridAutoColumns: '11px', gridTemplateRows: 'repeat(7, 11px)' }}>
          {cells.map(cell => (
            <Tip
              key={cell.date}
              label={`${cell.count} review${cell.count === 1 ? '' : 's'} · ${new Date(`${cell.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`}
              side="top"
            >
              <div
                className={cn('rounded-[2px]', cell.date === todayKey && 'ring-1 ring-foreground/60')}
                style={{ backgroundColor: heatColor(cell.level) }}
              />
            </Tip>
          ))}
        </div>
        <div className="flex items-center gap-1 self-end text-[9px] text-muted-foreground">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map(level => (
            <span className="size-2.5 rounded-[2px]" key={level} style={{ backgroundColor: heatColor(level) }} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  )
}

function CardBrowser({
  deck,
  onChange,
  onDeleteDeck,
  onMatch,
  state
}: {
  deck: null | StudyDeck
  onChange: (next: StudyState) => void
  onDeleteDeck: () => void
  onMatch: () => void
  state: StudyState
}) {
  const [editing, setEditing] = useState<null | StudyCard>(null)
  const [adding, setAdding] = useState(false)
  const [armDelete, setArmDelete] = useState(false)

  if (!deck) {
    return <EmptyState className="flex-1" description="This deck no longer exists." title="Deck not found" />
  }

  return (
    <div className="px-6 pb-8">
      <div className="mb-2 flex items-baseline justify-between border-b border-border pb-1.5">
        <div>
          <h2 className="text-sm font-semibold">{deck.name}</h2>
          <p className="text-xs text-muted-foreground">
            {deck.course ? `${deck.course} · ` : ''}
            {deck.cards.length} card{deck.cards.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            className={cn(armDelete && 'text-destructive')}
            onBlur={() => setArmDelete(false)}
            onClick={() => (armDelete ? onDeleteDeck() : setArmDelete(true))}
            size="sm"
            variant="outline"
          >
            {armDelete ? 'Really delete?' : 'Delete deck'}
          </Button>
          <Button disabled={deck.cards.length < 2} onClick={onMatch} size="sm" variant="outline">
            Match
          </Button>
          <Button onClick={() => setAdding(true)} size="sm" variant="outline">
            Add card
          </Button>
        </div>
      </div>

      {deck.cards.length === 0 ? (
        <EmptyState className="min-h-40" description="Add a card or import a set." title="No cards in this deck" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Front</th>
                <th className="hidden px-3 py-2 text-left font-medium md:table-cell">Back</th>
                <th className="px-3 py-2 text-left font-medium">Tags</th>
                <th className="w-8 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {deck.cards.map(card => (
                <tr
                  className={cn('cursor-pointer border-t border-border hover:bg-accent', card.suspended && 'opacity-45')}
                  key={card.id}
                  onClick={() => setEditing(card)}
                >
                  <td className="max-w-xs truncate px-3 py-2">
                    {card.suspended && (
                      <IconPlayerPause className="-mt-px mr-1 inline text-muted-foreground" size={12} />
                    )}
                    {card.front}
                  </td>
                  <td className="hidden max-w-xs truncate px-3 py-2 text-muted-foreground md:table-cell">{card.back}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {card.tags.map(tag => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">›</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditCardDialog
          card={editing}
          onClose={() => setEditing(null)}
          onDelete={() => {
            onChange(deleteCard(state, deck.id, editing.id))
            setEditing(null)
          }}
          onSave={card => {
            onChange(updateCard(state, deck.id, card))
            setEditing(null)
          }}
          onToggleSuspend={() => {
            onChange(toggleSuspendCard(state, deck.id, editing.id))
            setEditing(null)
          }}
        />
      )}
      {adding && (
        <AddCardDialog
          onClose={() => setAdding(false)}
          onCreate={(front, back, tags) => {
            onChange(addCard(state, deck.id, front, back, tags))
            setAdding(false)
          }}
        />
      )}
    </div>
  )
}

function EditCardDialog({
  card,
  onClose,
  onDelete,
  onSave,
  onToggleSuspend
}: {
  card: StudyCard
  onClose: () => void
  onDelete: () => void
  onSave: (card: StudyCard) => void
  onToggleSuspend: () => void
}) {
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)
  const [tags, setTags] = useState(card.tags.join(', '))

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit card</DialogTitle>
          <DialogDescription>Suspend hides a card from review without deleting it.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Textarea className="min-h-20" onChange={event => setFront(event.target.value)} placeholder="Front" value={front} />
          <Textarea className="min-h-20" onChange={event => setBack(event.target.value)} placeholder="Back" value={back} />
          <Input onChange={event => setTags(event.target.value)} placeholder="Tags (comma-separated)" value={tags} />
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button className="text-destructive" onClick={onDelete} variant="outline">
              Delete
            </Button>
            <Button onClick={onToggleSuspend} variant="outline">
              {card.suspended ? 'Unsuspend' : 'Suspend'}
            </Button>
          </div>
          <Button
            disabled={!front.trim() || !back.trim()}
            onClick={() =>
              onSave({
                ...card,
                back: back.trim(),
                front: front.trim(),
                tags: tags.split(',').map(tag => tag.trim()).filter(Boolean)
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddCardDialog({
  onClose,
  onCreate
}: {
  onClose: () => void
  onCreate: (front: string, back: string, tags: string[]) => void
}) {
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [tags, setTags] = useState('')

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add card</DialogTitle>
          <DialogDescription>New cards enter the review queue as “new”.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Textarea className="min-h-20" onChange={event => setFront(event.target.value)} placeholder="Front" value={front} />
          <Textarea className="min-h-20" onChange={event => setBack(event.target.value)} placeholder="Back" value={back} />
          <Input onChange={event => setTags(event.target.value)} placeholder="Tags (comma-separated)" value={tags} />
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!front.trim() || !back.trim()}
            onClick={() => onCreate(front.trim(), back.trim(), tags.split(',').map(tag => tag.trim()).filter(Boolean))}
          >
            Add card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FlipFace({
  back,
  children,
  label,
  muted
}: {
  back?: boolean
  children: React.ReactNode
  label: string
  muted?: boolean
}) {
  return (
    <div
      className={cn(
        'absolute inset-0 flex min-h-64 flex-col justify-center gap-3 rounded-xl border border-border bg-card p-8 text-left [backface-visibility:hidden]',
        back && '[transform:rotateY(180deg)]'
      )}
    >
      <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn('text-lg leading-relaxed', muted ? 'text-foreground/80' : 'text-foreground')}>{children}</div>
    </div>
  )
}

// Quizlet-style Match: pair every front with its back as fast as you can. Wrong pairs
// shake and reset; a matched pair fades out. Pure client game over the deck's cards.
interface MatchTile {
  id: string
  cardId: string
  text: string
  side: 'front' | 'back'
}

function buildMatchTiles(deck: StudyDeck, size: number): MatchTile[] {
  // Deterministic-enough shuffle without RNG dependence on the module: seed off the
  // clock once per round (fresh each mount).
  const pool = [...deck.cards]
  const seed = Date.now()

  for (let i = pool.length - 1; i > 0; i--) {
    const j = ((seed >> (i % 16)) ^ (i * 2654435761)) % (i + 1)
    const k = j < 0 ? -j : j
    ;[pool[i], pool[k]] = [pool[k], pool[i]]
  }

  const chosen = pool.slice(0, size)
  const tiles: MatchTile[] = []

  for (const card of chosen) {
    tiles.push({ cardId: card.id, id: `${card.id}:f`, side: 'front', text: card.front })
    tiles.push({ cardId: card.id, id: `${card.id}:b`, side: 'back', text: card.back })
  }

  for (let i = tiles.length - 1; i > 0; i--) {
    const j = ((seed >> ((i + 3) % 16)) ^ (i * 40503)) % (i + 1)
    const k = j < 0 ? -j : j
    ;[tiles[i], tiles[k]] = [tiles[k], tiles[i]]
  }

  return tiles
}

function MatchGame({ deck, onExit }: { deck: null | StudyDeck; onExit: () => void }) {
  const size = deck ? Math.min(6, deck.cards.length) : 0
  const [tiles, setTiles] = useState<MatchTile[]>(() => (deck ? buildMatchTiles(deck, size) : []))
  const [selected, setSelected] = useState<null | string>(null)
  const [matched, setMatched] = useState<Set<string>>(new Set())
  const [wrong, setWrong] = useState<[string, string] | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [won, setWon] = useState(false)

  const restart = useCallback(() => {
    if (!deck) {
      return
    }

    setTiles(buildMatchTiles(deck, size))
    setSelected(null)
    setMatched(new Set())
    setWrong(null)
    setElapsed(0)
    setWon(false)
  }, [deck, size])

  // Timer runs until the board is cleared.
  useEffect(() => {
    if (won) {
      return
    }

    const id = window.setInterval(() => setElapsed(value => value + 1), 1000)

    return () => window.clearInterval(id)
  }, [won])

  const pick = useCallback(
    (tile: MatchTile) => {
      if (matched.has(tile.id) || wrong || tile.id === selected) {
        return
      }

      if (!selected) {
        setSelected(tile.id)

        return
      }

      const first = tiles.find(candidate => candidate.id === selected)

      if (!first) {
        setSelected(tile.id)

        return
      }

      if (first.cardId === tile.cardId && first.side !== tile.side) {
        const next = new Set(matched)
        next.add(first.id)
        next.add(tile.id)
        setMatched(next)
        setSelected(null)

        if (next.size === tiles.length) {
          setWon(true)
        }
      } else {
        setWrong([first.id, tile.id])
        setSelected(null)
        window.setTimeout(() => setWrong(null), 550)
      }
    },
    [matched, selected, tiles, wrong]
  )

  if (!deck) {
    return <EmptyState className="flex-1" description="This deck no longer exists." title="Deck not found" />
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-8">
      <div className="flex items-center justify-between pb-3">
        <div>
          <h2 className="text-sm font-semibold">{deck.name} — Match</h2>
          <p className="text-xs text-muted-foreground">Tap a term, then its match. Fastest time wins.</p>
        </div>
        <span className="text-lg font-semibold tabular-nums text-muted-foreground">
          {mm}:{ss}
        </span>
      </div>

      {won ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="text-center">
            <div className="text-2xl font-semibold">Matched them all</div>
            <div className="pt-1 text-sm text-muted-foreground">
              {size} pairs in {mm}:{ss}
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={restart}>Play again</Button>
            <Button onClick={onExit} variant="outline">
              Back to decks
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-4">
          {tiles.map(tile => {
            const isMatched = matched.has(tile.id)
            const isWrong = wrong?.includes(tile.id)
            const isSelected = selected === tile.id

            return (
              <button
                className={cn(
                  'flex items-center justify-center rounded-lg border p-3 text-center text-sm leading-snug transition-all',
                  isMatched && 'pointer-events-none scale-95 border-transparent bg-transparent opacity-0',
                  isSelected && 'border-(--theme-primary) bg-(--theme-primary)/10',
                  isWrong && 'nemesis-shake border-destructive text-destructive',
                  !isMatched && !isSelected && !isWrong && 'border-border bg-card hover:border-(--theme-primary)/50'
                )}
                key={tile.id}
                onClick={() => pick(tile)}
                type="button"
              >
                {tile.text}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ReviewSurface({
  done,
  flip,
  intervals,
  item,
  onGrade,
  onReveal,
  remaining,
  revealed
}: {
  done: number
  flip: boolean
  intervals: Record<StudyRating, string>
  item: QueueItem
  onGrade: (rating: StudyRating) => void
  onReveal: () => void
  remaining: number
  revealed: boolean
}) {
  const total = done + remaining
  const progress = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="flex flex-1 flex-col items-center px-6 pb-8">
      <div className="flex w-full max-w-2xl flex-1 flex-col">
        <div className="flex items-center justify-between pb-2 text-xs text-muted-foreground">
          <span className="truncate">
            {item.deckName}
            {item.isNew && (
              <Badge className="ml-2" variant="outline">
                new
              </Badge>
            )}
          </span>
          <span className="tabular-nums">
            {done} done · {remaining} left
          </span>
        </div>

        {/* Session progress */}
        <div className="mb-4 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary,theme(colors.muted.DEFAULT))">
          <div className="h-full bg-(--theme-primary) transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>

        {/* Card. Flip build = a 3D-rotating card with distinct front/back faces; plain
            build reveals the answer beneath a divider (unchanged behavior). */}
        {flip ? (
          <button
            aria-label={revealed ? item.card.back : 'Show answer'}
            className="nemesis-flip flex-1 [perspective:1600px]"
            data-flipped={revealed ? 'true' : undefined}
            onClick={() => !revealed && onReveal()}
            type="button"
          >
            <div className="nemesis-flip-inner relative h-full min-h-64 w-full">
              <FlipFace label="Question">{item.card.front}</FlipFace>
              <FlipFace back label="Answer" muted>
                {item.card.back}
              </FlipFace>
            </div>
          </button>
        ) : (
          <div className="flex min-h-64 flex-1 flex-col justify-center gap-5 rounded-xl border border-border bg-card p-8">
            <div>
              <div className="pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Question</div>
              <div className="text-lg leading-relaxed">{item.card.front}</div>
            </div>
            {revealed && (
              <>
                <div className="border-t border-border" />
                <div>
                  <div className="pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Answer</div>
                  <div className="text-lg leading-relaxed text-foreground/80">{item.card.back}</div>
                </div>
              </>
            )}
          </div>
        )}

        {item.card.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-2.5">
            {item.card.tags.map(tag => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        <div className="pt-4">
          {revealed ? (
            <div className="grid grid-cols-4 gap-2">
              {GRADES.map(option => (
                <Button
                  className={cn('flex-col gap-0.5 py-5', option.rating === 'again' && 'text-destructive')}
                  key={option.rating}
                  onClick={() => onGrade(option.rating)}
                  variant="secondary"
                >
                  <span>{option.label}</span>
                  <span className="text-[10px] opacity-60">
                    {intervals[option.rating]} · {option.key}
                  </span>
                </Button>
              ))}
            </div>
          ) : (
            <Button className="w-full py-5" onClick={onReveal} variant="secondary">
              Show answer <span className="ml-2 text-[10px] opacity-60">Space</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function ImportDialog({
  onImport,
  onOpenChange,
  open
}: {
  onImport: (name: string, course: string, text: string) => boolean
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const [name, setName] = useState('')
  const [course, setCourse] = useState('')
  const [text, setText] = useState('')

  const parsedCount = useMemo(() => parseCardPaste(text).length, [text])

  const submit = () => {
    if (onImport(name, course, text)) {
      setName('')
      setCourse('')
      setText('')
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import cards</DialogTitle>
          <DialogDescription>
            Paste one card per line — term and definition separated by a tab (Quizlet export), “ - ”, or a comma.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input onChange={event => setName(event.target.value)} placeholder="Deck name" value={name} />
          <Input onChange={event => setCourse(event.target.value)} placeholder="Course (optional)" value={course} />
          <Textarea
            className="min-h-40 font-mono text-xs"
            onChange={event => setText(event.target.value)}
            placeholder={'lisinopril\tACE inhibitor — dry cough via bradykinin\nmetoprolol - beta-1 selective blocker'}
            value={text}
          />
          <div className="text-xs text-muted-foreground">
            {parsedCount > 0 ? `${parsedCount} card${parsedCount === 1 ? '' : 's'} detected` : 'No cards detected yet'}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={parsedCount === 0} onClick={submit}>
            Create deck
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
