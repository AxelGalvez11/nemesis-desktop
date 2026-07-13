// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import {
  IconCards,
  IconChevronDown,
  IconChecklist,
  IconDots,
  IconFileImport,
  IconFolderPlus,
  IconLayoutGrid,
  IconList,
  IconPlayerPause,
  IconPlus,
  IconSettings,
  IconSitemap
} from '@tabler/icons-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { importedDeckFileNames, scanAllDeckFiles } from './deck-files'
import {
  bestAttempt,
  groupExtras,
  lastAttempt,
  loadTestAttempts,
  type MindmapFile,
  scanMindmapFiles,
  scanTestFiles,
  type TestAttempt,
  type TestAttemptsStore,
  type TestFile
} from './extras'
import { parseCardPaste } from './import-cards'
import { MindmapViewerDialog } from './mindmap-viewer'
import {
  addCard,
  addSection,
  adoptLegacyDeckFiles,
  assignDeckSection,
  buildQueue,
  deckStats,
  type DeckStats,
  DEFAULT_STUDY_SETTINGS,
  deleteCard,
  deleteDeck,
  freshId,
  getSettings,
  gradeCard,
  groupDecks,
  loadState,
  previewIntervals,
  type QueueItem,
  reconcileDeckFiles,
  reviewHeatmap,
  type ReviewOrder,
  saveState,
  setSettings,
  type StudyCard,
  type StudyDeck,
  studyMotivation,
  type StudyRating,
  type StudySettings,
  type StudyState,
  toggleSuspendCard,
  updateCard
} from './model'
import { deckRetentionCurve, type RetentionPoint } from './retention'
import { TestSurface } from './test-mode'

const GRADES: { key: string; label: string; rating: StudyRating }[] = [
  { key: '1', label: 'Again', rating: 'again' },
  { key: '2', label: 'Hard', rating: 'hard' },
  { key: '3', label: 'Good', rating: 'good' },
  { key: '4', label: 'Easy', rating: 'easy' }
]

type DeckViewMode = 'cards' | 'list'

const VIEW_MODE_KEY = 'nemesis.study.view'
const COLLAPSED_SECTIONS_KEY = 'nemesis.study.sections.collapsed.v1'

const ORDER_OPTIONS: SegmentedControlOption<ReviewOrder>[] = [
  { id: 'due', label: 'Due first' },
  { id: 'random', label: 'Random' }
]

type ReviewCategory = 'learning' | 'new' | 'review'

interface ReviewCategoryCounts {
  learning: number
  new: number
  review: number
}

function categoryForQueueItem(item: QueueItem, state: StudyState): ReviewCategory {
  if (item.isNew) {
    return 'new'
  }

  const cardState = state.schedule[item.card.id]?.state

  return cardState === 1 || cardState === 3 ? 'learning' : 'review'
}

function countQueueCategories(queue: QueueItem[], state: StudyState): ReviewCategoryCounts {
  return queue.reduce<ReviewCategoryCounts>(
    (counts, item) => {
      counts[categoryForQueueItem(item, state)]++

      return counts
    },
    { learning: 0, new: 0, review: 0 }
  )
}

function loadViewMode(): DeckViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_KEY) === 'cards' ? 'cards' : 'list'
  } catch {
    return 'list'
  }
}

function loadCollapsedSections(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? '[]')

    return Array.isArray(stored)
      ? new Set(stored.filter((course): course is string => typeof course === 'string'))
      : new Set()
  } catch {
    return new Set()
  }
}

// The flip toggle's persisted value now lives in StudySettings (model.ts migrates
// the old standalone key on load — see LEGACY_FLIP_KEY). This only covers the
// OS-level accessibility preference, which always overrides the stored setting.
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

