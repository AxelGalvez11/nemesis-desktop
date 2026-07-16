// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import {
  IconArrowLeft,
  IconCards,
  IconChecklist,
  IconChevronDown,
  IconDots,
  IconFileImport,
  IconFolderPlus,
  IconPencil,
  IconPlayerPause,
  IconPlus,
  IconSettings,
  IconSitemap,
  IconSparkles,
  IconTrash
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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
import { renameDesktopPath } from '@/lib/desktop-fs'
import { cn } from '@/lib/utils'
import { setComposerDraft } from '@/store/composer'

import { NEW_CHAT_ROUTE } from '../routes'

import { hasClozeMarker, renderClozeAnswer, renderClozePrompt } from './cloze'
import { DECK_DIR, importedDeckFileNames, scanAllDeckFiles } from './deck-files'
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
  DEFAULT_STUDY_SETTINGS,
  deleteCard,
  deleteDeck,
  deleteSection,
  freshId,
  getSettings,
  gradeCard,
  type GradeUndo,
  groupDecks,
  LEECH_TAG,
  loadState,
  localDayKey,
  previewIntervals,
  type QueueItem,
  reconcileDeckFiles,
  renameDeck,
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
  undoLastGrade,
  updateCard
} from './model'
import { TestSurface } from './test-mode'

const GRADES: { key: string; label: string; rating: StudyRating }[] = [
  { key: '1', label: 'Again', rating: 'again' },
  { key: '2', label: 'Hard', rating: 'hard' },
  { key: '3', label: 'Good', rating: 'good' },
  { key: '4', label: 'Easy', rating: 'easy' }
]

/** Top-level Study lanes: flashcard decks, practice tests, mind maps. */
type StudyTab = 'cards' | 'maps' | 'tests'

const TAB_KEY = 'nemesis.study.tab.v1'
const COLLAPSED_SECTIONS_KEY = 'nemesis.study.sections.collapsed.v1'

const STUDY_TABS: { icon: React.ReactNode; id: StudyTab; label: string }[] = [
  { icon: <IconCards size={13} />, id: 'cards', label: 'Cards' },
  { icon: <IconChecklist size={13} />, id: 'tests', label: 'Tests' },
  { icon: <IconSitemap size={13} />, id: 'maps', label: 'Mind maps' }
]

const ORDER_OPTIONS: SegmentedControlOption<ReviewOrder>[] = [
  { id: 'due', label: 'Due first' },
  { id: 'random', label: 'Random' }
]

// FSRS request_retention choices (see StudySettings.desiredRetention). Values
// are stringified for the Select; String(0.9) round-trips exactly.
const RETENTION_OPTIONS: { label: string; value: string }[] = [
  { label: '80%', value: '0.8' },
  { label: '85%', value: '0.85' },
  { label: '90% (default)', value: '0.9' },
  { label: '95%', value: '0.95' }
]

/** "3 cards reviewed — 2 Good · 1 Again." for the end-of-session recap. */
function sessionRecapLine(done: number, grades: Record<StudyRating, number>): string {
  const parts = GRADES.filter(option => grades[option.rating] > 0)
    .map(option => `${grades[option.rating]} ${option.label}`)
    .join(' · ')

  return `${done} card${done === 1 ? '' : 's'} reviewed${parts ? ` — ${parts}` : ''}.`
}

function zeroSessionGrades(): Record<StudyRating, number> {
  return { again: 0, easy: 0, good: 0, hard: 0 }
}

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

  const cardState = state.schedule[item.scheduleKey]?.state

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

