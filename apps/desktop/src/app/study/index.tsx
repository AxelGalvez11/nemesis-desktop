// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import {
  IconChecklist,
  IconFolderPlus,
  IconLayoutGrid,
  IconList,
  IconPlayerPause,
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
import { TestSurface } from './test-mode'

const GRADES: { key: string; label: string; rating: StudyRating }[] = [
  { key: '1', label: 'Again', rating: 'again' },
  { key: '2', label: 'Hard', rating: 'hard' },
  { key: '3', label: 'Good', rating: 'good' },
  { key: '4', label: 'Easy', rating: 'easy' }
]

type DeckViewMode = 'cards' | 'list'

const VIEW_MODE_KEY = 'nemesis.study.view'

const ORDER_OPTIONS: SegmentedControlOption<ReviewOrder>[] = [
  { id: 'due', label: 'Due first' },
  { id: 'random', label: 'Random' }
]

function loadViewMode(): DeckViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'cards'
  } catch {
    return 'cards'
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
  const [reducedMotion] = useState(() => prefersReducedMotion())
  const [matchDeckId, setMatchDeckId] = useState<null | string>(null)
  const [done, setDone] = useState(0)
  const [autoImported, setAutoImported] = useState<string[]>([])
  const [mindmaps, setMindmaps] = useState<MindmapFile[]>([])
  const [tests, setTests] = useState<TestFile[]>([])
  const [testAttempts, setTestAttempts] = useState<TestAttemptsStore>(() => loadTestAttempts())
  const [viewingMindmap, setViewingMindmap] = useState<MindmapFile | null>(null)
  const [takingTest, setTakingTest] = useState<null | TestFile>(null)

  const now = useMemo(() => new Date(), [state, reviewing])
  const queue = useMemo(() => (reviewing ? buildQueue(state, reviewDeckId, now) : []), [state, reviewDeckId, reviewing, now])
  const current: QueueItem | undefined = queue[0]
  const totals = deckStats(state, null, now)

  const sections = useMemo(
    () => groupDecks(state, now).map(group => group.course).filter(course => course.toLocaleLowerCase() !== 'other'),
    [now, state]
  )

  const settings = getSettings(state)
  const flip = settings.flip && !reducedMotion

  const update = useCallback((next: StudyState) => {
    setState(next)
    saveState(next)
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
      const [candidates, mindmapFiles, testFiles] = await Promise.all([scanAllDeckFiles(), scanMindmapFiles(), scanTestFiles()])

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
      <header className="flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5">
        <div>
          <h1 className="text-lg font-semibold">Study</h1>
          <p className="text-xs text-muted-foreground">
            {totals.due} due · {totals.fresh} new · {totals.total} cards
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
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
                aria-label="Study settings"
                className="rounded-md border border-border px-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setSettingsOpen(true)}
                title="Study settings"
                type="button"
              >
                <IconSettings size={14} />
              </button>
              <Button onClick={() => setNewSectionOpen(true)} size="sm" variant="outline">
                <IconFolderPlus size={14} />
                New section
              </Button>
              <Button onClick={() => setNewDeckSection('')} size="sm" variant="outline">
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
            intervals={previewIntervals(state, current.card.id, now)}
            item={current}
            onGrade={grade}
            onReveal={() => setRevealed(true)}
            remaining={queue.length}
            revealed={revealed}
            showIntervalHints={settings.showIntervalHints}
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
          mindmaps={mindmaps}
          onBrowse={setBrowseDeckId}
          onCreateDeck={setNewDeckSection}
          onMatch={startMatch}
          onOpenMindmap={setViewingMindmap}
          onStartTest={setTakingTest}
          onStudy={startReview}
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
        <NewSectionDialog
          onClose={() => setNewSectionOpen(false)}
          onCreate={createSection}
          sections={sections}
        />
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
          <DialogDescription>Create a home for related decks. Empty sections remain visible until you add one.</DialogDescription>
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
          <p className="text-xs text-muted-foreground">That section already exists. “Other” is reserved for ungrouped decks.</p>
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
  mindmaps,
  onBrowse,
  onCreateDeck,
  onMatch,
  onOpenMindmap,
  onStartTest,
  onStudy,
  state,
  testAttempts,
  tests,
  view
}: {
  mindmaps: MindmapFile[]
  onBrowse: (deckId: string) => void
  onCreateDeck: (section: string) => void
  onMatch: (deckId: string) => void
  onOpenMindmap: (file: MindmapFile) => void
  onStartTest: (file: TestFile) => void
  onStudy: (deckId: string) => void
  state: StudyState
  testAttempts: TestAttemptsStore
  tests: TestFile[]
  view: DeckViewMode
}) {
  const now = new Date()
  const deckGroups = groupDecks(state, now)
  const extrasByCourse = useMemo(() => groupExtras(state.sections, mindmaps, tests), [mindmaps, state.sections, tests])

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
  ]

  if (!groups.length) {
    return <EmptyState className="flex-1" description="Create a deck or import cards to get going." title="No decks yet" />
  }

  return (
    <div className="pb-10">
      <Heatmap state={state} />
      {groups.map(group => {
        const groupMindmaps = group.extras?.mindmaps ?? []
        const groupTests = group.extras?.tests ?? []
        const hasExtras = groupMindmaps.length > 0 || groupTests.length > 0

        return (
          <section className="px-8 pt-7" key={group.course}>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[15px] font-semibold tracking-tight">{group.course}</h2>
              <span className="text-xs text-muted-foreground">
                {group.stats.due} due · {group.decks.length} deck{group.decks.length === 1 ? '' : 's'} · {group.stats.total} cards
                {groupMindmaps.length > 0 && ` · ${groupMindmaps.length} mind map${groupMindmaps.length === 1 ? '' : 's'}`}
                {groupTests.length > 0 && ` · ${groupTests.length} test${groupTests.length === 1 ? '' : 's'}`}
              </span>
            </div>
            {group.decks.length === 0 ? (
              hasExtras ? null : (
                <div className="rounded-xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-5">
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
              )
            ) : view === 'list' ? (
              <div className="flex flex-col gap-2">
                {group.decks.map(deck => (
                  <DeckRow deck={deck} key={deck.id} now={now} onBrowse={onBrowse} onMatch={onMatch} onStudy={onStudy} state={state} />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {group.decks.map(deck => (
                  <DeckCard deck={deck} key={deck.id} now={now} onBrowse={onBrowse} onMatch={onMatch} onStudy={onStudy} state={state} />
                ))}
              </div>
            )}
            {hasExtras && (
              <div className="mt-2 flex flex-col gap-2">
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
            )}
          </section>
        )
      })}
    </div>
  )
}

function MindmapRow({ mindmap, onOpen }: { mindmap: MindmapFile; onOpen: () => void }) {
  return (
    <button
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-left transition-colors hover:border-(--theme-primary)/40"
      onClick={onOpen}
      type="button"
    >
      <IconSitemap className="shrink-0 text-muted-foreground" size={16} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{mindmap.title}</span>
      <Badge variant="outline">Mind map</Badge>
    </button>
  )
}

function TestRow({
  attempts,
  onStart,
  test
}: {
  attempts: TestAttempt[]
  onStart: () => void
  test: TestFile
}) {
  const best = bestAttempt(attempts)
  const last = lastAttempt(attempts)
  const count = test.questions.length

  return (
    <div className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5">
      <IconChecklist className="shrink-0 text-muted-foreground" size={16} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{test.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span>
            {count} question{count === 1 ? '' : 's'}
          </span>
          {best && (
            <span>
              · best {best.score}/{best.total}
            </span>
          )}
          {last && last !== best && (
            <span>
              · last {last.score}/{last.total}
            </span>
          )}
        </div>
      </div>
      <Button onClick={onStart} size="sm" variant="secondary">
        Take test
      </Button>
    </div>
  )
}

// Fraction of a deck's cards that have been studied at least once (not "new").
function masteryPct(stats: DeckStats): number {
  return stats.total > 0 ? Math.round(((stats.total - stats.fresh) / stats.total) * 100) : 0
}

function MasteryBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary,color-mix(in_srgb,gray_18%,transparent))">
      <div className="h-full rounded-full bg-(--theme-primary)" style={{ width: `${pct}%` }} />
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
    <div className="group flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-(--theme-primary)/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{deck.name}</span>
          {stats.due > 0 && <DuePill due={stats.due} />}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1 w-28 max-w-[40%] overflow-hidden rounded-full bg-(--ui-bg-tertiary,color-mix(in_srgb,gray_18%,transparent))">
            <div className="h-full rounded-full bg-(--theme-primary)" style={{ width: `${masteryPct(stats)}%` }} />
          </div>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {stats.total} cards · {stats.fresh} new
          </span>
        </div>
      </div>
      <div className="flex shrink-0 gap-1.5 opacity-80 transition-opacity group-hover:opacity-100">
        <Button disabled={stats.due === 0} onClick={() => onStudy(deck.id)} size="sm" variant="secondary">
          Study
        </Button>
        <Button disabled={stats.total < 2} onClick={() => onMatch(deck.id)} size="sm" variant="ghost">
          Match
        </Button>
        <Button onClick={() => onBrowse(deck.id)} size="sm" variant="ghost">
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
  const pct = masteryPct(stats)

  return (
    <div className="group flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-(--theme-primary)/40 hover:shadow-lg hover:shadow-black/20">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[15px] font-semibold leading-snug tracking-tight">{deck.name}</h3>
        {stats.due > 0 && <DuePill due={stats.due} />}
      </div>

      <div className="mt-auto">
        <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {stats.total} card{stats.total === 1 ? '' : 's'} · {stats.fresh} new
          </span>
          <span className="tabular-nums">{pct}% studied</span>
        </div>
        <MasteryBar pct={pct} />
      </div>

      <div className="flex gap-2">
        <Button className="flex-1" disabled={stats.due === 0} onClick={() => onStudy(deck.id)} size="sm">
          {stats.due > 0 ? 'Study' : 'Done for now'}
        </Button>
        <Button disabled={stats.total < 2} onClick={() => onMatch(deck.id)} size="sm" variant="outline">
          Match
        </Button>
        <Button onClick={() => onBrowse(deck.id)} size="sm" variant="ghost">
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
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function heatColor(level: number): string {
  return level === 0
    ? 'color-mix(in srgb, var(--ui-text-primary) 10%, transparent)'
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
    <div className="px-8 pt-2">
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">Review activity</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs">
            <Stat label="day streak" value={stats.currentStreak} />
            <Stat label="longest" value={stats.longestStreak} />
            <Stat label="days active" value={`${stats.daysLearnedPct}%`} />
            {stats.retentionPct !== null && <Stat label="retention (30d)" value={`${stats.retentionPct}%`} />}
            <span className="text-muted-foreground">{total} reviews · past 53 weeks</span>
          </div>
          {total === 0 && <p className="mt-1 text-xs text-muted-foreground">Your year fills in as you grade cards.</p>}
        </div>

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
                <span className="size-2.5 rounded-[2px]" key={level} style={{ backgroundColor: heatColor(level) }} />
              ))}
              <span>More</span>
            </div>
          </div>
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
            <SectionSelect label="Move deck to section" onChange={onMoveDeck} sections={sections} value={deck.course ?? ''} />
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
  done,
  flip,
  intervals,
  item,
  onGrade,
  onReveal,
  remaining,
  revealed,
  showIntervalHints
}: {
  done: number
  flip: boolean
  intervals: Record<StudyRating, string>
  item: QueueItem
  onGrade: (rating: StudyRating) => void
  onReveal: () => void
  remaining: number
  revealed: boolean
  showIntervalHints: boolean
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
          <div className="h-full bg-(--theme-primary)" style={{ width: `${progress}%` }} />
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