export function StudyView() {
  const [state, setState] = useState<StudyState>(() => loadState())
  const [reviewDeckId, setReviewDeckId] = useState<null | string>(null)
  const [browseDeckId, setBrowseDeckId] = useState<null | string>(null)
  const [reviewing, setReviewing] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [newDeckSection, setNewDeckSection] = useState<null | string>(null)
  const [newSectionOpen, setNewSectionOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState<DeckViewMode>(() => loadViewMode())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => loadCollapsedSections())
  const [reducedMotion] = useState(() => prefersReducedMotion())
  const [matchDeckId, setMatchDeckId] = useState<null | string>(null)
  const [done, setDone] = useState(0)
  const [sessionTotal, setSessionTotal] = useState(0)
  const [autoImported, setAutoImported] = useState<string[]>([])
  const [mindmaps, setMindmaps] = useState<MindmapFile[]>([])
  const [tests, setTests] = useState<TestFile[]>([])
  const [testAttempts, setTestAttempts] = useState<TestAttemptsStore>(() => loadTestAttempts())
  const [viewingMindmap, setViewingMindmap] = useState<MindmapFile | null>(null)
  const [takingTest, setTakingTest] = useState<null | TestFile>(null)

  const now = useMemo(() => new Date(), [state, reviewing])
  const queue = useMemo(
    () => (reviewing ? buildQueue(state, reviewDeckId, now) : []),
    [state, reviewDeckId, reviewing, now]
  )
  const current: QueueItem | undefined = queue[0]

  const remainingCounts = useMemo(
    () => countQueueCategories(queue, state),
    [queue, state]
  )

  const todayQueue = useMemo(() => buildQueue(state, null, now), [now, state])
  const todayCounts = useMemo(
    () => countQueueCategories(todayQueue, state),
    [state, todayQueue]
  )
  const scheduledDue = todayCounts.learning + todayCounts.review
  const estimatedReviewMinutes =
    todayQueue.length > 0 ? Math.max(1, Math.ceil((todayQueue.length * 20) / 60)) : 0

  const totals = deckStats(state, null, now)

  const sections = useMemo(
    () =>
      groupDecks(state, now)
        .map(group => group.course)
        .filter(course => course.toLocaleLowerCase() !== 'other'),
    [now, state]
  )

  const settings = getSettings(state)
  const flip = settings.flip && !reducedMotion

  const update = useCallback((next: StudyState) => {
    setState(next)
    saveState(next)
  }, [])

  const toggleSection = useCallback((course: string) => {
    setCollapsedSections(current => {
      const next = new Set(current)

      if (next.has(course)) {
        next.delete(course)
      } else {
        next.add(course)
      }

      try {
        window.localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...next]))
      } catch {
        // A blocked/full localStorage should not prevent the section from toggling.
      }

      return next
    })
  }, [])

  // Agent-managed decks: the vault's Flashcards folder is the source of truth, so
  // reconcile against it on mount and whenever the window regains focus — the agent
  // may have renamed, edited, or deleted deck files while you were away. Debounced so
  // an incidental refocus doesn't hammer the disk. Review schedules survive because
  // reconcile keeps card ids for unchanged card text (see model.ts).
  useEffect(() => {
    let cancelled = false
    let lastRun = 0

    const reconcile = async () => {
      lastRun = Date.now()
      const [candidates, mindmapFiles, testFiles] = await Promise.all([
        scanAllDeckFiles(),
        scanMindmapFiles(),
        scanTestFiles()
      ])

      if (cancelled) {
        return
      }

      // Mind maps/tests carry no schedule state to preserve, so every scan just
      // replaces the list outright — no reconcile-against-existing-state needed.
      setMindmaps(mindmapFiles)
      setTests(testFiles)

      if (!candidates) {
        return
      }

      const addedNames: string[] = []

      setState(current => {
        const adopted = adoptLegacyDeckFiles(current, importedDeckFileNames())
        const next = reconcileDeckFiles(adopted, candidates)

        if (next === current) {
          return current
        }

        const knownIds = new Set(current.decks.map(deck => deck.id))

        for (const deck of next.decks) {
          // Genuinely new decks only — renamed/relinked decks keep their id.
          if (deck.sourceFile && !knownIds.has(deck.id)) {
            addedNames.push(deck.name)
          }
        }

        saveState(next)

        return next
      })

      if (addedNames.length) {
        setAutoImported([...new Set(addedNames)])
      }
    }

    void reconcile()

    const onFocus = () => {
      if (Date.now() - lastRun < 1500) {
        return
      }

      void reconcile()
    }

    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const startReview = useCallback(
    (deckId: null | string) => {
      const sessionQueue = buildQueue(state, deckId, new Date())

      setReviewDeckId(deckId)
      setSessionTotal(sessionQueue.length)
      setReviewing(true)
      setRevealed(false)
      setDone(0)
    },
    [state]
  )

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
      setNewDeckSection(null)
      // Straight into the card browser so the first card is one click away.
      setBrowseDeckId(deck.id)
    },
    [state, update]
  )

  const createSection = useCallback(
    (name: string) => {
      update(addSection(state, name))
      setNewSectionOpen(false)
    },
    [state, update]
  )

  const moveDeck = useCallback(
    (deckId: string, section: string) => update(assignDeckSection(state, deckId, section)),
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
      <header className="flex shrink-0 items-start justify-between gap-3 px-6 pb-3 pt-5">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Study</h1>
          <p className="mt-0.5 text-[0.65rem] font-medium tabular-nums text-(--ui-text-tertiary)">
            {totals.due} due · {totals.fresh} new · {totals.total} cards
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {reviewing || browseDeckId || matchDeckId || takingTest ? (
            <Button
              onClick={() => {
                exitReview()
                setBrowseDeckId(null)
                setMatchDeckId(null)
                setTakingTest(null)
              }}
              size="sm"
              variant="outline"
            >
              Back to decks
            </Button>
          ) : (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button aria-label="Add study material" size="icon-xs" title="Add study material" variant="ghost">
                    <IconPlus />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={() => setNewDeckSection('')}>
                    <IconCards />
                    New deck
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setNewSectionOpen(true)}>
                    <IconFolderPlus />
                    New section
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                    <IconFileImport />
                    Import cards
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Tip label="Study settings">
                <Button
                  aria-label="Study settings"
                  onClick={() => setSettingsOpen(true)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <IconSettings />
                </Button>
              </Tip>
            </>
          )}
        </div>
      </header>

      {!reviewing && !browseDeckId && !matchDeckId && !takingTest && (
        <TodaysReviewBrief
          counts={todayCounts}
          estimatedMinutes={estimatedReviewMinutes}
          hasScheduledDue={scheduledDue > 0}
          onStart={() => startReview(null)}
          total={todayQueue.length}
        />
      )}

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
            activeCategory={categoryForQueueItem(current, state)}
            flip={flip}
            intervals={previewIntervals(state, current.card.id, now)}
            item={current}
            onGrade={grade}
            onReveal={() => setRevealed(true)}
            position={Math.min(done + 1, sessionTotal)}
            remainingCounts={remainingCounts}
            revealed={revealed}
            sessionTotal={sessionTotal}
            showIntervalHints={settings.showIntervalHints}
          />
        ) : (
          <EmptyState
            className="flex-1"
            description={
              done > 0
                ? `${done} card${done === 1 ? '' : 's'} reviewed. Come back when the next ones are due.`
                : 'Nothing is due right now.'
            }
            title="All caught up"
          />
        )
      ) : matchDeckId ? (
        <MatchGame
          deck={state.decks.find(deck => deck.id === matchDeckId) ?? null}
          onExit={() => setMatchDeckId(null)}
        />
      ) : browseDeckId ? (
        <CardBrowser
          deck={state.decks.find(deck => deck.id === browseDeckId) ?? null}
          onChange={update}
          onDeleteDeck={() => removeDeck(browseDeckId)}
          onMatch={() => startMatch(browseDeckId)}
          onMoveDeck={section => moveDeck(browseDeckId, section)}
          sections={sections}
          state={state}
        />
      ) : takingTest ? (
        <TestSurface
          file={takingTest}
          onComplete={() => setTestAttempts(loadTestAttempts())}
          onExit={() => setTakingTest(null)}
        />
      ) : (
        <DeckBrowser
          collapsedSections={collapsedSections}
          mindmaps={mindmaps}
          onBrowse={setBrowseDeckId}
          onCreateDeck={setNewDeckSection}
          onDeleteDeck={removeDeck}
          onMatch={startMatch}
          onMoveDeck={moveDeck}
          onOpenMindmap={setViewingMindmap}
          onStartTest={setTakingTest}
          onStudy={startReview}
          onToggleSection={toggleSection}
          onViewChange={setViewMode}
          state={state}
          testAttempts={testAttempts}
          tests={tests}
          view={view}
        />
      )}

      <MindmapViewerDialog file={viewingMindmap} onOpenChange={open => !open && setViewingMindmap(null)} />
      <ImportDialog onImport={importCards} onOpenChange={setImportOpen} open={importOpen} sections={sections} />
      {newDeckSection !== null && (
        <NewDeckDialog
          initialSection={newDeckSection}
          onClose={() => setNewDeckSection(null)}
          onCreate={createDeck}
          sections={sections}
        />
      )}
      {newSectionOpen && (
        <NewSectionDialog onClose={() => setNewSectionOpen(false)} onCreate={createSection} sections={sections} />
      )}
      <StudySettingsDialog
        onChange={patch => update(setSettings(state, patch))}
        onOpenChange={setSettingsOpen}
        open={settingsOpen}
        settings={settings}
      />
    </div>
  )
}

