// Recorder UI. The capture engine lives in service.ts so this view is only a binder:
// navigating away can unmount every element below without touching an active recording.
import { useStore } from '@nanostores/react'
import { IconCheck, IconLock, IconMicrophone, IconPlayerPause, IconPlayerPlay, IconSparkles } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { $account } from '@/nemesis-account'
import { setComposerDraft } from '@/store/composer'

import { NoteEditor } from '../library/note-editor'
import { LIBRARY_ROUTE, NEW_CHAT_ROUTE } from '../routes'

import { enhanceLectureNote, RecordingArchive } from './archive'
import {
  $copilotAsk,
  $copilotEnabled,
  $copilotError,
  $copilotNotes,
  $copilotState,
  copilotAccess,
  forceCopilotRefresh,
  initCopilotWiring, setCopilotEnabled } from './live-copilot'
import {
  $elapsedMs,
  $liveCaptionsEnabled,
  $liveInsights,
  $liveStatus,
  $liveTranscript,
  $notepadDraft,
  $paused,
  $recentLectureNote,
  $recording,
  $recordingError,
  $recordingsVersion,
  $recordingTitle,
  $starting,
  $systemAudioEnabled,
  $transcriptRefine,
  formatElapsed,
  getRecordingAnalyser,
  LECTURE_FOLDER,
  setLiveCaptionsEnabled,
  setNotepadDraft,
  setRecordingPaused,
  setRecordingTitle,
  setSystemAudioEnabled,
  startRecording,
  stopRecording,
  toggleLiveInsight
} from './service'

function useLiveWaveform(recording: boolean) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    initCopilotWiring()
  }, [])

  useEffect(() => {
    if (!recording) {
      return
    }

    const canvas = canvasRef.current
    const analyser = getRecordingAnalyser()

    if (!canvas || !analyser) {
      return
    }

    const context = canvas.getContext('2d')

    if (!context) {
      return
    }

    const buffer = new Uint8Array(analyser.frequencyBinCount)
    let animationFrame = 0

    const render = () => {
      animationFrame = requestAnimationFrame(render)
      const pixelRatio = window.devicePixelRatio || 1
      const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio))
      const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio))

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      analyser.getByteTimeDomainData(buffer)
      const rootStyle = getComputedStyle(document.documentElement)

      const accent =
        rootStyle.getPropertyValue('--theme-primary').trim() || rootStyle.getPropertyValue('--ui-text-primary').trim()

      context.clearRect(0, 0, width, height)
      context.lineWidth = Math.max(1.5, pixelRatio * 1.5)
      context.strokeStyle = accent
      context.beginPath()
      const slice = width / Math.max(1, buffer.length - 1)

      for (let index = 0; index < buffer.length; index++) {
        const y = (buffer[index] / 255) * height
        index === 0 ? context.moveTo(0, y) : context.lineTo(index * slice, y)
      }

      context.stroke()
    }

    render()

    return () => cancelAnimationFrame(animationFrame)
  }, [recording])

  return canvasRef
}