function loadTab(): StudyTab {
  try {
    const stored = window.localStorage.getItem(TAB_KEY)

    return stored === 'tests' || stored === 'maps' ? stored : 'cards'
  } catch {
    return 'cards'
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
  const [tab, setTab] = useState<StudyTab>(() => loadTab())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => loadCollapsedSections())
  const [reducedMotion] = useState(() => prefersReducedMotion())
  const [matchDeckId, setMatchDeckId] = useState<null | string>(null)
  const [done, setDone] = useState(0)
  const [sessionTotal, setSessionTotal] = useState(0)
  // Session-only (deliberately unpersisted): the pre-grade snapshot for Undo
  // and the per-grade tallies for the end-of-session recap.
  const [lastUndo, setLastUndo] = useState<null | (GradeUndo & { rating: StudyRating })>(null)
  const [sessionGrades, setSessionGrades] = useState<Record<StudyRating, number>>(() => zeroSessionGrades())
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
      setLastUndo(null)
      setSessionGrades(zeroSessionGrades())
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

      // Snapshot BEFORE grading so Undo can restore the exact schedule entry
      // (or its absence, for a never-studied card).
      const previous = state.schedule[current.scheduleKey]

      setLastUndo({ rating, scheduleKey: current.scheduleKey, ...(previous ? { previous } : {}) })
      setSessionGrades(counts => ({ ...counts, [rating]: counts[rating] + 1 }))
      update(gradeCard(state, current.scheduleKey, rating, new Date()))
      setRevealed(false)
      setDone(count => count + 1)
    },
    [current, state, update]
  )

  const undoGrade = useCallback(() => {
    if (!lastUndo) {
      return
    }

    update(undoLastGrade(state, lastUndo))
    setSessionGrades(counts => ({ ...counts, [lastUndo.rating]: Math.max(0, counts[lastUndo.rating] - 1) }))
    setDone(count => Math.max(0, count - 1))
    setLastUndo(null)
    setRevealed(false)
  }, [lastUndo, state, update])

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

      // Anki's `u`: take back the last grade (only while a next card is shown).
      if (event.key === 'u' && lastUndo) {
        event.preventDefault()
        undoGrade()

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
  }, [current, exitReview, grade, lastUndo, revealed, reviewing, undoGrade])

  const switchTab = useCallback((next: StudyTab) => {
    setTab(next)

    try {
      window.localStorage.setItem(TAB_KEY, next)
    } catch {
      // persistence is best-effort
    }
  }, [])

  const navigate = useNavigate()

  // The page's one ambient line to the agent: optionally pre-fill the chat
  // composer with a study task, then jump to chat. (Same pattern Today uses.)
  const askAgent = useCallback(
    (draft?: string) => {
      if (draft) {
        setComposerDraft(draft)
      }

      navigate(NEW_CHAT_ROUTE)
    },
    [navigate]
  )

  // Anki-style per-deck NEW/LEARN/DUE — bucketed from the same capped queue the
  // "Start review" button studies, so the numbers always agree with the session.
  const queueCountsByDeck = useMemo(() => {
    const counts = new Map<string, ReviewCategoryCounts>()

    for (const item of todayQueue) {
      const bucket = counts.get(item.deckId) ?? { learning: 0, new: 0, review: 0 }
      bucket[categoryForQueueItem(item, state)]++
      counts.set(item.deckId, bucket)
    }

    return counts
  }, [state, todayQueue])

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

  const renameBrowsedDeck = useCallback(
    async (name: string) => {
      const deck = state.decks.find(candidate => candidate.id === browseDeckId)

      if (!deck || deck.name === name) {
        return
      }

      if (!deck.sourceFile) {
        update(renameDeck(state, deck.id, name))

        return
      }

      // File-backed deck: rename the vault file FIRST — reconcile relinks by
      // file name, so state only changes once the disk rename succeeded. A
      // thrown IPC error surfaces in the dialog and the old name stands.
      const extension = deck.sourceFile.match(/\.(tsv|txt|md)$/i)?.[0] ?? '.tsv'
      const fileName = `${name}${extension}`

      await renameDesktopPath(`${DECK_DIR}/${deck.sourceFile}`, fileName)
      update(renameDeck(state, deck.id, name, fileName))
    },
    [browseDeckId, state, update]
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

  const inSubSurface = Boolean(browseDeckId || matchDeckId)

  // Taking a test is fullscreen, same as reviewing a deck: no header, no tabs.
  // TestSurface carries its own back button, progress bar, and Esc handling.
  if (takingTest) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <TestSurface
          file={takingTest}
          onComplete={() => setTestAttempts(loadTestAttempts())}
          onExit={() => setTakingTest(null)}
        />
      </div>
    )
  }

  // Entering a deck is fullscreen: the whole page becomes the card — no header,
  // no tabs, nothing but the review. Esc (or the back button) returns.
  if (reviewing && current) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <ReviewSurface
          activeCategory={categoryForQueueItem(current, state)}
          flip={flip}
          intervals={previewIntervals(state, current.scheduleKey, now)}
          item={current}
          onExit={exitReview}
          onGrade={grade}
          onReveal={() => setRevealed(true)}
          onUndo={lastUndo ? undoGrade : null}
          position={Math.min(done + 1, sessionTotal)}
          progress={sessionTotal > 0 ? done / sessionTotal : 0}
          remainingCounts={remainingCounts}
          revealed={revealed}
          sessionTotal={sessionTotal}
          showIntervalHints={settings.showIntervalHints}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex shrink-0 items-start justify-between gap-3 px-6 pb-3 pt-5">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Study</h1>
          <p className="mt-0.5 text-[0.65rem] font-medium tabular-nums text-(--ui-text-tertiary)">
            {totals.due} due · {totals.fresh} new · {totals.total} cards
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {inSubSurface || reviewing ? (
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
              <Button onClick={() => askAgent()} size="sm" variant="outline">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-(--theme-primary)" />
                Ask the agent
              </Button>

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

      {!inSubSurface && !reviewing && (
        <nav aria-label="Study sections" className="mx-6 mb-3 flex items-center gap-1 border-b border-(--ui-stroke-tertiary)">
          {STUDY_TABS.map(option => {
            const count =
              option.id === 'cards' ? todayQueue.length : option.id === 'tests' ? tests.length : mindmaps.length

            return (
              <button
                aria-current={tab === option.id ? 'page' : undefined}
                className={cn(
                  'relative -mb-px flex items-center gap-1.5 border-b-2 border-transparent px-2.5 pb-2 pt-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                  tab === option.id && 'border-(--theme-primary) text-foreground'
                )}
                key={option.id}
                onClick={() => switchTab(option.id)}
                type="button"
              >
                {option.icon}
                {option.label}
                {count > 0 && <span className="tabular-nums text-(--ui-text-quaternary)">{count}</span>}
              </button>
            )
          })}
        </nav>
      )}

      {tab === 'cards' && !inSubSurface && !reviewing && (
        <TodaysReviewBrief
          counts={todayCounts}
          estimatedMinutes={estimatedReviewMinutes}
          hasScheduledDue={scheduledDue > 0}
          onStart={() => startReview(null)}
          total={todayQueue.length}
        />
      )}

      {autoImported.length > 0 && !reviewing && !browseDeckId && tab === 'cards' && (
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
        <EmptyState
          className="flex-1"
          description={
            done > 0
              ? `${sessionRecapLine(done, sessionGrades)} Come back when the next ones are due.`
              : 'Nothing is due right now.'
          }
          title="All caught up"
        />
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
          onRename={renameBrowsedDeck}
          sections={sections}
          state={state}
        />
      ) : tab === 'cards' ? (
        <>
          <div className="mx-6 mb-1 flex items-center gap-4">
            <Button onClick={() => setNewDeckSection('')} size="inline" variant="text">
              <IconPlus size={13} />
              New deck
            </Button>
            <Button onClick={() => setImportOpen(true)} size="inline" variant="text">
              <IconFileImport size={13} />
              Import
            </Button>
            <Button onClick={() => setNewSectionOpen(true)} size="inline" variant="text">
              <IconFolderPlus size={13} />
              New section
            </Button>
          </div>
          <DeckBrowser
            collapsedSections={collapsedSections}
            onBrowse={setBrowseDeckId}
            onCreateDeck={setNewDeckSection}
            onDeleteDeck={removeDeck}
            onDeleteSection={course => update(deleteSection(state, course))}
            onMatch={startMatch}
            onMoveDeck={moveDeck}
            onStudy={startReview}
            onToggleSection={toggleSection}
            queueCounts={queueCountsByDeck}
            state={state}
          />
        </>
      ) : tab === 'tests' ? (
        <TestsBrowser
          collapsedSections={collapsedSections}
          mindmaps={mindmaps}
          onAskAgent={askAgent}
          onStartTest={setTakingTest}
          onToggleSection={toggleSection}
          state={state}
          testAttempts={testAttempts}
          tests={tests}
        />
      ) : (
        <MindmapsBrowser
          collapsedSections={collapsedSections}
          mindmaps={mindmaps}
          onAskAgent={askAgent}
          onOpenMindmap={setViewingMindmap}
          onToggleSection={toggleSection}
          state={state}
          tests={tests}
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
          placeholder="Section name (e.g. Microeconomics)"
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

function RenameDeckDialog({
  deck,
  onClose,
  onRename
}: {
  deck: StudyDeck
  onClose: () => void
  onRename: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(deck.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const trimmed = name.trim()

  const submit = async () => {
    if (!trimmed || busy) {
      return
    }

    if (trimmed === deck.name) {
      onClose()

      return
    }

    setBusy(true)
    setError(null)

    try {
      await onRename(trimmed)
      onClose()
    } catch (err) {
      // Nothing changed (the file rename failed first) — keep the old name.
      setError(err instanceof Error ? err.message : 'Could not rename the deck.')
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={open => !open && !busy && onClose()} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename deck</DialogTitle>
          <DialogDescription>
            {deck.sourceFile
              ? `Also renames “${deck.sourceFile}” in your Flashcards folder, so the agent keeps this deck in sync.`
              : 'Review progress stays with the deck.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          onChange={event => setName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              void submit()
            }
          }}
          placeholder="Deck name"
          value={name}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button disabled={!trimmed || busy} onClick={() => void submit()}>
            {busy ? 'Renaming…' : 'Rename'}
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
          <SettingRow
            description="Recall chance targeted when a card comes due. Higher = shorter intervals, more reviews."
            label="Target retention"
          >
            <Select
              onValueChange={value => onChange({ desiredRetention: Number(value) })}
              value={String(settings.desiredRetention)}
            >
              <SelectTrigger aria-label="Target retention" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETENTION_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

/** Shared grid for the Anki-style deck table: name | New | Learn | Due | row menu. */
const DECK_GRID = 'grid grid-cols-[minmax(0,1fr)_3.25rem_3.25rem_3.25rem_2.25rem] items-center gap-x-2'

const ZERO_COUNTS: ReviewCategoryCounts = { learning: 0, new: 0, review: 0 }

function CountCell({ tone, value }: { tone: ReviewCategory; value: number }) {
  return (
    <span
      className={cn(
        'text-right text-xs tabular-nums',
        value === 0
          ? 'text-(--ui-text-quaternary)'
          : tone === 'review'
            ? 'font-semibold text-(--theme-primary)'
            : tone === 'learning'
              ? 'text-foreground'
              : 'text-muted-foreground'
      )}
    >
      {value}
    </span>
  )
}

function DeckColumnHeader() {
  return (
    <div className={cn(DECK_GRID, 'px-3 pb-1')}>
      <span />
      {(['New', 'Learn', 'Due'] as const).map(label => (
        <span
          className="text-right text-[0.6rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)"
          key={label}
        >
          {label}
        </span>
      ))}
      <span />
    </div>
  )
}

function DeckBrowser({
  collapsedSections,
  onBrowse,
  onCreateDeck,
  onDeleteDeck,
  onDeleteSection,
  onMatch,
  onMoveDeck,
  onStudy,
  onToggleSection,
  queueCounts,
  state
}: {
  collapsedSections: Set<string>
  onBrowse: (deckId: string) => void
  onCreateDeck: (section: string) => void
  onDeleteDeck: (deckId: string) => void
  onDeleteSection: (course: string) => void
  onMatch: (deckId: string) => void
  onMoveDeck: (deckId: string, section: string) => void
  onStudy: (deckId: string) => void
  onToggleSection: (course: string) => void
  /** Per-deck NEW/LEARN/DUE from today's capped queue (see queueCountsByDeck). */
  queueCounts: Map<string, ReviewCategoryCounts>
  state: StudyState
}) {
  const [deleteDeckTarget, setDeleteDeckTarget] = useState<StudyDeck | null>(null)
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<null | string>(null)

  const now = useMemo(() => new Date(), [state])
  const groups = groupDecks(state, now)

  if (!groups.length) {
    return (
      <EmptyState className="flex-1" description="Create a deck or import cards to get going." title="No decks yet" />
    )
  }

  return (
    <div className="pb-10">
      <div className="px-8 pt-3">
        <DeckColumnHeader />
      </div>

      {groups.map(group => {
        const isCollapsed = collapsedSections.has(group.course)
        const rollup = group.decks.reduce<ReviewCategoryCounts>(
          (sum, deck) => {
            const counts = queueCounts.get(deck.id) ?? ZERO_COUNTS

            return {
              learning: sum.learning + counts.learning,
              new: sum.new + counts.new,
              review: sum.review + counts.review
            }
          },
          { learning: 0, new: 0, review: 0 }
        )

        return (
          <section className="px-8 pt-3" key={group.course}>
            <div className={cn(DECK_GRID, 'group/section rounded-md px-3 py-1.5')}>
              <h2 className="min-w-0 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <button
                  aria-expanded={!isCollapsed}
                  className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => onToggleSection(group.course)}
                  type="button"
                >
                  <IconChevronDown
                    aria-hidden="true"
                    className={cn('shrink-0 transition-transform', isCollapsed && '-rotate-90')}
                    size={13}
                  />
                  <span className="truncate">{group.course}</span>
                  <span className="font-normal normal-case tracking-normal text-(--ui-text-quaternary)">
                    {group.decks.length} deck{group.decks.length === 1 ? '' : 's'}
                  </span>
                </button>
              </h2>
              <CountCell tone="new" value={rollup.new} />
              <CountCell tone="learning" value={rollup.learning} />
              <CountCell tone="review" value={rollup.review} />
              <span className="flex justify-end">
                {group.course.toLocaleLowerCase() !== 'other' && (
                  <button
                    aria-label={`Delete section ${group.course}`}
                    className="rounded-sm p-0.5 text-muted-foreground/70 opacity-0 outline-none transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/section:opacity-100"
                    onClick={() => setDeleteSectionTarget(group.course)}
                    title="Delete section"
                    type="button"
                  >
                    <IconTrash size={13} />
                  </button>
                )}
              </span>
            </div>

            {!isCollapsed &&
              (group.decks.length > 0 ? (
                <div className="divide-y divide-(--ui-stroke-quaternary) rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)">
                  {group.decks.map(deck => (
                    <DeckTableRow
                      counts={queueCounts.get(deck.id) ?? ZERO_COUNTS}
                      deck={deck}
                      key={deck.id}
                      onBrowse={onBrowse}
                      onDelete={() => setDeleteDeckTarget(deck)}
                      onMatch={onMatch}
                      onMove={section => onMoveDeck(deck.id, section)}
                      onStudy={onStudy}
                      sections={state.sections}
                    />
                  ))}
                </div>
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

      <ConfirmDialog
        confirmLabel="Delete section"
        description="The decks inside are kept — they move back to the ungrouped list."
        destructive
        dismissOnConfirm
        onClose={() => setDeleteSectionTarget(null)}
        onConfirm={() => {
          if (deleteSectionTarget) {
            onDeleteSection(deleteSectionTarget)
          }
        }}
        open={deleteSectionTarget !== null}
        title={`Delete "${deleteSectionTarget ?? ''}"?`}
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

/** Rough node count for a mind-map card: outline headings + bullets. */
function countOutlineNodes(outline: string): number {
  return outline.split('\n').filter(line => /^\s*(?:[-*+]|#{1,6})\s/.test(line)).length
}

function ExtrasSectionHeader({
  collapsed,
  course,
  meta,
  onToggle
}: {
  collapsed: boolean
  course: string
  meta: string
  onToggle: () => void
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-4">
      <h2 className="min-w-0 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        <button
          aria-expanded={!collapsed}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onToggle}
          type="button"
        >
          <IconChevronDown
            aria-hidden="true"
            className={cn('shrink-0 transition-transform', collapsed && '-rotate-90')}
            size={13}
          />
          <span className="truncate">{course}</span>
        </button>
      </h2>
      <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">{meta}</span>
    </div>
  )
}

/** Empty state with the one agent CTA these tabs earn — the agent authors this material. */
function AgentEmptyState({
  cta,
  description,
  onAsk,
  title
}: {
  cta: string
  description: string
  onAsk: () => void
  title: string
}) {
  return (
    <div className="grid flex-1 place-items-center px-6 py-16 text-center">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>
        <Button className="mt-4" onClick={onAsk} size="sm" variant="outline">
          <IconSparkles size={14} />
          {cta}
        </Button>
      </div>
    </div>
  )
}

function TestsBrowser({
  collapsedSections,
  mindmaps,
  onAskAgent,
  onStartTest,
  onToggleSection,
  state,
  testAttempts,
  tests
}: {
  collapsedSections: Set<string>
  mindmaps: MindmapFile[]
  onAskAgent: (draft?: string) => void
  onStartTest: (file: TestFile) => void
  onToggleSection: (course: string) => void
  state: StudyState
  testAttempts: TestAttemptsStore
  tests: TestFile[]
}) {
  const extrasByCourse = useMemo(
    () => groupExtras(state.sections, mindmaps, tests),
    [mindmaps, state.sections, tests]
  )

  const courses = [...extrasByCourse.entries()]
    .filter(([, extras]) => extras.tests.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))

  if (!courses.length) {
    return (
      <AgentEmptyState
        cta="Ask the agent for one"
        description="Practice tests live here, grouped by course. The agent builds them from your lectures and grades your attempts."
        onAsk={() =>
          onAskAgent(
            'Build me a practice test from my recent lectures — multiple choice with an explanation for every answer, saved to my Tests folder.'
          )
        }
        title="No practice tests yet"
      />
    )
  }

  return (
    <div className="pb-10">
      {courses.map(([course, extras]) => {
        const isCollapsed = collapsedSections.has(course)
        const bestPct = extras.tests.reduce<null | number>((best, test) => {
          const attempt = bestAttempt(testAttempts[test.fileName]?.attempts ?? [])

          if (!attempt || attempt.total === 0) {
            return best
          }

          const pct = Math.round((attempt.score / attempt.total) * 100)

          return best === null ? pct : Math.max(best, pct)
        }, null)

        return (
          <section className="px-8 pt-4" key={course}>
            <ExtrasSectionHeader
              collapsed={isCollapsed}
              course={course}
              meta={`${extras.tests.length} test${extras.tests.length === 1 ? '' : 's'}${bestPct === null ? '' : ` · best ${bestPct}%`}`}
              onToggle={() => onToggleSection(course)}
            />
            {!isCollapsed && (
              <div className="divide-y divide-(--ui-stroke-quaternary) rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)">
                {extras.tests.map(test => (
                  <TestRow
                    attempts={testAttempts[test.fileName]?.attempts ?? []}
                    key={test.fileName}
                    onStart={() => onStartTest(test)}
                    test={test}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function MindmapCard({ mindmap, onOpen }: { mindmap: MindmapFile; onOpen: () => void }) {
  const nodes = countOutlineNodes(mindmap.outline)

  return (
    <button
      className="flex flex-col items-start rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 text-left outline-none transition-colors hover:border-(--ui-stroke-secondary) focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={onOpen}
      type="button"
    >
      <IconSitemap className="text-(--ui-text-tertiary)" size={16} />
      <span className="mt-2 w-full truncate text-sm font-medium">{mindmap.title}</span>
      <span className="mt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground">
        {nodes} node{nodes === 1 ? '' : 's'} · opens the interactive map
      </span>
    </button>
  )
}

function MindmapsBrowser({
  collapsedSections,
  mindmaps,
  onAskAgent,
  onOpenMindmap,
  onToggleSection,
  state,
  tests
}: {
  collapsedSections: Set<string>
  mindmaps: MindmapFile[]
  onAskAgent: (draft?: string) => void
  onOpenMindmap: (file: MindmapFile) => void
  onToggleSection: (course: string) => void
  state: StudyState
  tests: TestFile[]
}) {
  const extrasByCourse = useMemo(
    () => groupExtras(state.sections, mindmaps, tests),
    [mindmaps, state.sections, tests]
  )

  const courses = [...extrasByCourse.entries()]
    .filter(([, extras]) => extras.mindmaps.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))

  if (!courses.length) {
    return (
      <AgentEmptyState
        cta="Ask the agent for one"
        description="Mind maps live here, grouped by course — the big picture of each topic as an interactive map the agent draws from your material."
        onAsk={() =>
          onAskAgent(
            'Build a mind map of the big picture from my recent lectures — a markdown outline saved to my Mindmaps folder.'
          )
        }
        title="No mind maps yet"
      />
    )
  }

  return (
    <div className="pb-10">
      {courses.map(([course, extras]) => {
        const isCollapsed = collapsedSections.has(course)
        const nodeTotal = extras.mindmaps.reduce((sum, mindmap) => sum + countOutlineNodes(mindmap.outline), 0)

        return (
          <section className="px-8 pt-4" key={course}>
            <ExtrasSectionHeader
              collapsed={isCollapsed}
              course={course}
              meta={`${extras.mindmaps.length} map${extras.mindmaps.length === 1 ? '' : 's'} · ${nodeTotal} nodes`}
              onToggle={() => onToggleSection(course)}
            />
            {!isCollapsed && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {extras.mindmaps.map(mindmap => (
                  <MindmapCard key={mindmap.fileName} mindmap={mindmap} onOpen={() => onOpenMindmap(mindmap)} />
                ))}
              </div>
            )}
          </section>
        )
      })}
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


function DeckActionsMenu({
  deck,
  matchableCount,
  onBrowse,
  onDelete,
  onMatch,
  onMove,
  sections
}: {
  deck: StudyDeck
  /** Non-cloze cards only — Match needs term/definition pairs. */
  matchableCount: number
  onBrowse: () => void
  onDelete: () => void
  onMatch: () => void
  onMove: (section: string) => void
  sections: string[]
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
        <DropdownMenuItem disabled={matchableCount < 2} onSelect={onMatch}>
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

function DeckTableRow({
  counts,
  deck,
  onBrowse,
  onDelete,
  onMatch,
  onMove,
  onStudy,
  sections
}: {
  counts: ReviewCategoryCounts
  deck: StudyDeck
  onBrowse: (deckId: string) => void
  onDelete: () => void
  onMatch: (deckId: string) => void
  onMove: (section: string) => void
  onStudy: (deckId: string) => void
  sections: string[]
}) {
  const matchableCount = deck.cards.filter(card => !hasClozeMarker(card.front)).length

  return (
    <div className={cn(DECK_GRID, 'group/deck px-3 py-2 transition-colors hover:bg-(--ui-row-hover-background)')}>
      <button
        className="flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => onStudy(deck.id)}
        type="button"
      >
        <span className="truncate text-sm">{deck.name}</span>
        <span
          aria-hidden="true"
          className="shrink-0 text-[0.6875rem] font-medium text-(--theme-primary) opacity-0 transition-opacity group-hover/deck:opacity-100"
        >
          study ›
        </span>
      </button>
      <CountCell tone="new" value={counts.new} />
      <CountCell tone="learning" value={counts.learning} />
      <CountCell tone="review" value={counts.review} />
      <span className="flex justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover/deck:opacity-100">
        <DeckActionsMenu
          deck={deck}
          matchableCount={matchableCount}
          onBrowse={() => onBrowse(deck.id)}
          onDelete={onDelete}
          onMatch={() => onMatch(deck.id)}
          onMove={onMove}
          sections={sections}
        />
      </span>
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
  // Local calendar day — must match the cell dates reviewHeatmap now emits.
  const todayKey = localDayKey(new Date(todayIso))
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
  onRename,
  sections,
  state
}: {
  deck: null | StudyDeck
  onChange: (next: StudyState) => void
  onDeleteDeck: () => void
  onMatch: () => void
  onMoveDeck: (section: string) => void
  onRename: (name: string) => Promise<void>
  sections: string[]
  state: StudyState
}) {
  const [editing, setEditing] = useState<null | StudyCard>(null)
  const [adding, setAdding] = useState(false)
  const [armDelete, setArmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [query, setQuery] = useState('')

  if (!deck) {
    return <EmptyState className="flex-1" description="This deck no longer exists." title="Deck not found" />
  }

  const matchableCount = deck.cards.filter(card => !hasClozeMarker(card.front)).length
  const needle = query.trim().toLocaleLowerCase()

  const visibleCards = needle
    ? deck.cards.filter(card =>
        `${card.front}\n${card.back}\n${card.tags.join('\n')}`.toLocaleLowerCase().includes(needle)
      )
    : deck.cards

  return (
    <div className="px-6 pb-8">
      <div className="mb-2 flex items-center justify-between gap-3 border-b border-border pb-1.5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1">
            <h2 className="truncate text-sm font-semibold">{deck.name}</h2>
            <Tip label="Rename deck">
              <Button aria-label="Rename deck" onClick={() => setRenaming(true)} size="icon-xs" variant="ghost">
                <IconPencil />
              </Button>
            </Tip>
          </div>
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
          <Button disabled={matchableCount < 2} onClick={onMatch} size="sm" variant="outline">
            Match
          </Button>
          <Button onClick={() => setAdding(true)} size="sm" variant="outline">
            Add card
          </Button>
        </div>
      </div>

      {deck.cards.length > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <Input
            aria-label="Search cards"
            className="h-8 max-w-64"
            onChange={event => setQuery(event.target.value)}
            placeholder="Search front, back, or tags"
            value={query}
          />
          {needle && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {visibleCards.length} of {deck.cards.length}
            </span>
          )}
        </div>
      )}

      {deck.cards.length === 0 ? (
        <EmptyState className="min-h-40" description="Add a card or import a set." title="No cards in this deck" />
      ) : visibleCards.length === 0 ? (
        <EmptyState className="min-h-40" description="Try different text or clear the search." title="No cards match" />
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
              {visibleCards.map(card => (
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
                    {card.tags.includes(LEECH_TAG) && (
                      <Badge className="mr-1.5 border-destructive/40 text-destructive" variant="outline">
                        leech
                      </Badge>
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
      {renaming && <RenameDeckDialog deck={deck} onClose={() => setRenaming(false)} onRename={onRename} />}
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
            disabled={!front.trim() || (!back.trim() && !hasClozeMarker(front))}
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
          <DialogDescription>
            New cards enter the review queue as “new”. Wrap text in {'{{c1::…}}'} for cloze blanks — each index
            becomes its own card, and the back is optional.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Textarea
            className="min-h-20"
            onChange={event => setFront(event.target.value)}
            placeholder={'Front — plain, or cloze: {{c1::furosemide}} blocks {{c2::Na-K-2Cl}}'}
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
            disabled={!front.trim() || (!back.trim() && !hasClozeMarker(front))}
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

function buildMatchTiles(cards: StudyCard[], size: number): MatchTile[] {
  // Deterministic-enough shuffle without RNG dependence on the module: seed off the
  // clock once per round (fresh each mount).
  const pool = [...cards]
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
  // Cloze cards are fill-in-the-blank, not term/definition pairs — exclude them.
  const [matchCards] = useState<StudyCard[]>(() =>
    deck ? deck.cards.filter(card => !hasClozeMarker(card.front)) : []
  )

  const size = Math.min(6, matchCards.length)
  const [tiles, setTiles] = useState<MatchTile[]>(() => buildMatchTiles(matchCards, size))
  const [selected, setSelected] = useState<null | string>(null)
  const [matched, setMatched] = useState<Set<string>>(new Set())
  const [wrong, setWrong] = useState<[string, string] | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [won, setWon] = useState(false)

  const restart = useCallback(() => {
    if (!matchCards.length) {
      return
    }

    setTiles(buildMatchTiles(matchCards, size))
    setSelected(null)
    setMatched(new Set())
    setWrong(null)
    setElapsed(0)
    setWon(false)
  }, [matchCards, size])

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
  onExit,
  onGrade,
  onReveal,
  onUndo,
  position,
  progress,
  remainingCounts,
  revealed,
  sessionTotal,
  showIntervalHints
}: {
  activeCategory: ReviewCategory
  flip: boolean
  intervals: Record<StudyRating, string>
  item: QueueItem
  /** Leave the fullscreen session (back button; Esc does the same). */
  onExit: () => void
  onGrade: (rating: StudyRating) => void
  onReveal: () => void
  /** Take back the previous grade; null hides the affordance (nothing graded yet). */
  onUndo: (() => void) | null
  position: number
  /** Session completion 0..1 for the hairline progress bar. */
  progress: number
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

  // Cloze cards drill one index: blank it in the prompt, reveal everything in
  // the answer, and show the (optional) back as a footnote under the answer.
  const isCloze = item.clozeIndex !== undefined
  const prompt = isCloze ? renderClozePrompt(item.card.front, item.clozeIndex ?? 0) : item.card.front
  const answer = isCloze ? renderClozeAnswer(item.card.front) : item.card.back
  const answerNote = isCloze && item.card.back.trim() ? item.card.back : null

  return (
    <div className="flex flex-1 flex-col items-center px-6 pb-8 pt-5">
      <div className="flex w-full max-w-2xl flex-1 flex-col">
        <div className="flex items-center justify-between gap-4 pb-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2 truncate">
            <button
              aria-label="Leave review"
              className="flex shrink-0 items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={onExit}
              type="button"
            >
              <IconArrowLeft size={13} />
              back
            </button>
            <span aria-hidden="true" className="text-(--ui-text-quaternary)">
              ·
            </span>
            {item.deckName}
            {item.isNew && (
              <Badge className="ml-2" variant="outline">
                new
              </Badge>
            )}
          </span>

          <div className="flex shrink-0 items-center gap-4">
            {onUndo && (
              <Button onClick={onUndo} size="inline" variant="text">
                Undo <span className="text-[10px] opacity-60">u</span>
              </Button>
            )}
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

        <div aria-hidden="true" className="mb-4 h-0.5 overflow-hidden rounded-full bg-(--ui-bg-quaternary)">
          <div
            className="h-full rounded-full bg-(--theme-primary) transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
          />
        </div>

        {flip ? (
          <button
            aria-label={revealed ? answer : 'Show answer'}
            className="nemesis-flip flex-1 [perspective:1600px]"
            data-flipped={revealed ? 'true' : undefined}
            onClick={() => !revealed && onReveal()}
            type="button"
          >
            <div className="nemesis-flip-inner relative h-full min-h-64 w-full">
              <FlipFace label="Question">{prompt}</FlipFace>
              <FlipFace back label="Answer" muted>
                {answer}
                {answerNote && <div className="pt-3 text-sm text-muted-foreground">{answerNote}</div>}
              </FlipFace>
            </div>
          </button>
        ) : (
          <div className="flex min-h-64 flex-1 flex-col justify-center gap-5 rounded-xl border border-border bg-card p-8">
            <div>
              <div className="pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                Question
              </div>
              <div className="text-lg leading-relaxed">{prompt}</div>
            </div>
            {revealed && (
              <>
                <div className="border-t border-border" />
                <div>
                  <div className="pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                    Answer
                  </div>
                  <div className="text-lg leading-relaxed text-foreground/80">{answer}</div>
                  {answerNote && <div className="pt-2 text-sm text-muted-foreground">{answerNote}</div>}
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

        <p className="pt-3 text-center text-[10px] text-(--ui-text-quaternary)">
          Space to flip · 1–4 to grade · u undo · Esc exit
        </p>
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
