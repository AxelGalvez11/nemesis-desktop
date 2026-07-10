// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
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
import { cn } from '@/lib/utils'

import { parseCardPaste } from './import-cards'
import {
  buildQueue,
  deckStats,
  freshId,
  gradeCard,
  loadState,
  previewIntervals,
  type QueueItem,
  saveState,
  type StudyDeck,
  type StudyRating,
  type StudyState
} from './model'

const GRADES: { key: string; label: string; rating: StudyRating }[] = [
  { key: '1', label: 'Again', rating: 'again' },
  { key: '2', label: 'Hard', rating: 'hard' },
  { key: '3', label: 'Good', rating: 'good' },
  { key: '4', label: 'Easy', rating: 'easy' }
]

export function StudyView() {
  const [state, setState] = useState<StudyState>(() => loadState())
  const [reviewDeckId, setReviewDeckId] = useState<null | string>(null)
  const [reviewing, setReviewing] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [done, setDone] = useState(0)

  const now = useMemo(() => new Date(), [state, reviewing])
  const queue = useMemo(() => (reviewing ? buildQueue(state, reviewDeckId, now) : []), [state, reviewDeckId, reviewing, now])
  const current: QueueItem | undefined = queue[0]
  const totals = deckStats(state, null, now)

  const update = useCallback((next: StudyState) => {
    setState(next)
    saveState(next)
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
          {reviewing ? (
            <Button onClick={exitReview} size="sm" variant="outline">
              Back to decks
            </Button>
          ) : (
            <>
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

      {reviewing ? (
        current ? (
          <ReviewSurface
            done={done}
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
      ) : (
        <DeckGrid onStudy={startReview} state={state} />
      )}

      <ImportDialog onImport={importCards} onOpenChange={setImportOpen} open={importOpen} />
    </div>
  )
}

function DeckGrid({ onStudy, state }: { onStudy: (deckId: string) => void; state: StudyState }) {
  const now = new Date()

  if (!state.decks.length) {
    return <EmptyState className="flex-1" description="Import cards to build your first deck." title="No decks yet" />
  }

  return (
    <div className="grid grid-cols-1 gap-3 px-6 pb-6 md:grid-cols-2 xl:grid-cols-3">
      {state.decks.map(deck => {
        const stats = deckStats(state, deck.id, now)

        return (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4" key={deck.id}>
            <div className="min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="truncate text-sm font-medium">{deck.name}</div>
                {stats.due > 0 && <Badge variant="muted">{stats.due} due</Badge>}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {deck.course ? `${deck.course} · ` : ''}
                {stats.total} cards · {stats.fresh} new
              </div>
            </div>
            <div className="mt-auto">
              <Button disabled={stats.due === 0} onClick={() => onStudy(deck.id)} size="sm" variant="secondary">
                {stats.due > 0 ? 'Study' : 'Done for now'}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ReviewSurface({
  done,
  intervals,
  item,
  onGrade,
  onReveal,
  remaining,
  revealed
}: {
  done: number
  intervals: Record<StudyRating, string>
  item: QueueItem
  onGrade: (rating: StudyRating) => void
  onReveal: () => void
  remaining: number
  revealed: boolean
}) {
  return (
    <div className="flex flex-1 flex-col items-center px-6 pb-8">
      <div className="flex w-full max-w-2xl flex-1 flex-col">
        <div className="flex items-center justify-between pb-3 text-xs text-muted-foreground">
          <span className="truncate">
            {item.deckName}
            {item.isNew && (
              <Badge className="ml-2" variant="outline">
                new
              </Badge>
            )}
          </span>
          <span>
            {done} done · {remaining} left
          </span>
        </div>

        <div className="flex min-h-64 flex-1 flex-col justify-center gap-5 rounded-lg border border-border bg-card p-8">
          <div className="text-base leading-relaxed">{item.card.front}</div>
          {revealed && (
            <>
              <div className="border-t border-border" />
              <div className="text-base leading-relaxed text-muted-foreground">{item.card.back}</div>
            </>
          )}
        </div>

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
