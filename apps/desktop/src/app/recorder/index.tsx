// Recorder — consent-first lecture capture with LIVE on-device captions. The deliberate
// ANTI-Cluely: user-initiated only, a large persistent ON-AIR indicator while recording,
// nothing hidden from screen shares. Captures the microphone plus system audio (Electron
// 39+ loopback via the macOS CoreAudio tap), mixes both into one Opus/WebM file under
// ~/Documents/Nemesis Recordings — and, while recording, streams ~8s chunks of the live
// mix through the local Whisper model so the transcript scrolls in as the lecture happens.
// On stop, the transcript auto-saves as a Library note (Lectures folder).
import { IconLock, IconMicrophone } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import { setComposerDraft } from '@/store/composer'

import { createFolder, saveNote } from '../library/vault'
import { LIBRARY_ROUTE, NEW_CHAT_ROUTE } from '../routes'
import { correctPharmTerms } from './pharm-lexicon'
import { preloadTranscriber, transcribeAudio, transcribeSamples } from './transcribe'

const RECORDINGS_DIR = '~/Documents/Nemesis Recordings'
const LECTURE_FOLDER = 'Lectures'
const LIVE_CHUNK_SECONDS = 8
const WHISPER_RATE = 16_000
// Backlog cap: if transcription falls behind the lecture, keep only the newest 30s per
// pass (the saved audio file still has everything — Transcribe later covers gaps).
const MAX_LIVE_WINDOW = WHISPER_RATE * 30

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function concatSamples(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Float32Array(total)
  let offset = 0

  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }

  return out
}

/** Linear resample to Whisper's 16 kHz. */
function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === WHISPER_RATE) {
    return input
  }

  const ratio = inputRate / WHISPER_RATE
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)

  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const left = Math.floor(pos)
    const frac = pos - left
    const a = input[left] ?? 0
    const b = input[left + 1] ?? a
    out[i] = a + (b - a) * frac
  }

  return out
}

function rmsOf(samples: Float32Array): number {
  let sum = 0

  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i]
  }

  return Math.sqrt(sum / Math.max(1, samples.length))
}

/** Whisper on near-silence hallucinates fillers ("you", "[BLANK_AUDIO]") — drop those. */
function isRealSpeech(text: string): boolean {
  const letters = text.replace(/[^a-z]/gi, '')

  return letters.length >= 3 && !/^\[?blank[_ ]?audio\]?$/i.test(text.trim())
}

function lectureNoteTitle(date: Date): string {
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/:/g, '.')

  return `Lecture ${day} ${time}`
}

/** "lecture-2026-07-09T20-28-01.webm" → "Jul 9, 2026 · 8:28 PM"; else the raw name. */
function recordingLabel(name: string): string {
  const match = name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)

  if (match) {
    const [, y, mo, d, h, mi] = match
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))

    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString(undefined, {
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        month: 'short',
        year: 'numeric'
      })
    }
  }

  return name
}

interface RecordingFile {
  name: string
  path: string
}

type RecorderState = 'idle' | 'recording' | 'saving'