export function RecorderView() {
  const recording = useStore($recording)
  const starting = useStore($starting)
  const paused = useStore($paused)
  const elapsedMs = useStore($elapsedMs)
  const liveTranscript = useStore($liveTranscript)
  const liveInsights = useStore($liveInsights)
  const copilotEnabled = useStore($copilotEnabled)
  const copilotNotes = useStore($copilotNotes)
  const copilotAsk = useStore($copilotAsk)
  const copilotState = useStore($copilotState)
  const copilotError = useStore($copilotError)
  const account = useStore($account)
  const copilotCadence = copilotAccess(account)
  const liveStatus = useStore($liveStatus)
  const title = useStore($recordingTitle)
  const notepadDraft = useStore($notepadDraft)
  const withSystemAudio = useStore($systemAudioEnabled)
  const liveCaptions = useStore($liveCaptionsEnabled)
  const lectureNote = useStore($recentLectureNote)
  const transcriptRefine = useStore($transcriptRefine)
  const recordingsVersion = useStore($recordingsVersion)
  const error = useStore($recordingError)
  const navigate = useNavigate()
  const liveScrollRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useLiveWaveform(recording === 'recording')

  useEffect(() => {
    const host = liveScrollRef.current

    if (host) {
      host.scrollTop = host.scrollHeight
    }
  }, [liveTranscript])

  const enhanceNote = () => {
    if (lectureNote) {
      enhanceLectureNote(lectureNote, navigate)
    }
  }

  const askQueued = () => {
    const queued = liveInsights.filter(insight => insight.queued).map(insight => insight.term)

    if (!queued.length) {
      return
    }

    const context = liveTranscript.slice(-6).join(' ').slice(-1200)
    setComposerDraft(
      `These drugs came up in the lecture I just recorded: ${queued.join(', ')}. ` +
        'For each, give me the exam-relevant rundown: drug class, mechanism in one line, the classic adverse effect, ' +
        'and the single interaction I must know — cite PMIDs inline where it matters.' +
        (context ? `\n\nTranscript context:\n"${context}"` : '')
    )
    navigate(NEW_CHAT_ROUTE)
  }

  if (recording === 'recording') {
    return (
      {/* xl previously locked overflow to hidden for app-like fixed panes, but the
          breakpoints see zoom-scaled pixels: at 125-150% UI scale a window can sit
          in the xl column layout while the panels no longer fit vertically, and
          hidden overflow made them overlap with no way to scroll (tester report
          2026-07-14). overflow-y-auto is visually identical when content fits. */}
      <main className="flex h-full min-h-0 flex-col overflow-y-auto bg-(--ui-editor-surface-background) px-4 pb-5 pt-4 sm:px-5">
        <header className="mb-4 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-4 py-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
          <span aria-hidden="true" className="relative flex size-3 shrink-0">
            {!paused && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-(--theme-primary) opacity-45" />
            )}
            <span className="relative inline-flex size-3 rounded-full bg-(--theme-primary)" />
          </span>
          <span className="shrink-0 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--theme-primary)">
            {paused ? 'Paused' : 'On air'}
          </span>
          <input
            aria-label="Lecture title"
            className="order-last min-w-0 basis-full border-none bg-transparent text-base font-semibold tracking-tight outline-none placeholder:text-muted-foreground/50 sm:order-none sm:min-w-44 sm:flex-1 sm:basis-auto sm:text-lg"
            onChange={event => setRecordingTitle(event.target.value)}
            placeholder="Lecture title"
            value={title}
          />
          <span className="shrink-0 rounded-full bg-(--ui-bg-quaternary) px-3 py-1 text-base font-semibold tabular-nums tracking-tight text-foreground">
            {formatElapsed(elapsedMs)}
          </span>
          <Button
            aria-label={paused ? 'Resume recording' : 'Pause recording'}
            onClick={() => void setRecordingPaused(!paused)}
            size="icon-sm"
            variant="outline"
          >
            {paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />}
          </Button>
          <Button className="active:scale-[0.98]" onClick={stopRecording} size="sm" variant="destructive">
            Stop &amp; save
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(17rem,0.78fr)_minmax(22rem,1.22fr)]">
          <section
            aria-label="Live capture"
            className="flex min-h-0 min-w-0 flex-col gap-3 xl:overflow-y-auto xl:pr-0.5"
          >
            <div className="shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                  Audio signal
                </span>
                <span className="truncate text-[0.65rem] text-(--ui-text-quaternary)">
                  {paused ? 'Capture paused' : `Mic${withSystemAudio ? ' + system' : ''}`}
                </span>
              </div>
              <canvas
                className={cn('h-16 w-full rounded-xl bg-(--ui-bg-quaternary)', paused && 'opacity-45')}
                ref={canvasRef}
              />
            </div>

            {liveCaptions ? (
              <>
                <div className="flex min-h-48 shrink-0 flex-col rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)] xl:min-h-56">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">
                      Live transcript
                    </span>
                    <span className="min-w-0 truncate text-[0.65rem] text-muted-foreground">{liveStatus}</span>
                  </div>
                  <div
                    aria-live="polite"
                    className="max-h-80 space-y-3 overflow-y-auto pr-1 text-[0.8125rem] leading-6 text-foreground/90"
                    ref={liveScrollRef}
                  >
                    {liveTranscript.length ? (
                      liveTranscript.map((segment, index) => (
                        <p
                          className="animate-in fade-in-0 border-l-2 border-(--theme-primary)/30 pl-3 duration-200"
                          key={`${index}-${segment.slice(0, 18)}`}
                        >
                          {segment}
                        </p>
                      ))
                    ) : (
                      <div className="grid min-h-28 place-content-center text-center">
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">
                          {paused ? 'Capture paused' : 'Listening'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {paused
                            ? 'Resume when the lecture continues.'
                            : 'Speech will appear here as the lecture continues.'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
                  <div className="mb-2.5 flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">
                      <IconSparkles size={12} />
                      Live copilot
                    </span>
                    {copilotCadence && (
                      <button
                        className="text-[0.65rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => setCopilotEnabled(!copilotEnabled)}
                        type="button"
                      >
                        {copilotEnabled ? 'Turn off' : 'Turn on'}
                      </button>
                    )}
                  </div>
                  {!copilotCadence ? (
                    <p className="text-xs text-muted-foreground">
                      Live AI notes and question suggestions are part of the Agent Pro and Max plans.
                    </p>
                  ) : !copilotEnabled ? (
                    <p className="text-xs text-muted-foreground">
                      Off. When on, Nemesis writes running notes from the lecture (fixing mis-heard words from
                      context) and suggests what to ask next. Uses your plan's daily AI budget.
                    </p>
                  ) : (
                    <>
                      {copilotNotes.length ? (
                        <ul className="max-h-44 space-y-1.5 overflow-y-auto pr-1 text-[0.8125rem] leading-5 text-foreground/90">
                          {copilotNotes.slice(-8).map((note, index) => (
                            <li className="animate-in fade-in-0 flex gap-2 duration-200" key={`${index}-${note.slice(0, 16)}`}>
                              <span className="text-(--theme-primary)">•</span>
                              <span>{note}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">Notes appear here as the lecture develops.</p>
                      )}
                      {copilotAsk.length > 0 && (
                        <div className="mt-2.5 border-t border-(--ui-stroke-tertiary) pt-2.5">
                          <span className="text-[0.6rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                            Ask next
                          </span>
                          <ul className="mt-1 space-y-1 text-[0.8125rem] leading-5 text-foreground/85">
                            {copilotAsk.map(question => (
                              <li key={question.slice(0, 24)}>“{question}”</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div className="mt-2.5 flex items-center justify-between gap-3">
                        <span className={cn('min-w-0 truncate text-[0.65rem]', copilotState === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                          {copilotState === 'thinking' ? 'Thinking…' : copilotState === 'error' ? (copilotError ?? 'Copilot error') : ''}
                        </span>
                        <Button disabled={copilotState === 'thinking'} onClick={forceCopilotRefresh} size="sm" variant="outline">
                          Suggest now
                        </Button>
                      </div>
                    </>
                  )}
                </div>

                {liveInsights.length > 0 && (
                  <div className="shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">
                        <IconSparkles size={12} />
                        Mentioned
                      </span>
                      <span className="text-[0.65rem] text-muted-foreground">Select drugs to review after class</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {liveInsights.map(insight => (
                        <button
                          aria-pressed={insight.queued}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-[transform,color,border-color,background-color] active:scale-[0.98]',
                            insight.queued
                              ? 'border-(--theme-primary)/45 bg-(--ui-bg-primary) text-foreground'
                              : 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) text-muted-foreground hover:border-(--theme-primary)/35 hover:text-foreground'
                          )}
                          key={insight.term}
                          onClick={() => toggleLiveInsight(insight.term)}
                          type="button"
                        >
                          {insight.queued && <IconCheck size={11} />}
                          {insight.term}
                          <span className="text-[9px] tabular-nums opacity-60">{insight.at}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4">
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">
                  Live transcript off
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Audio is still recording and can be transcribed later.
                </p>
              </div>
            )}

            <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
              <IconLock size={12} />
              On this device only — nothing joins your call
            </span>
          </section>

          <section className="flex min-h-[24rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)] xl:min-h-0">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) px-5 py-3">
              <div>
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">
                  Lecture notepad
                </p>
                <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                  Write freely while Nemesis listens alongside you.
                </p>
              </div>
              <span className="hidden rounded-full bg-(--ui-bg-quaternary) px-2.5 py-1 text-[0.625rem] text-muted-foreground sm:inline">
                Auto-saved on stop
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-5">
              <NoteEditor initialValue={notepadDraft} onChange={setNotepadDraft} onOpenWikilink={() => {}} />
            </div>
          </section>
        </div>
        {error && <p className="pt-2 text-center text-xs text-destructive">{error}</p>}
      </main>
    )
  }

  const queuedCount = liveInsights.filter(insight => insight.queued).length
  const stopping = recording === 'stopping'

  return (
    <main className="flex h-full min-h-0 flex-col overflow-y-auto bg-(--ui-editor-surface-background)">
      <header className="sticky top-0 z-20 shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background)/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[960px] items-start gap-4 px-5 pb-4 pt-6 sm:px-7 [@media(max-height:720px)]:pb-3 [@media(max-height:720px)]:pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--ui-text-tertiary)">
              Capture desk
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em] [@media(max-height:720px)]:text-xl">
              Recorder
            </h1>
          </div>
          <Button
            aria-label="Start recording"
            className="mt-0.5 bg-(--ui-red) text-white hover:bg-(--ui-red)/90 active:scale-[0.98]"
            disabled={stopping || starting}
            onClick={() => void startRecording()}
            size="sm"
          >
            ● Record
          </Button>
        </div>
      </header>

      {/* Height compaction only changes flow and dimensions. Both record controls
          remain rendered and reachable at every viewport height and zoom level. */}
      <section className="mx-auto flex w-full max-w-[960px] shrink-0 flex-col items-center gap-5 px-5 pb-9 pt-10 text-center sm:px-7 [@media(max-height:720px)]:gap-3 [@media(max-height:720px)]:py-3 [@media(max-height:720px)_and_(min-width:640px)]:flex-row [@media(max-height:720px)_and_(min-width:640px)]:text-left">
        <Button
          aria-label="Start recording"
          className="group relative size-28 rounded-full bg-(--ui-red) text-white shadow-[0_12px_32px_color-mix(in_srgb,var(--ui-red)_22%,transparent)] transition-[transform,box-shadow,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-full before:ring-1 before:ring-white/25 hover:scale-[1.025] hover:bg-(--ui-red)/95 hover:shadow-[0_14px_38px_color-mix(in_srgb,var(--ui-red)_28%,transparent)] active:scale-[0.97] [@media(max-height:720px)]:size-14 [@media(max-height:720px)]:shadow-[0_7px_18px_color-mix(in_srgb,var(--ui-red)_18%,transparent)]"
          disabled={stopping || starting}
          onClick={() => void startRecording()}
          size="icon-lg"
        >
          <span className="pointer-events-none absolute inset-1 rounded-full bg-(--ui-red)/20 opacity-0 group-hover:animate-ping group-hover:opacity-100" />
          <span className="relative flex flex-col items-center gap-1 [@media(max-height:720px)]:gap-0">
            <IconMicrophone className="size-8 [@media(max-height:720px)]:size-5" />
            <span className="text-[0.6875rem] font-semibold tracking-wide [@media(max-height:720px)]:text-[0.55rem]">
              Record
            </span>
          </span>
        </Button>

        <div className="flex min-w-0 flex-col items-center [@media(max-height:720px)_and_(min-width:640px)]:grid [@media(max-height:720px)_and_(min-width:640px)]:flex-1 [@media(max-height:720px)_and_(min-width:640px)]:grid-cols-[minmax(0,1fr)_auto] [@media(max-height:720px)_and_(min-width:640px)]:items-center [@media(max-height:720px)_and_(min-width:640px)]:gap-x-5">
          <p className="max-w-2xl text-sm leading-6 text-(--ui-text-secondary) [@media(max-height:720px)_and_(min-width:640px)]:row-span-2">
            {stopping
              ? liveStatus || 'Finishing your capture and saving it on this Mac.'
              : starting
                ? 'Opening audio capture on this Mac.'
                : 'Capture the lecture. Notes, transcript, and terms — all on this Mac.'}
          </p>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 [@media(max-height:720px)]:mt-2 [@media(max-height:720px)_and_(min-width:640px)]:mt-0 [@media(max-height:720px)_and_(min-width:640px)]:justify-end">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-(--ui-text-secondary)">
              <span>Computer audio</span>
              <input
                checked={withSystemAudio}
                className="peer sr-only"
                disabled={starting || stopping}
                onChange={event => setSystemAudioEnabled(event.target.checked)}
                type="checkbox"
              />
              <span className="relative h-4 w-7 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-3 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-foreground/20 peer-checked:bg-foreground peer-checked:after:translate-x-3 peer-checked:after:bg-background peer-disabled:opacity-45" />
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-(--ui-text-secondary)">
              <span>Live transcript</span>
              <input
                checked={liveCaptions}
                className="peer sr-only"
                disabled={starting || stopping}
                onChange={event => setLiveCaptionsEnabled(event.target.checked)}
                type="checkbox"
              />
              <span className="relative h-4 w-7 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-3 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-foreground/20 peer-checked:bg-foreground peer-checked:after:translate-x-3 peer-checked:after:bg-background peer-disabled:opacity-45" />
            </label>
          </div>

          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-(--ui-stroke-tertiary) px-2.5 py-1 text-[0.65rem] text-(--ui-text-tertiary) [@media(max-height:720px)]:mt-1 [@media(max-height:720px)_and_(min-width:640px)]:justify-self-end">
            <IconLock size={11} />
            Nothing joins your call · processed on this device
          </span>
        </div>
      </section>

      {(lectureNote || error) && (
        <div className="mx-auto w-full max-w-[960px] px-5 sm:px-7">
          {lectureNote && (
            <div className="flex flex-wrap items-center gap-2 border-y border-(--ui-stroke-tertiary) py-3 text-xs">
              <span className="min-w-0 flex-1 basis-full items-center gap-1.5 font-medium sm:inline-flex sm:basis-auto">
                <IconCheck className="mr-1 inline" size={13} />
                Saved to Library / {LECTURE_FOLDER} as {lectureNote}.md
              </span>
              <Button
                onClick={() => navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(lectureNote)}`)}
                size="xs"
                variant="outline"
              >
                Open note
              </Button>
              <Button onClick={enhanceNote} size="xs" variant="secondary">
                <IconSparkles size={12} />
                Enhance with Nemesis
              </Button>
              {queuedCount > 0 && (
                <Button onClick={askQueued} size="xs" variant="outline">
                  Review {queuedCount} queued drug{queuedCount === 1 ? '' : 's'}
                </Button>
              )}
              {transcriptRefine && transcriptRefine.title === lectureNote && transcriptRefine.state !== 'failed' && (
                <span className="basis-full text-[0.65rem] text-muted-foreground">
                  {transcriptRefine.state === 'refining'
                    ? (transcriptRefine.detail ??
                      'Refining the transcript with the accurate on-device model — the note updates itself when done.')
                    : 'Transcript refined with the accurate model.'}
                </span>
              )}
            </div>
          )}
          {error && <p className="border-b border-(--ui-stroke-tertiary) py-3 text-xs text-destructive">{error}</p>}
        </div>
      )}

      <section className="mx-auto w-full max-w-[960px] px-5 pb-10 pt-7 sm:px-7">
        <RecordingArchive reloadToken={recordingsVersion} />
        <div className="flex flex-wrap items-center gap-1.5 pt-4 text-[0.6875rem] text-muted-foreground">
          <IconLock size={11} />
          <span>Local by design ·</span>
          <Tip
            className="max-w-sm whitespace-normal text-left leading-relaxed"
            label={
              <span>
                Recording other people may require their consent where you live — check your school&rsquo;s policy.
                Nemesis never records on its own and never hides the indicator. Transcription runs on your device;
                review the draft before relying on it.
              </span>
            }
            side="top"
          >
            <button className="underline decoration-current/30 underline-offset-2 hover:text-foreground" type="button">
              Consent &amp; transcription details
            </button>
          </Tip>
        </div>
      </section>
    </main>
  )
}
