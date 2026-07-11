// Recorder UI. The capture engine lives in service.ts so this view is only a binder:
// navigating away can unmount every element below without touching an active recording.
import { useStore } from '@nanostores/react'
import { IconCheck, IconLock, IconMicrophone, IconPlayerPause, IconPlayerPlay, IconSparkles } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { setComposerDraft } from '@/store/composer'

import { NoteEditor } from '../library/note-editor'
import { LIBRARY_ROUTE, NEW_CHAT_ROUTE } from '../routes'

import { enhanceLectureNote, RecordingArchive } from './archive'
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
  const liveStatus = useStore($liveStatus)
  const title = useStore($recordingTitle)
  const notepadDraft = useStore($notepadDraft)
  const withSystemAudio = useStore($systemAudioEnabled)
  const liveCaptions = useStore($liveCaptionsEnabled)
  const lectureNote = useStore($recentLectureNote)
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
      <main className="flex h-full min-h-0 flex-col overflow-y-auto bg-(--ui-editor-surface-background) px-4 pb-5 pt-4 sm:px-5 xl:overflow-hidden">
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
      {/* Short-viewport compaction (high zoom shrinks the effective window):
          the record button must sit in the FIRST screenful at every zoom step,
          so header + hero tighten below ~720px effective height instead of
          pushing the primary control under the fold. */}
      <header className="px-4 pb-2 pt-5 sm:px-6 sm:pt-6 [@media(max-height:720px)]:pb-1 [@media(max-height:720px)]:pt-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--theme-primary)">Capture desk</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em] [@media(max-height:720px)]:text-xl">Recorder</h1>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground [@media(max-height:720px)]:hidden">
          Capture your microphone{withSystemAudio ? ' and this computer’s audio' : ''} locally. Keep a live notepad,
          review on-device transcription, and collect the pharmacology terms that matter.
        </p>
      </header>

      <section className="mx-4 mt-4 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)] sm:mx-6 [@media(max-height:720px)]:mt-2">
        <div className="grid items-stretch lg:grid-cols-[minmax(0,0.9fr)_minmax(20rem,1.1fr)]">
          <div className="flex min-w-0 flex-col items-start gap-5 border-b border-(--ui-stroke-tertiary) p-5 sm:flex-row sm:items-center sm:p-6 lg:border-b-0 lg:border-r [@media(max-height:720px)]:gap-3 [@media(max-height:720px)]:p-3">
            <div className="grid size-24 shrink-0 place-items-center rounded-full border border-(--theme-primary)/25 bg-(--ui-bg-primary) shadow-[inset_0_0_0_7px_var(--ui-bg-elevated)] [@media(max-height:720px)]:size-16 [@media(max-height:720px)]:shadow-[inset_0_0_0_4px_var(--ui-bg-elevated)]">
              <Button
                aria-label="Start recording"
                className="size-20 rounded-full shadow-lg transition-[transform,opacity] active:scale-[0.96] [@media(max-height:720px)]:size-12"
                disabled={stopping || starting}
                onClick={() => void startRecording()}
                size="icon-lg"
              >
                <IconMicrophone className="size-7 [@media(max-height:720px)]:size-5" />
              </Button>
            </div>
            <div className="min-w-0">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">
                {stopping ? 'Finishing capture' : starting ? 'Opening audio capture' : 'Ready to record'}
              </p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">
                {stopping ? 'Saving your lecture' : 'Capture the lecture, keep the context'}
              </h2>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                {stopping
                  ? liveStatus || 'Writing audio and notes to disk…'
                  : 'One click opens the live notepad, audio signal, transcript, and pharmacology mentions.'}
              </p>
            </div>
          </div>

          <div className="flex min-w-0 flex-col justify-center gap-2 p-4">
            <label className="group flex cursor-pointer items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-bg-quaternary)">
              <input
                checked={withSystemAudio}
                className="peer sr-only"
                disabled={starting || stopping}
                onChange={event => setSystemAudioEnabled(event.target.checked)}
                type="checkbox"
              />
              <span className="relative h-5 w-9 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-(--theme-primary)/35 peer-checked:bg-(--theme-primary) peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground peer-disabled:opacity-45" />
              <span className="min-w-0">
                <span className="block text-xs font-semibold">Computer audio</span>
                <span className="block text-[0.6875rem] leading-relaxed text-muted-foreground">
                  Capture lecture or meeting audio · macOS asks once
                </span>
              </span>
            </label>
            <label className="group flex cursor-pointer items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-bg-quaternary)">
              <input
                checked={liveCaptions}
                className="peer sr-only"
                disabled={starting || stopping}
                onChange={event => setLiveCaptionsEnabled(event.target.checked)}
                type="checkbox"
              />
              <span className="relative h-5 w-9 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-(--theme-primary)/35 peer-checked:bg-(--theme-primary) peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground peer-disabled:opacity-45" />
              <span className="min-w-0">
                <span className="block text-xs font-semibold">Live transcript</span>
                <span className="block text-[0.6875rem] leading-relaxed text-muted-foreground">
                  Process speech on-device and save a linked lecture note
                </span>
              </span>
            </label>
            <span className="mx-3 mt-1 inline-flex items-center gap-1.5 self-start rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
              <IconLock size={12} />
              Nothing joins your call · processed on this device
            </span>
          </div>
        </div>

        {lectureNote && (
          <div className="flex flex-wrap items-center gap-2 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-5 py-3 text-xs">
            <span className="min-w-0 flex-1 basis-full items-center gap-1.5 font-medium sm:inline-flex sm:basis-auto">
              <IconCheck className="mr-1 inline text-(--theme-primary)" size={13} />
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
          </div>
        )}
        {error && <p className="border-t border-(--ui-stroke-tertiary) px-5 py-3 text-xs text-destructive">{error}</p>}
      </section>

      <section className="px-4 pb-8 pt-7 sm:px-6">
        <div className="mb-3">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--theme-primary)">Archive</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">Saved recordings</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Play back, transcribe, enhance, or clean up past captures.
          </p>
        </div>
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