export function RecorderView() {
  const [state, setState] = useState<RecorderState>('idle')
  const [error, setError] = useState<null | string>(null)
  const [elapsed, setElapsed] = useState(0)
  const [withSystemAudio, setWithSystemAudio] = useState(true)
  const [liveCaptions, setLiveCaptions] = useState(true)
  const [liveSegments, setLiveSegments] = useState<string[]>([])
  const [liveStatus, setLiveStatus] = useState('')
  const [lectureNote, setLectureNote] = useState<null | string>(null)
  const [recordings, setRecordings] = useState<RecordingFile[]>([])
  const [playing, setPlaying] = useState<null | { path: string; src: string }>(null)
  const [transcripts, setTranscripts] = useState<Record<string, string>>({})
  const [corrections, setCorrections] = useState<Record<string, number>>({})
  const [transcribingStatus, setTranscribingStatus] = useState<Record<string, string>>({})
  const [savedNote, setSavedNote] = useState<Record<string, boolean>>({})
  const navigate = useNavigate()

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamsRef = useRef<MediaStream[]>([])
  const chunksRef = useRef<Blob[]>([])
  const tickRef = useRef<null | ReturnType<typeof setInterval>>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const liveBuffersRef = useRef<Float32Array[]>([])
  const liveSampleCountRef = useRef(0)
  const livePendingRef = useRef<Float32Array[]>([])
  const livePumpingRef = useRef(false)
  const liveFailedRef = useRef(false)
  const liveSegmentsRef = useRef<string[]>([])
  const liveScrollRef = useRef<HTMLDivElement | null>(null)

  const refreshList = useCallback(async () => {
    try {
      const dir = await window.hermesDesktop?.readDir?.(RECORDINGS_DIR)
      const files = (dir?.entries ?? [])
        .filter(entry => !entry.isDirectory && /\.(webm|m4a|wav)$/i.test(entry.name))
        .map(entry => ({ name: entry.name, path: entry.path }))
        .sort((a, b) => b.name.localeCompare(a.name))
      setRecordings(files)
    } catch {
      // listing is best-effort; recording itself reports its own errors
    }
  }, [])

  useEffect(() => {
    void refreshList()

    return () => stopEverything()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the live transcript pinned to its newest line.
  useEffect(() => {
    const host = liveScrollRef.current

    if (host) {
      host.scrollTop = host.scrollHeight
    }
  }, [liveSegments])

  // Live waveform: draw the ACTUAL captured signal (mic + system mix) — honest, since it
  // reflects real audio, unlike faking live transcript text.
  const drawWave = useCallback(() => {
    const analyser = analyserRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')

    if (!analyser || !canvas || !ctx) {
      return
    }

    const buffer = new Uint8Array(analyser.frequencyBinCount)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim() || '#b3382e'

    const render = () => {
      rafRef.current = requestAnimationFrame(render)
      analyser.getByteTimeDomainData(buffer)
      const { height, width } = canvas
      ctx.clearRect(0, 0, width, height)
      ctx.lineWidth = 2
      ctx.strokeStyle = accent
      ctx.beginPath()
      const slice = width / buffer.length

      for (let i = 0; i < buffer.length; i++) {
        const y = (buffer[i] / 128) * (height / 2)
        i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * slice, y)
      }

      ctx.stroke()
    }

    render()
  }, [])

  // --- Live caption pipeline ------------------------------------------------
  // ScriptProcessor taps the mixed signal; every ~8s the buffered audio is resampled to
  // 16 kHz and fed to the local Whisper model. One transcription runs at a time; pending
  // chunks merge so a slow pass never queues unbounded work.

  const appendLiveSegment = useCallback((text: string) => {
    liveSegmentsRef.current = [...liveSegmentsRef.current, text]
    setLiveSegments(liveSegmentsRef.current)
  }, [])

  const pumpLive = useCallback(async () => {
    if (livePumpingRef.current || liveFailedRef.current) {
      return
    }

    livePumpingRef.current = true

    try {
      while (livePendingRef.current.length > 0) {
        let merged = concatSamples(livePendingRef.current.splice(0))
        const lagging = merged.length > MAX_LIVE_WINDOW

        if (lagging) {
          merged = merged.subarray(merged.length - MAX_LIVE_WINDOW)
        }

        // Skip sub-second or silent chunks — nothing to say, and Whisper hallucinates on them.
        if (merged.length < WHISPER_RATE * 0.8 || rmsOf(merged) < 0.004) {
          continue
        }

        try {
          const text = await transcribeSamples(merged, update => {
            setLiveStatus(
              update.stage === 'loading-model'
                ? `Loading speech model… ${Math.round(update.progress ?? 0)}%`
                : 'Transcribing…'
            )
          })
          const { corrected } = correctPharmTerms(text)

          if (corrected && isRealSpeech(corrected)) {
            appendLiveSegment(lagging ? `… ${corrected}` : corrected)
          }
        } catch {
          liveFailedRef.current = true
          setLiveStatus('Live captions unavailable — audio still recording')

          return
        }
      }

      setLiveStatus('Listening…')
    } finally {
      livePumpingRef.current = false
    }
  }, [appendLiveSegment])

  const flushLiveChunk = useCallback(
    (sampleRate: number) => {
      if (liveSampleCountRef.current === 0) {
        return
      }

      const raw = concatSamples(liveBuffersRef.current)
      liveBuffersRef.current = []
      liveSampleCountRef.current = 0
      livePendingRef.current.push(downsampleTo16k(raw, sampleRate))
      void pumpLive()
    },
    [pumpLive]
  )

  /** Persist path: flush what's buffered, then wait (bounded) for the pump to drain. */
  const drainLive = useCallback(
    async (sampleRate: number) => {
      flushLiveChunk(sampleRate)

      const deadline = Date.now() + 45_000

      while ((livePumpingRef.current || livePendingRef.current.length > 0) && Date.now() < deadline) {
        await sleep(250)
      }
    },
    [flushLiveChunk]
  )

  const stopEverything = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    analyserRef.current = null

    if (processorRef.current) {
      processorRef.current.onaudioprocess = null

      try {
        processorRef.current.disconnect()
      } catch {
        // already torn down
      }

      processorRef.current = null
    }

    if (contextRef.current) {
      void contextRef.current.close().catch(() => {})
      contextRef.current = null
    }

    if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }

    for (const stream of streamsRef.current) {
      for (const track of stream.getTracks()) {
        track.stop()
      }
    }

    streamsRef.current = []
  }

  const sampleRateRef = useRef(48_000)

  const start = useCallback(async () => {
    setError(null)
    chunksRef.current = []
    liveBuffersRef.current = []
    liveSampleCountRef.current = 0
    livePendingRef.current = []
    liveFailedRef.current = false
    liveSegmentsRef.current = []
    setLiveSegments([])
    setLiveStatus('')
    setLectureNote(null)

    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamsRef.current.push(mic)

      const context = new AudioContext()
      contextRef.current = context
      sampleRateRef.current = context.sampleRate

      // One mix bus feeds everything: the recorder, the waveform, the live captions.
      // (A MediaStreamAudioDestinationNode has no outputs, so it can't be tapped directly.)
      const mix = context.createGain()
      const destination = context.createMediaStreamDestination()
      mix.connect(destination)
      context.createMediaStreamSource(mic).connect(mix)

      if (withSystemAudio) {
        // The main process answers this with the primary screen + loopback audio.
        // macOS shows its own Screen & System Audio Recording prompt on first use —
        // that OS-level consent gate is a feature, not a bug.
        const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
        streamsRef.current.push(display)

        // Audio-only capture: the mandatory video track is dropped immediately.
        for (const track of display.getVideoTracks()) {
          track.stop()
          display.removeTrack(track)
        }

        if (display.getAudioTracks().length) {
          context.createMediaStreamSource(display).connect(mix)
        }
      }

      // Waveform tap (analyser has no output path — display only).
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      mix.connect(analyser)
      analyserRef.current = analyser

      if (liveCaptions) {
        // Live-caption tap. The processor's output buffer stays zeroed (silence), so
        // connecting it to the speakers keeps the node clocked WITHOUT audible echo.
        setLiveStatus('Loading speech model…')
        void preloadTranscriber(update => {
          if (update.stage === 'loading-model') {
            setLiveStatus(`Loading speech model… ${Math.round(update.progress ?? 0)}%`)
          }
        }).then(() => setLiveStatus(current => (current.startsWith('Loading') ? 'Listening…' : current)))

        const processor = context.createScriptProcessor(4096, 1, 1)
        processor.onaudioprocess = event => {
          const data = event.inputBuffer.getChannelData(0)
          liveBuffersRef.current.push(new Float32Array(data))
          liveSampleCountRef.current += data.length

          if (liveSampleCountRef.current >= context.sampleRate * LIVE_CHUNK_SECONDS) {
            flushLiveChunk(context.sampleRate)
          }
        }
        mix.connect(processor)
        processor.connect(context.destination)
        processorRef.current = processor
      }

      const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' })
      recorder.ondataavailable = event => {
        if (event.data.size) {
          chunksRef.current.push(event.data)
        }
      }
      recorder.onstop = () => void persist()
      recorder.start(1000)
      recorderRef.current = recorder

      setElapsed(0)
      tickRef.current = setInterval(() => setElapsed(count => count + 1), 1000)
      setState('recording')
      requestAnimationFrame(() => drawWave())
    } catch (err) {
      stopEverything()
      setState('idle')
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Permission was declined. macOS Settings → Privacy & Security → Screen & System Audio Recording → allow Nemesis, then try again.'
          : err instanceof Error
            ? err.message
            : 'Could not start recording.'
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawWave, flushLiveChunk, liveCaptions, withSystemAudio])

  const stop = useCallback(() => {
    setState('saving')

    // Freeze live capture at the click so nothing accumulates while we drain the queue.
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null
    }

    flushLiveChunk(sampleRateRef.current)
    recorderRef.current?.stop()

    if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
  }, [flushLiveChunk])

  const persist = async () => {
    try {
      const at = new Date()
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      const buffer = new Uint8Array(await blob.arrayBuffer())
      let base64 = ''

      for (let i = 0; i < buffer.length; i += 0x8000) {
        base64 += String.fromCharCode(...buffer.subarray(i, i + 0x8000))
      }

      const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const write = window.hermesDesktop?.writeBinaryFile

      if (!write) {
        throw new Error('Saving is unavailable in this build.')
      }

      const fileName = `lecture-${stamp}.webm`
      await write(`${RECORDINGS_DIR}/${fileName}`, btoa(base64))
      await refreshList()

      // Let in-flight transcription finish (bounded), then auto-save the lecture note.
      setLiveStatus('Finishing transcript…')
      await drainLive(sampleRateRef.current)
      const transcript = liveSegmentsRef.current.join(' ').replace(/\s+/g, ' ').trim()

      if (transcript) {
        const title = lectureNoteTitle(at)
        await createFolder(LECTURE_FOLDER)
        await saveNote(
          title,
          `# ${title}\n\n*Auto-transcribed on this device while recording — a draft; review before relying on it.*\n*Audio: ${fileName} (Nemesis Recordings)*\n\n${transcript}\n`,
          LECTURE_FOLDER
        )
        setLectureNote(title)
      }

      setLiveStatus('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the recording.')
    } finally {
      stopEverything()
      setState('idle')
    }
  }

  const play = useCallback(
    async (file: RecordingFile) => {
      if (playing?.path === file.path) {
        setPlaying(null)

        return
      }

      const read = await window.hermesDesktop?.readFileDataUrl?.(file.path)
      const src = typeof read === 'string' ? read : (read as { dataUrl?: string } | undefined)?.dataUrl

      if (src) {
        setPlaying({ path: file.path, src })
      }
    },
    [playing]
  )

  const readAudioBuffer = async (file: RecordingFile): Promise<ArrayBuffer> => {
    const read = await window.hermesDesktop?.readFileDataUrl?.(file.path)
    const src = typeof read === 'string' ? read : (read as { dataUrl?: string } | undefined)?.dataUrl

    if (!src) {
      throw new Error('Could not read the recording file.')
    }

    return (await fetch(src)).arrayBuffer()
  }

  const transcribe = useCallback(async (file: RecordingFile) => {
    setTranscribingStatus(status => ({ ...status, [file.path]: 'Loading model…' }))

    try {
      const buffer = await readAudioBuffer(file)
      const text = await transcribeAudio(buffer, update =>
        setTranscribingStatus(status => ({
          ...status,
          [file.path]:
            update.stage === 'loading-model'
              ? `Loading model… ${Math.round(update.progress ?? 0)}%`
              : update.stage === 'decoding'
                ? 'Decoding audio…'
                : 'Transcribing…'
        }))
      )
      // Deterministic pharm-vocabulary pass: fixes garbled drug names ("Lycinepral" →
      // lisinopril) without any cloud call. See pharm-lexicon.ts.
      const { changes, corrected } = correctPharmTerms(text || '')
      setTranscripts(current => ({ ...current, [file.path]: corrected || '(No speech detected.)' }))
      setCorrections(current => ({ ...current, [file.path]: changes.length }))
    } catch (err) {
      setTranscripts(current => ({
        ...current,
        [file.path]: `Transcription failed: ${err instanceof Error ? err.message : 'unknown error'}`
      }))
    } finally {
      setTranscribingStatus(status => {
        const next = { ...status }
        delete next[file.path]

        return next
      })
    }
  }, [])

  const draftFlashcards = useCallback(
    (file: RecordingFile) => {
      const text = transcripts[file.path]

      if (!text) {
        return
      }

      setComposerDraft(
        'Turn this lecture transcript into 8-15 exam-quality flashcards for a pharmacy/health-sciences student. ' +
          'Application-level questions (mechanisms, adverse effects, interactions, monitoring), one concept per card, no "what is X" filler. ' +
          'Reply with ONLY tab-separated lines, one card per line: front<TAB>back. No headers, no numbering, no commentary — ' +
          "I'll paste your reply straight into Study → Import cards.\n\nTranscript:\n" +
          text
      )
      navigate(NEW_CHAT_ROUTE)
    },
    [navigate, transcripts]
  )

  const saveTranscriptNote = useCallback(
    async (file: RecordingFile) => {
      const text = transcripts[file.path]

      if (!text) {
        return
      }

      const title = `Lecture ${file.name.replace(/\.(webm|m4a|wav|aiff?|mp3)$/i, '').replace(/^lecture-/, '')}`
      await saveNote(title, `# ${title}\n\n*Transcribed by Nemesis — review before relying on it.*\n\n${text}\n`)
      setSavedNote(current => ({ ...current, [file.path]: true }))
    },
    [transcripts]
  )

  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const seconds = String(elapsed % 60).padStart(2, '0')

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="px-6 pb-2 pt-5">
        <h1 className="text-lg font-semibold">Recorder</h1>
        <p className="text-xs text-muted-foreground">
          Records your mic{withSystemAudio ? ' + this computer’s audio (the lecture/Zoom)' : ' only'} — locally, to
          your own files. You start it, you see it, you keep it.
        </p>
      </header>

      <section className="mx-6 mt-3 flex flex-col items-center gap-4 rounded-lg border border-border bg-card px-6 py-8">
        {state === 'recording' ? (
          <>
            <div className="flex items-center gap-3">
              <span className="relative flex size-3">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex size-3 rounded-full bg-primary" />
              </span>
              <span className="text-xs font-medium uppercase tracking-widest text-primary">On air — visible, on purpose</span>
            </div>
            <canvas className="h-16 w-full max-w-xl" height={64} ref={canvasRef} width={640} />
            <span className="text-2xl font-semibold tabular-nums">
              {minutes}:{seconds}
            </span>
            {liveCaptions && (
              <div className="w-full max-w-xl rounded-md border border-border bg-muted/30 px-3 py-2 text-left">
                <div className="flex items-center justify-between pb-1">
                  <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                    Live transcript — on this device
                  </span>
                  <span className="text-[10px] text-muted-foreground">{liveStatus}</span>
                </div>
                <div className="max-h-36 overflow-y-auto text-sm leading-relaxed" ref={liveScrollRef}>
                  {liveSegments.length ? (
                    liveSegments.join(' ')
                  ) : (
                    <span className="text-muted-foreground">Listening for speech…</span>
                  )}
                </div>
              </div>
            )}
            <Button onClick={stop} size="lg" variant="secondary">
              Stop &amp; save
            </Button>
          </>
        ) : (
          <>
            <Button disabled={state === 'saving'} onClick={() => void start()} size="lg">
              {state === 'saving' ? 'Saving…' : 'Start recording'}
            </Button>
            {state === 'saving' && liveStatus && <p className="text-xs text-muted-foreground">{liveStatus}</p>}
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                checked={withSystemAudio}
                className="accent-(--theme-primary)"
                onChange={event => setWithSystemAudio(event.target.checked)}
                type="checkbox"
              />
              Also capture this computer&rsquo;s audio (lecture, Zoom) — macOS will ask once
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                checked={liveCaptions}
                className="accent-(--theme-primary)"
                onChange={event => setLiveCaptions(event.target.checked)}
                type="checkbox"
              />
              Live transcript while recording — auto-saves a lecture note to the Library
            </label>
            {lectureNote && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs">
                <span>
                  Lecture note saved to Library → {LECTURE_FOLDER} <span className="text-primary">✓</span>
                </span>
                <Button
                  className="h-6 px-2 text-xs"
                  onClick={() => navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(lectureNote)}`)}
                  size="sm"
                  variant="outline"
                >
                  Open note
                </Button>
              </div>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[11px] text-muted-foreground">
              <IconLock size={12} />
              Nothing joins your call — capture &amp; transcription happen on this device only
            </span>
          </>
        )}
        {error && <p className="max-w-md text-center text-xs text-destructive">{error}</p>}
      </section>

      <section className="px-6 pb-8 pt-5">
        <h2 className="pb-2 text-sm font-medium">Saved recordings</h2>
        {recordings.length ? (
          <ul className="flex flex-col gap-1.5">
            {recordings.map(file => {
              const status = transcribingStatus[file.path]
              const transcript = transcripts[file.path]

              return (
                <li className="flex flex-col gap-2 rounded-md border border-border px-3 py-2" key={file.path}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <IconMicrophone className="shrink-0 text-muted-foreground" size={16} />
                      <div className="min-w-0">
                        <div className="truncate text-sm">{recordingLabel(file.name)}</div>
                        {status && <div className="text-[11px] text-primary">{status}</div>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        disabled={Boolean(status)}
                        onClick={() => void transcribe(file)}
                        size="sm"
                        variant="outline"
                      >
                        {status ? '…' : transcript ? 'Re-transcribe' : 'Transcribe'}
                      </Button>
                      <Button onClick={() => void play(file)} size="sm" variant="outline">
                        {playing?.path === file.path ? 'Hide' : 'Play'}
                      </Button>
                    </div>
                  </div>
                  {transcript && (
                    <div className="rounded-md bg-muted/40 p-3">
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{transcript}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                          disabled={savedNote[file.path]}
                          onClick={() => void saveTranscriptNote(file)}
                          size="sm"
                          variant="secondary"
                        >
                          {savedNote[file.path] ? 'Saved to Library ✓' : 'Save as note'}
                        </Button>
                        <Button onClick={() => draftFlashcards(file)} size="sm" variant="secondary">
                          Draft flashcards
                        </Button>
                        {(corrections[file.path] ?? 0) > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            {corrections[file.path]} pharm term{corrections[file.path] === 1 ? '' : 's'} auto-corrected
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <EmptyState
            className={cn('min-h-28')}
            description="Recordings save to Documents / Nemesis Recordings as ordinary audio files."
            title="No recordings yet"
          />
        )}
        {playing && <audio autoPlay className="mt-3 w-full" controls src={playing.src} />}
        <p className="pt-4 text-[11px] leading-relaxed text-muted-foreground">
          Recording other people may require their consent where you live — check your school&rsquo;s policy. Nemesis
          never records on its own and never hides the indicator. Transcription runs on your device (the first run
          downloads a small model); the text is a draft — review it before you rely on it.
        </p>
      </section>
    </div>
  )
}