function TodaysReviewBrief({
  counts,
  estimatedMinutes,
  hasScheduledDue,
  onStart,
  total
}: {
  counts: ReviewCategoryCounts
  estimatedMinutes: number
  hasScheduledDue: boolean
  onStart: () => void
  total: number
}) {
  const hasFreshCards = counts.new > 0

  return (
    <section className="mx-6 mb-3 flex items-center justify-between gap-5 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-3">
      <div className="min-w-0">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)">
          Today&rsquo;s review
        </p>

        {hasScheduledDue ? (
          <p className="mt-1 text-base font-semibold tracking-tight">
            {total} card{total === 1 ? '' : 's'}{' '}
            <span className="font-normal text-muted-foreground">· about {estimatedMinutes} min</span>
          </p>
        ) : (
          <p className="mt-1 text-base font-semibold tracking-tight">You&rsquo;re caught up</p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] tabular-nums text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">{counts.new}</span> New
          </span>
          <span>
            <span className="font-semibold text-foreground">{counts.learning}</span> Learning
          </span>
          <span>
            <span className="font-semibold text-foreground">{counts.review}</span> Review
          </span>
        </div>
      </div>

      {hasScheduledDue ? (
        <Button onClick={onStart} size="sm">
          Start review →
        </Button>
      ) : hasFreshCards ? (
        <Button onClick={onStart} size="sm">
          Practice new cards
        </Button>
      ) : null}
    </section>
  )
}

const OTHER_SECTION_VALUE = '__other__'

function SectionSelect({
  label,
  onChange,
  sections,
  value
}: {
  label: string
  onChange: (section: string) => void
  sections: string[]
  value: string
}) {
  return (
    <Select
      onValueChange={section => onChange(section === OTHER_SECTION_VALUE ? '' : section)}
      value={value.trim() || OTHER_SECTION_VALUE}
    >
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue placeholder="Other" />
      </SelectTrigger>
      <SelectContent>
        {sections.map(section => (
          <SelectItem key={section} value={section}>
            {section}
          </SelectItem>
        ))}
        <SelectItem value={OTHER_SECTION_VALUE}>Other</SelectItem>
      </SelectContent>
    </Select>
  )
}

function NewDeckDialog({
  initialSection,
  onClose,
  onCreate,
  sections
}: {
  initialSection: string
  onClose: () => void
  onCreate: (name: string, course: string) => void
  sections: string[]
}) {
  const [name, setName] = useState('')
  const [course, setCourse] = useState(initialSection)

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New deck</DialogTitle>
          <DialogDescription>Choose where this deck belongs. Ungrouped decks stay in Other.</DialogDescription>
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
          <div className="space-y-1.5">
            <label className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              Section
            </label>
            <SectionSelect label="Deck section" onChange={setCourse} sections={sections} value={course} />
          </div>
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

function NewSectionDialog({
  onClose,
  onCreate,
  sections
}: {
  onClose: () => void
  onCreate: (name: string) => void
  sections: string[]
}) {
  const [name, setName] = useState('')
  const normalized = name.trim().toLocaleLowerCase()
  const unavailable = normalized === 'other' || sections.some(section => section.toLocaleLowerCase() === normalized)
  const valid = Boolean(normalized) && !unavailable

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New section</DialogTitle>
          <DialogDescription>
            Create a home for related decks. Empty sections remain visible until you add one.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          onChange={event => setName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && valid) {
              onCreate(name)
            }
          }}
          placeholder="Section name (e.g. Pharmacology)"
          value={name}
        />
        {normalized && unavailable && (
          <p className="text-xs text-muted-foreground">
            That section already exists. “Other” is reserved for ungrouped decks.
          </p>
        )}
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button disabled={!valid} onClick={() => onCreate(name)}>
            Create section
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SettingRow({
  children,
  description,
  label
}: {
  children: React.ReactNode
  description?: string
  label: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0 pr-2">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Cast + clamp a raw number-input string to a non-negative integer. Empty or
 *  non-numeric input becomes 0 (== unlimited), never NaN or negative. */
function parseDailyCap(raw: string): number {
  const parsed = Math.round(Number(raw))

  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function StudySettingsDialog({
  onChange,
  onOpenChange,
  open,
  settings
}: {
  onChange: (patch: Partial<StudySettings>) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  settings: StudySettings
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Study settings</DialogTitle>
          <DialogDescription>Limits and behavior for review sessions. Changes apply immediately.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col divide-y divide-border">
          <SettingRow description="Cards introduced for the first time. 0 = unlimited." label="New cards per day">
            <Input
              className="w-20 text-right"
              inputMode="numeric"
              min={0}
              onChange={event => onChange({ newPerDay: parseDailyCap(event.target.value) })}
              step={1}
              type="number"
              value={settings.newPerDay}
            />
          </SettingRow>
          <SettingRow description="Cards already in review rotation. 0 = unlimited." label="Reviews per day">
            <Input
              className="w-20 text-right"
              inputMode="numeric"
              min={0}
              onChange={event => onChange({ reviewsPerDay: parseDailyCap(event.target.value) })}
              step={1}
              type="number"
              value={settings.reviewsPerDay}
            />
          </SettingRow>
          <SettingRow label="Review order">
            <SegmentedControl onChange={order => onChange({ order })} options={ORDER_OPTIONS} value={settings.order} />
          </SettingRow>
          <SettingRow label="Card flip animation">
            <Switch
              aria-label="Card flip animation"
              checked={settings.flip}
              onCheckedChange={flip => onChange({ flip })}
            />
          </SettingRow>
          <SettingRow description="The estimated interval shown on each grade button." label="Next-interval hints">
            <Switch
              aria-label="Show next-interval hints"
              checked={settings.showIntervalHints}
              onCheckedChange={showIntervalHints => onChange({ showIntervalHints })}
            />
          </SettingRow>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button onClick={() => onChange(DEFAULT_STUDY_SETTINGS)} size="sm" variant="text">
            Reset to defaults
          </Button>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// DeckGroup, widened with the section's mind maps/tests (see extras.ts's groupExtras) —
// a section can now have content even with zero decks, so the "no decks" placard below
// is suppressed whenever there's something else to show.
interface StudySectionGroup {
  course: string
  decks: StudyDeck[]
  extras?: { mindmaps: MindmapFile[]; tests: TestFile[] }
  stats: DeckStats
}

function DeckBrowser({
  collapsedSections,
  mindmaps,
  onBrowse,
  onCreateDeck,
  onDeleteDeck,
  onMatch,
  onMoveDeck,
  onOpenMindmap,
  onStartTest,
  onStudy,
  onToggleSection,
  onViewChange,
  state,
  testAttempts,
  tests,
  view
}: {
  collapsedSections: Set<string>
  mindmaps: MindmapFile[]
  onBrowse: (deckId: string) => void
  onCreateDeck: (section: string) => void
  onDeleteDeck: (deckId: string) => void
  onMatch: (deckId: string) => void
  onMoveDeck: (deckId: string, section: string) => void
  onOpenMindmap: (file: MindmapFile) => void
  onStartTest: (file: TestFile) => void
  onStudy: (deckId: string) => void
  onToggleSection: (course: string) => void
  onViewChange: (view: DeckViewMode) => void
  state: StudyState
  testAttempts: TestAttemptsStore
  tests: TestFile[]
  view: DeckViewMode
}) {
  const [deleteDeckTarget, setDeleteDeckTarget] = useState<StudyDeck | null>(null)

  const { curvesByDeck, now } = useMemo(() => {
    const calculationTime = new Date()
    const curves = new Map(
      state.decks.map(deck => [
        deck.id,
        deckRetentionCurve(
          deck.cards.flatMap(card => {
            const schedule = state.schedule[card.id]

            return schedule ? [schedule] : []
          }),
          calculationTime
        )
      ])
    )

    return { curvesByDeck: curves, now: calculationTime }
  }, [state])

  const deckGroups = groupDecks(state, now)
  const extrasByCourse = useMemo(
    () => groupExtras(state.sections, mindmaps, tests),
    [mindmaps, state.sections, tests]
  )

  const extraOnlyCourses = [...extrasByCourse.keys()]
    .filter(course => !deckGroups.some(group => group.course === course))
    .sort((a, b) => a.localeCompare(b))

  const groups: StudySectionGroup[] = [
    ...deckGroups.map(group => ({ ...group, extras: extrasByCourse.get(group.course) })),
    ...extraOnlyCourses.map(course => ({
      course,
      decks: [],
      extras: extrasByCourse.get(course),
      stats: { due: 0, fresh: 0, total: 0 }
    }))
  ].sort((a, b) => {
    const aIsOther = a.course.toLocaleLowerCase() === 'other'
    const bIsOther = b.course.toLocaleLowerCase() === 'other'

    if (aIsOther !== bIsOther) {
      return aIsOther ? 1 : -1
    }

    return b.stats.due - a.stats.due || a.course.localeCompare(b.course)
  })

  if (!groups.length) {
    return (
      <EmptyState className="flex-1" description="Create a deck or import cards to get going." title="No decks yet" />
    )
  }

  return (
    <div className="pb-10">
      <div className="flex justify-end px-8 pt-1">
        <div className="flex items-center rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-0.5">
          <Tip label="List view">
            <Button
              aria-label="List view"
              aria-pressed={view === 'list'}
              className={cn(view === 'list' && 'bg-(--ui-control-active-background) text-foreground')}
              onClick={() => onViewChange('list')}
              size="icon-xs"
              variant="ghost"
            >
              <IconList />
            </Button>
          </Tip>
          <Tip label="Card view">
            <Button
              aria-label="Card view"
              aria-pressed={view === 'cards'}
              className={cn(view === 'cards' && 'bg-(--ui-control-active-background) text-foreground')}
              onClick={() => onViewChange('cards')}
              size="icon-xs"
              variant="ghost"
            >
              <IconLayoutGrid />
            </Button>
          </Tip>
        </div>
      </div>

      {groups.map(group => {
        const groupMindmaps = group.extras?.mindmaps ?? []
        const groupTests = group.extras?.tests ?? []
        const hasExtras = groupMindmaps.length > 0 || groupTests.length > 0
        const hasResources = group.decks.length > 0 || hasExtras
        const isCollapsed = collapsedSections.has(group.course)

        return (
          <section className="px-8 pt-5" key={group.course}>
            <div className="mb-2 flex items-baseline justify-between gap-4">
              <h2 className="min-w-0 text-sm font-semibold tracking-tight">
                <button
                  aria-expanded={!isCollapsed}
                  className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => onToggleSection(group.course)}
                  type="button"
                >
                  <IconChevronDown
                    aria-hidden="true"
                    className={cn('shrink-0 transition-transform', isCollapsed && '-rotate-90')}
                    size={14}
                  />
                  <span className="truncate">{group.course}</span>
                </button>
              </h2>
              <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">
                {group.stats.due} due · {group.decks.length} deck{group.decks.length === 1 ? '' : 's'} ·{' '}
                {group.stats.total} cards
                {groupMindmaps.length > 0 &&
                  ` · ${groupMindmaps.length} mind map${groupMindmaps.length === 1 ? '' : 's'}`}
                {groupTests.length > 0 && ` · ${groupTests.length} test${groupTests.length === 1 ? '' : 's'}`}
              </span>
            </div>

            {!isCollapsed &&
              (hasResources ? (
                view === 'list' ? (
                  <div className="divide-y divide-(--ui-stroke-tertiary) rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)">
                    {group.decks.map(deck => (
                      <DeckRow
                        curve={curvesByDeck.get(deck.id) ?? []}
                        deck={deck}
                        key={deck.id}
                        now={now}
                        onBrowse={onBrowse}
                        onDelete={() => setDeleteDeckTarget(deck)}
                        onMatch={onMatch}
                        onMove={section => onMoveDeck(deck.id, section)}
                        onStudy={onStudy}
                        sections={state.sections}
                        state={state}
                      />
                    ))}
                    {groupMindmaps.map(mindmap => (
                      <MindmapRow key={mindmap.fileName} mindmap={mindmap} onOpen={() => onOpenMindmap(mindmap)} />
                    ))}
                    {groupTests.map(test => (
                      <TestRow
                        attempts={testAttempts[test.fileName]?.attempts ?? []}
                        key={test.fileName}
                        onStart={() => onStartTest(test)}
                        test={test}
                      />
                    ))}
                  </div>
                ) : (
                  <>
                    {group.decks.length > 0 && (
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {group.decks.map(deck => (
                          <DeckCard
                            curve={curvesByDeck.get(deck.id) ?? []}
                            deck={deck}
                            key={deck.id}
                            now={now}
                            onBrowse={onBrowse}
                            onDelete={() => setDeleteDeckTarget(deck)}
                            onMatch={onMatch}
                            onMove={section => onMoveDeck(deck.id, section)}
                            onStudy={onStudy}
                            sections={state.sections}
                            state={state}
                          />
                        ))}
                      </div>
                    )}

                    {hasExtras && (
                      <div
                        className={cn(
                          'divide-y divide-(--ui-stroke-tertiary) rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)',
                          group.decks.length > 0 && 'mt-3'
                        )}
                      >
                        {groupMindmaps.map(mindmap => (
                          <MindmapRow
                            key={mindmap.fileName}
                            mindmap={mindmap}
                            onOpen={() => onOpenMindmap(mindmap)}
                          />
                        ))}
                        {groupTests.map(test => (
                          <TestRow
                            attempts={testAttempts[test.fileName]?.attempts ?? []}
                            key={test.fileName}
                            onStart={() => onStartTest(test)}
                            test={test}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )
              ) : (
                <div className="rounded-md border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-4">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">
                    Empty section
                  </p>
                  <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <span>No decks yet —</span>
                    <Button onClick={() => onCreateDeck(group.course)} size="inline" variant="textStrong">
                      add one
                    </Button>
                  </div>
                </div>
              ))}
          </section>
        )
      })}

      <Heatmap state={state} />

      <DeleteDeckDialog
        deck={deleteDeckTarget}
        onClose={() => setDeleteDeckTarget(null)}
        onConfirm={() => {
          if (!deleteDeckTarget) {
            return
          }

          onDeleteDeck(deleteDeckTarget.id)
          setDeleteDeckTarget(null)
        }}
      />
    </div>
  )
}

function ResourceIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-(--ui-bg-quaternary) text-(--ui-text-tertiary)">
      {children}
    </span>
  )
}

function MindmapRow({ mindmap, onOpen }: { mindmap: MindmapFile; onOpen: () => void }) {
  return (
    <div className="flex w-full items-center gap-3 px-3 py-2.5">
      <ResourceIcon>
        <IconSitemap size={15} />
      </ResourceIcon>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{mindmap.title}</div>
        <div className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">Mind map · visual outline</div>
      </div>

      <span className="hidden w-40 shrink-0 text-right text-xs text-muted-foreground sm:block">Visual outline</span>

      <Button onClick={onOpen} size="sm" variant="outline">
        Open
      </Button>
    </div>
  )
}

function TestRow({ attempts, onStart, test }: { attempts: TestAttempt[]; onStart: () => void; test: TestFile }) {
  const best = bestAttempt(attempts)
  const last = lastAttempt(attempts)
  const count = test.questions.length

  return (
    <div className="flex w-full items-center gap-3 px-3 py-2.5">
      <ResourceIcon>
        <IconChecklist size={15} />
      </ResourceIcon>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{test.title}</div>
        <div className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
          {count} question{count === 1 ? '' : 's'}
          {best ? ` · best ${best.score}/${best.total}` : ''}
        </div>
      </div>

      <span className="hidden w-40 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
        {last ? `Test ${last.score}/${last.total}` : 'Not taken yet'}
      </span>

      <Button onClick={onStart} size="sm" variant="outline">
        {last ? 'Retake' : 'Start'}
      </Button>
    </div>
  )
}

function DuePill({ due }: { due: number }) {
  return (
    <span className="shrink-0 rounded-full bg-(--theme-primary)/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-(--theme-primary)">
      {due} due
    </span>
  )
}

const RETENTION_DAY_MS = 24 * 60 * 60 * 1000

function RetentionSparkline({ curve, now }: { curve: RetentionPoint[]; now: Date }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [inspecting, setInspecting] = useState(false)

  if (!curve.length) {
    return (
      <div>
        <svg aria-hidden="true" className="h-9 w-full" preserveAspectRatio="none" viewBox="0 0 100 40">
          <line
            stroke="var(--ui-stroke-secondary)"
            strokeDasharray="3 4"
            strokeLinecap="round"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            x1="2"
            x2="98"
            y1="12"
            y2="28"
          />
        </svg>
        <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
          <span className="font-medium text-foreground">No recall estimate yet</span>
          <span> · Review a card to begin</span>
        </p>
      </div>
    )
  }

  const finalDay = curve.at(-1)?.day ?? 1
  const coordinates = curve.map(point => {
    const x = 2 + (point.day / Math.max(1, finalDay)) * 96
    const y = 4 + (1 - point.retention) * 30

    return [x, y] as const
  })
  const points = coordinates.map(([x, y]) => `${x},${y}`).join(' ')
  const first = curve[0]
  const last = curve.at(-1) ?? first
  const safeIndex = Math.min(activeIndex, curve.length - 1)
  const activePoint = curve[safeIndex]
  const [activeX, activeY] = coordinates[safeIndex]
  const activeDate = new Date(now.getTime() + activePoint.day * RETENTION_DAY_MS).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short'
  })
  const activeLabel = `${activeDate} · estimated recall ${Math.round(activePoint.retention * 100)}%`
  const tooltipTransform =
    activeX < 22
      ? 'translate(0, calc(-100% - 8px))'
      : activeX > 78
        ? 'translate(-100%, calc(-100% - 8px))'
        : 'translate(-50%, calc(-100% - 8px))'

  return (
    <div
      aria-label={`${Math.round(first.retention * 100)}% recall now. Projected ${Math.round(last.retention * 100)}% in ${finalDay} days. Use the arrow keys to inspect the curve.`}
      className="relative outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onBlur={() => setInspecting(false)}
      onFocus={() => setInspecting(true)}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
          return
        }

        event.preventDefault()
        setInspecting(true)
        setActiveIndex(index =>
          event.key === 'ArrowLeft'
            ? Math.max(0, index - 1)
            : Math.min(curve.length - 1, index + 1)
        )
      }}
      onPointerLeave={event => {
        if (document.activeElement !== event.currentTarget) {
          setInspecting(false)
        }
      }}
      onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))

        setActiveIndex(Math.round(ratio * (curve.length - 1)))
        setInspecting(true)
      }}
      role="img"
      tabIndex={0}
    >
      <svg aria-hidden="true" className="h-9 w-full" preserveAspectRatio="none" viewBox="0 0 100 40">
        <polyline
          fill="none"
          points={points}
          stroke="var(--ui-stroke-secondary)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        {inspecting && (
          <>
            <line
              stroke="var(--ui-text-secondary)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              x1={activeX - 3}
              x2={activeX + 3}
              y1={activeY}
              y2={activeY}
            />
            <line
              stroke="var(--ui-text-secondary)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              x1={activeX}
              x2={activeX}
              y1={activeY - 3}
              y2={activeY + 3}
            />
          </>
        )}

        <circle
          cx={coordinates[coordinates.length - 1][0]}
          cy={coordinates[coordinates.length - 1][1]}
          fill="var(--theme-primary)"
          r="1.7"
        />
      </svg>

      {inspecting && (
        <span
          className="pointer-events-none absolute z-20 whitespace-nowrap bg-foreground px-1.5 py-1 text-[11px] font-bold leading-none text-background"
          style={{
            left: `${activeX}%`,
            top: `${(activeY / 40) * 100}%`,
            transform: tooltipTransform
          }}
        >
          {activeLabel}
        </span>
      )}

      <Tip label="FSRS estimate based on cards you’ve reviewed in this deck." side="bottom">
        <p className="mt-0.5 cursor-help text-[0.6875rem] tabular-nums">
          <span className="font-semibold text-foreground">{Math.round(first.retention * 100)}% recall now</span>
          <span className="text-muted-foreground">
            {' '}
            · Projected {Math.round(last.retention * 100)}% in {finalDay} days
          </span>
        </p>
      </Tip>
    </div>
  )
}

function DeckActionsMenu({
  deck,
  onBrowse,
  onDelete,
  onMatch,
  onMove,
  sections,
  total
}: {
  deck: StudyDeck
  onBrowse: () => void
  onDelete: () => void
  onMatch: () => void
  onMove: (section: string) => void
  sections: string[]
  total: number
}) {
  const currentSection =
    !deck.course?.trim() || deck.course.trim().toLocaleLowerCase() === 'other' ? 'Other' : deck.course.trim()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={`More actions for ${deck.name}`} size="icon-xs" variant="ghost">
          <IconDots />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onBrowse}>Cards</DropdownMenuItem>
        <DropdownMenuItem disabled={total < 2} onSelect={onMatch}>
          Match
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to section</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            {sections.map(section => (
              <DropdownMenuItem
                disabled={section.toLocaleLowerCase() === currentSection.toLocaleLowerCase()}
                key={section}
                onSelect={() => onMove(section)}
              >
                <span className="min-w-0 flex-1 truncate">{section}</span>
                {section.toLocaleLowerCase() === currentSection.toLocaleLowerCase() && (
                  <span className="text-muted-foreground">✓</span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              disabled={currentSection === 'Other'}
              onSelect={() => onMove('')}
            >
              <span className="min-w-0 flex-1">Other</span>
              {currentSection === 'Other' && <span className="text-muted-foreground">✓</span>}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={onDelete} variant="destructive">
          Delete deck
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeckRow({
  curve,
  deck,
  now,
  onBrowse,
  onDelete,
  onMatch,
  onMove,
  onStudy,
  sections,
  state
}: {
  curve: RetentionPoint[]
  deck: StudyDeck
  now: Date
  onBrowse: (deckId: string) => void
  onDelete: () => void
  onMatch: (deckId: string) => void
  onMove: (section: string) => void
  onStudy: (deckId: string) => void
  sections: string[]
  state: StudyState
}) {
  const stats = deckStats(state, deck.id, now)

  return (
    <div className="flex w-full items-center gap-3 px-3 py-2.5">
      <ResourceIcon>
        <IconCards size={15} />
      </ResourceIcon>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{deck.name}</span>
          {stats.due > 0 && <DuePill due={stats.due} />}
        </div>
        <p className="mt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground">
          {stats.total} card{stats.total === 1 ? '' : 's'} · {stats.fresh} new
        </p>
      </div>

      <div className="hidden w-52 shrink-0 lg:block">
        <RetentionSparkline curve={curve} now={now} />
      </div>

      <Button onClick={() => onStudy(deck.id)} size="sm" variant="outline">
        Study
      </Button>

      <DeckActionsMenu
        deck={deck}
        onBrowse={() => onBrowse(deck.id)}
        onDelete={onDelete}
        onMatch={() => onMatch(deck.id)}
        onMove={onMove}
        sections={sections}
        total={stats.total}
      />
    </div>
  )
}

function DeckCard({
  curve,
  deck,
  now,
  onBrowse,
  onDelete,
  onMatch,
  onMove,
  onStudy,
  sections,
  state
}: {
  curve: RetentionPoint[]
  deck: StudyDeck
  now: Date
  onBrowse: (deckId: string) => void
  onDelete: () => void
  onMatch: (deckId: string) => void
  onMove: (section: string) => void
  onStudy: (deckId: string) => void
  sections: string[]
  state: StudyState
}) {
  const stats = deckStats(state, deck.id, now)

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4">
      <div className="flex items-start gap-2.5">
        <ResourceIcon>
          <IconCards size={15} />
        </ResourceIcon>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{deck.name}</h3>
          <p className="mt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground">
            {stats.total} card{stats.total === 1 ? '' : 's'} · {stats.fresh} new
          </p>
        </div>
        {stats.due > 0 && <DuePill due={stats.due} />}
      </div>

      <RetentionSparkline curve={curve} now={now} />

      <div className="mt-auto flex items-center justify-end gap-1">
        <Button onClick={() => onStudy(deck.id)} size="sm" variant="outline">
          Study
        </Button>
        <DeckActionsMenu
          deck={deck}
          onBrowse={() => onBrowse(deck.id)}
          onDelete={onDelete}
          onMatch={() => onMatch(deck.id)}
          onMove={onMove}
          sections={sections}
          total={stats.total}
        />
      </div>
    </div>
  )
}

function DeleteDeckDialog({
  deck,
  onClose,
  onConfirm
}: {
  deck: StudyDeck | null
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog onOpenChange={open => !open && onClose()} open={Boolean(deck)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete deck?</DialogTitle>
          <DialogDescription>
            {deck ? `“${deck.name}” and its local review schedule will be removed.` : 'This deck will be removed.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button onClick={onConfirm} variant="destructive">
            Delete deck
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Contribution grid of review activity with streak stats, month labels, hover tooltips,
// legend, and a today marker.
const HEAT_MIX = ['', '14%', '24%', '38%', '54%']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function heatColor(level: number): string {
  return level === 0
    ? 'color-mix(in srgb, var(--ui-text-primary) 8%, transparent)'
    : `color-mix(in srgb, var(--ui-text-primary) ${HEAT_MIX[level]}, transparent)`
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
  const [expanded, setExpanded] = useState(false)
  const todayIso = new Date().toISOString()
  const { cells, total } = useMemo(() => reviewHeatmap(state, todayIso), [state, todayIso])
  const stats = useMemo(() => studyMotivation(state, todayIso), [state, todayIso])
  const todayKey = todayIso.slice(0, 10)
  const firstDayOffset = cells[0] ? new Date(`${cells[0].date}T00:00:00.000Z`).getUTCDay() : 0
  const weeks = Math.ceil((firstDayOffset + cells.length) / 7)
  const daysIntoWeek = new Date(`${todayKey}T00:00:00.000Z`).getUTCDay() + 1
  const reviewsThisWeek = cells
    .slice(-daysIntoWeek)
    .reduce((sum, cell) => sum + cell.count, 0)

  const monthLabels: { col: number; label: string }[] = []
  if (cells[0]) {
    monthLabels.push({ col: 0, label: MONTHS[Number(cells[0].date.slice(5, 7)) - 1] })

    for (let index = 1; index < cells.length; index++) {
      const cell = cells[index]

      if (cell.date.endsWith('-01')) {
        monthLabels.push({
          col: Math.floor((firstDayOffset + index) / 7),
          label: MONTHS[Number(cell.date.slice(5, 7)) - 1]
        })
      }
    }
  }

  return (
    <section className="px-8 pb-2 pt-8">
      <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)">
        <button
          aria-expanded={expanded}
          className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setExpanded(value => !value)}
          type="button"
        >
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Review history</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.6875rem] tabular-nums text-muted-foreground">
              <span>{stats.currentStreak} day streak</span>
              <span aria-hidden="true">·</span>
              <span>{stats.retentionPct === null ? '—' : `${stats.retentionPct}%`} 30-day retention</span>
              <span aria-hidden="true">·</span>
              <span>{reviewsThisWeek} reviews this week</span>
            </p>
          </div>
          <IconChevronDown
            aria-hidden="true"
            className={cn('shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90')}
            size={15}
          />
        </button>

        {expanded && (
          <div className="border-t border-(--ui-stroke-tertiary) px-4 pb-4 pt-3">
            <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs">
              <Stat label="longest streak" value={stats.longestStreak} />
              <Stat label="days active" value={`${stats.daysLearnedPct}%`} />
              <span className="text-muted-foreground">{total} reviews · past 12 months</span>
            </div>

            {total === 0 && (
              <p className="mb-3 text-xs text-muted-foreground">Your history fills in as you grade cards.</p>
            )}

            <div className="overflow-x-auto pb-1">
              <div className="min-w-max">
                <div className="grid grid-cols-[2rem_auto] gap-x-2 gap-y-1">
                  <div />
                  <div className="relative h-3 text-[9px] text-muted-foreground" style={{ width: `${weeks * 14}px` }}>
                    {monthLabels.map(month => (
                      <span
                        className="absolute"
                        key={`${month.label}-${month.col}`}
                        style={{ left: `${month.col * 14}px` }}
                      >
                        {month.label}
                      </span>
                    ))}
                  </div>

                  <div
                    className="grid grid-rows-7 gap-[3px] text-[9px] leading-[11px] text-muted-foreground"
                    style={{ gridTemplateRows: 'repeat(7, 11px)' }}
                  >
                    {WEEKDAYS.map(day => (
                      <span key={day}>{day}</span>
                    ))}
                  </div>

                  <div
                    className="grid grid-flow-col grid-rows-7 gap-[3px]"
                    style={{ gridAutoColumns: '11px', gridTemplateRows: 'repeat(7, 11px)' }}
                  >
                    {Array.from({ length: firstDayOffset }, (_, index) => (
                      <span aria-hidden="true" key={`leading-${index}`} />
                    ))}
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
                </div>

                <div className="mt-2 flex items-center justify-end gap-1 text-[9px] text-muted-foreground">
                  <span>Less</span>
                  {[0, 1, 2, 3, 4].map(level => (
                    <span
                      className="size-2.5 rounded-[2px]"
                      key={level}
                      style={{ backgroundColor: heatColor(level) }}
                    />
                  ))}
                  <span>More</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function CardBrowser({
  deck,
  onChange,
  onDeleteDeck,
  onMatch,
  onMoveDeck,
  sections,
  state
}: {
  deck: null | StudyDeck
  onChange: (next: StudyState) => void
  onDeleteDeck: () => void
  onMatch: () => void
  onMoveDeck: (section: string) => void
  sections: string[]
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
      <div className="mb-2 flex items-center justify-between gap-3 border-b border-border pb-1.5">
        <div>
          <h2 className="text-sm font-semibold">{deck.name}</h2>
          <p className="text-xs text-muted-foreground">
            {deck.course ? `${deck.course} · ` : ''}
            {deck.cards.length} card{deck.cards.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="w-40">
            <SectionSelect
              label="Move deck to section"
              onChange={onMoveDeck}
              sections={sections}
              value={deck.course ?? ''}
            />
          </div>
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
                  className={cn(
                    'cursor-pointer border-t border-border hover:bg-accent',
                    card.suspended && 'opacity-45'
                  )}
                  key={card.id}
                  onClick={() => setEditing(card)}
                >
                  <td className="max-w-xs truncate px-3 py-2">
                    {card.suspended && (
                      <IconPlayerPause className="-mt-px mr-1 inline text-muted-foreground" size={12} />
                    )}
                    {card.front}
                  </td>
                  <td className="hidden max-w-xs truncate px-3 py-2 text-muted-foreground md:table-cell">
                    {card.back}
                  </td>
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
          <Textarea
            className="min-h-20"
            onChange={event => setFront(event.target.value)}
            placeholder="Front"
            value={front}
          />
          <Textarea
            className="min-h-20"
            onChange={event => setBack(event.target.value)}
            placeholder="Back"
            value={back}
          />
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
                tags: tags
                  .split(',')
                  .map(tag => tag.trim())
                  .filter(Boolean)
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
          <Textarea
            className="min-h-20"
            onChange={event => setFront(event.target.value)}
            placeholder="Front"
            value={front}
          />
          <Textarea
            className="min-h-20"
            onChange={event => setBack(event.target.value)}
            placeholder="Back"
            value={back}
          />
          <Input onChange={event => setTags(event.target.value)} placeholder="Tags (comma-separated)" value={tags} />
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!front.trim() || !back.trim()}
            onClick={() =>
              onCreate(
                front.trim(),
                back.trim(),
                tags
                  .split(',')
                  .map(tag => tag.trim())
                  .filter(Boolean)
              )
            }
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
                  'flex items-center justify-center rounded-lg border p-3 text-center text-sm leading-snug transition-[transform,opacity,border-color,background-color] duration-200 ease-out active:scale-[0.98]',
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
  activeCategory,
  flip,
  intervals,
  item,
  onGrade,
  onReveal,
  position,
  remainingCounts,
  revealed,
  sessionTotal,
  showIntervalHints
}: {
  activeCategory: ReviewCategory
  flip: boolean
  intervals: Record<StudyRating, string>
  item: QueueItem
  onGrade: (rating: StudyRating) => void
  onReveal: () => void
  position: number
  remainingCounts: ReviewCategoryCounts
  revealed: boolean
  sessionTotal: number
  showIntervalHints: boolean
}) {
  const countItems: { category: ReviewCategory; label: string; value: number }[] = [
    { category: 'new', label: 'New', value: remainingCounts.new },
    { category: 'learning', label: 'Learning', value: remainingCounts.learning },
    { category: 'review', label: 'Review', value: remainingCounts.review }
  ]

  return (
    <div className="flex flex-1 flex-col items-center px-6 pb-8">
      <div className="flex w-full max-w-2xl flex-1 flex-col">
        <div className="flex items-center justify-between gap-4 pb-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {item.deckName}
            {item.isNew && (
              <Badge className="ml-2" variant="outline">
                new
              </Badge>
            )}
          </span>

          <div className="flex shrink-0 items-center gap-4">
            <span className="tabular-nums">
              {position} of {sessionTotal}
            </span>

            <span
              aria-label="Cards remaining"
              className="flex items-center gap-3 text-[0.6875rem] tabular-nums"
            >
              {countItems.map(count => (
                <span className="flex items-center gap-1.5" key={count.category}>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-1 rounded-full bg-(--ui-stroke-secondary)',
                      activeCategory === count.category && 'bg-(--theme-primary)'
                    )}
                  />
                  <span>
                    <span className="font-medium text-foreground">{count.value}</span> {count.label}
                  </span>
                </span>
              ))}
            </span>
          </div>
        </div>

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
              <div className="pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                Question
              </div>
              <div className="text-lg leading-relaxed">{item.card.front}</div>
            </div>
            {revealed && (
              <>
                <div className="border-t border-border" />
                <div>
                  <div className="pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                    Answer
                  </div>
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
                  className={cn(
                    'flex-col gap-0.5 py-5',
                    option.rating === 'again' && 'text-(--theme-primary)'
                  )}
                  key={option.rating}
                  onClick={() => onGrade(option.rating)}
                  variant="secondary"
                >
                  <span>{option.label}</span>
                  {showIntervalHints && (
                    <span className="text-[10px] opacity-60">
                      {intervals[option.rating]} · {option.key}
                    </span>
                  )}
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
  open,
  sections
}: {
  onImport: (name: string, course: string, text: string) => boolean
  onOpenChange: (open: boolean) => void
  open: boolean
  sections: string[]
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
          <div className="space-y-1.5">
            <label className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              Section
            </label>
            <SectionSelect label="Imported deck section" onChange={setCourse} sections={sections} value={course} />
          </div>
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
