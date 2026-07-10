// Recorder — consent-first lecture capture with LIVE on-device captions. The deliberate
// ANTI-Cluely: user-initiated only, a large persistent ON-AIR indicator while recording,
// nothing hidden from screen shares. Captures the microphone plus system audio (Electron
// 39+ loopback via the macOS CoreAudio tap), mixes both into one Opus/WebM file under
// ~/Documents/Nemesis Recordings — and, while recording, streams ~8s chunks of the live
// mix through the local Whisper model so the transcript scrolls in as the lecture happens.
// On stop, the transcript auto-saves as a Library note (Lectures folder).
import { IconCheck, IconLock, IconMicrophone, IconSparkles } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { setComposerDraft } from '@/store/composer'

import { NoteEditor } from '../library/note-editor'
import { createFolder, saveNote } from '../library/vault'
import { LIBRARY_ROUTE, NEW_CHAT_ROUTE } from '../routes'
import { correctPharmTerms, detectPharmTerms } from './pharm-lexicon'
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
  // Live insights: drugs the lecture just touched (lexicon spotting, fully on-device).
  // Tapping queues them; after Stop, one click asks Nemesis about the whole queue.
  const [insights, setInsights] = useState<{ term: string; at: string; queued: boolean }[]>([])
  // Hyprnote-style notepad: the student TYPES while it listens; typed notes and the
  // transcript both land in the saved note (separate sections).
  const [title, setTitle] = useState('')
  const titleRef = useRef('')
  titleRef.current = title
  const notesRef = useRef('')
  const onNotesChange = useCallback((value: string) => {
    notesRef.current = value
  }, [])
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
    const rootStyle = getComputedStyle(document.documentElement)
    const accent =
      rootStyle.getPropertyValue('--theme-primary').trim() || rootStyle.getPropertyValue('--ui-text-primary').trim()

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

    const terms = detectPharmTerms(text)

    if (terms.length) {
      const at = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      setInsights(current => {
        const known = new Set(current.map(insight => insight.term))
        const fresh = terms.filter(term => !known.has(term)).map(term => ({ at, queued: false, term }))

        return fresh.length ? [...fresh, ...current].slice(0, 30) : current
      })
    }
  }, [])

  const toggleQueued = useCallback((term: string) => {
    setInsights(current =>
      current.map(insight => (insight.term === term ? { ...insight, queued: !insight.queued } : insight))
    )
  }, [])

  // Granola/Hyprnote's signature move: after the lecture, the agent turns rough notes +
  // transcript into structured AI notes in the SAME Library file while preserving the
  // raw transcript as the durable source material.
  const enhanceNote = useCallback(() => {
    if (!lectureNote) {
      return
    }

    setComposerDraft(
      `Open my lecture note "${lectureNote}.md" in ~/Documents/Nemesis Library/${LECTURE_FOLDER}/ and add a clean, structured "AI notes" section immediately above the existing "Transcript" section. ` +
        'Use both "My notes" and "Transcript" as source material: keep my wording where it is good, fix transcription garbles against pharmacology vocabulary, ' +
        'and organize the AI notes with useful headings and bullets. Preserve the original Transcript section, My notes section, and the header lines about the recording date and audio file. Update that same file with the result. ' +
        'At the end add a "Flashcard candidates" section with 5 exam-style Q&A pairs from this lecture. Tell me when the file is updated.'
    )
    navigate(NEW_CHAT_ROUTE)
  }, [lectureNote, navigate])

  const askQueued = useCallback(() => {
    const queued = insights.filter(insight => insight.queued).map(insight => insight.term)

    if (!queued.length) {
      return
    }

    const context = liveSegmentsRef.current.slice(-6).join(' ').slice(-1200)
    setComposerDraft(
      `These drugs came up in the lecture I just recorded: ${queued.join(', ')}. ` +
        'For each, give me the exam-relevant rundown: drug class, mechanism in one line, the classic adverse effect, ' +
        'and the single interaction I must know — cite PMIDs inline where it matters.' +
        (context ? `\n\nTranscript context:\n"${context}"` : '')
    )
    navigate(NEW_CHAT_ROUTE)
  }, [insights, navigate])

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
    setInsights([])
    notesRef.current = ''
    setTitle(lectureNoteTitle(new Date()))

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

      // Let in-flight transcription finish (bounded), then auto-save the companion
      // Library note. Even a silent capture gets a durable placeholder beside its audio.
      setLiveStatus('Finishing transcript…')
      await drainLive(sampleRateRef.current)
      const transcript = liveSegmentsRef.current.join(' ').replace(/\s+/g, ' ').trim()
      const typedNotes = notesRef.current.trim()
      const noteTitle = titleRef.current.trim() || lectureNoteTitle(at)
      await createFolder(LECTURE_FOLDER)
      await saveNote(
        noteTitle,
        `# ${noteTitle}\n\n*Recorded ${at.toLocaleString(undefined, { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short' })} — my notes + on-device transcript (a draft; review before relying on it).*\n*Audio: ${fileName} (Nemesis Recordings)*\n\n## My notes\n\n${typedNotes || '_none taken_'}\n\n## Transcript\n\n${transcript || '_no speech captured_'}\n`,
        LECTURE_FOLDER
      )
      setLectureNote(noteTitle)

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

  // Recording = a full-page notepad workspace (Hyprnote/Granola pattern: an AI notepad
  // that listens while you write). Idle = the start card + saved recordings.
  if (state === 'recording') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-(--ui-editor-surface-background) px-5 pb-5 pt-4">
        <div className="mb-4 flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-4 py-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
          <span className="relative flex size-3 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-(--theme-primary) opacity-50" />
            <span className="relative inline-flex size-3 rounded-full bg-(--theme-primary)" />
          </span>
          <span className="shrink-0 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">On air</span>
          <input
            aria-label="Lecture title"
            className="min-w-40 flex-1 border-none bg-transparent text-lg font-semibold tracking-tight outline-none placeholder:text-muted-foreground/50"
            onChange={event => setTitle(event.target.value)}
            placeholder="Lecture title"
            value={title}
          />
          <span className="shrink-0 rounded-full bg-(--ui-bg-quaternary) px-3 py-1 text-sm font-semibold tabular-nums text-(--ui-text-secondary)">
            {minutes}:{seconds}
          </span>
          <Button className="transition-transform duration-200 ease-out active:scale-[0.98]" onClick={stop} size="sm" variant="destructive">
            Stop &amp; save
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(19rem,0.82fr)_minmax(0,1.18fr)]">
          {/* Live capture: waveform, transcript, and insights */}
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div className="shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">Audio signal</span>
                <span className="text-[0.65rem] text-(--ui-text-quaternary)">Mic{withSystemAudio ? ' + system' : ''}</span>
              </div>
              <canvas className="h-16 w-full rounded-xl bg-(--ui-bg-quaternary)" height={64} ref={canvasRef} width={420} />
            </div>

            {liveCaptions ? (
              <>
                <div className="flex min-h-40 shrink-0 flex-col rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">
                      Live transcript
                    </span>
                    <span className="truncate text-[0.65rem] text-muted-foreground">{liveStatus}</span>
                  </div>
                  <div className="max-h-72 space-y-2 overflow-y-auto text-[13px] leading-relaxed" ref={liveScrollRef}>
                    {liveSegments.length ? (
                      liveSegments.map((segment, index) => (
                        <p className="animate-in fade-in-0 border-l border-(--ui-stroke-quaternary) pl-3 duration-200 ease-out" key={`${index}-${segment.slice(0, 18)}`}>
                          {segment}
                        </p>
                      ))
                    ) : (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">Listening</p>
                        <p className="mt-1 text-xs text-muted-foreground">Speech will appear here as the lecture continues.</p>
                      </div>
                    )}
                  </div>
                </div>
                {insights.length > 0 && (
                  <div className="shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">
                        <IconSparkles size={12} />
                        Mentioned
                      </span>
                      <span className="text-[0.65rem] text-muted-foreground">Tap to queue</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {insights.map(insight => (
                        <button
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-[transform,color,border-color,background-color] duration-200 ease-out active:scale-[0.98]',
                            insight.queued
                              ? 'border-(--theme-primary)/45 bg-(--ui-bg-primary) text-foreground'
                              : 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) text-muted-foreground hover:border-(--theme-primary)/35 hover:text-foreground'
                          )}
                          key={insight.term}
                          onClick={() => toggleQueued(insight.term)}
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
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">Live transcript off</p>
                <p className="mt-1 text-xs text-muted-foreground">Audio is still recording and can be transcribed later.</p>
              </div>
            )}
            <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
              <IconLock size={12} />
              On this device only — nothing joins your call
            </span>
          </div>

          {/* Notepad — type while it listens */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
            <div className="shrink-0 border-b border-(--ui-stroke-tertiary) px-5 py-3">
              <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                My notes · type while it listens
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-5">
              <NoteEditor initialValue="" onChange={onNotesChange} onOpenWikilink={() => {}} />
            </div>
          </div>
        </div>
        {error && <p className="pt-2 text-center text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-(--ui-editor-surface-background)">
      <header className="px-6 pb-2 pt-6">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">Capture desk</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em]">Recorder</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Records your mic{withSystemAudio ? ' + this computer’s audio (the lecture/Zoom)' : ' only'} — locally, to
          your own files. You start it, you see it, you keep it. While it records, you get a notepad, a live
          transcript, and the drugs mentioned — as they happen.
        </p>
      </header>

      <section className="mx-6 mt-4 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
        <div className="grid items-stretch lg:grid-cols-[minmax(0,0.9fr)_minmax(22rem,1.1fr)]">
          <div className="flex items-center gap-5 border-b border-(--ui-stroke-tertiary) p-6 lg:border-b-0 lg:border-r">
            <div className="grid size-24 shrink-0 place-items-center rounded-full border border-(--theme-primary)/25 bg-(--ui-bg-primary) shadow-[inset_0_0_0_7px_var(--ui-bg-elevated)]">
              <Button
                aria-label="Start recording"
                className="size-20 rounded-full shadow-lg transition-[transform,opacity] duration-200 ease-out active:scale-[0.96]"
                disabled={state === 'saving'}
                onClick={() => void start()}
                size="icon-lg"
              >
                <IconMicrophone className="size-7" />
              </Button>
            </div>
            <div className="min-w-0">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">
                {state === 'saving' ? 'Finishing capture' : 'Ready to record'}
              </p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">
                {state === 'saving' ? 'Saving your lecture' : 'Capture the lecture, keep the context'}
              </h2>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                {state === 'saving'
                  ? (liveStatus || 'Writing audio and notes to disk…')
                  : 'One click opens a live notepad, waveform, transcript, and pharmacology mentions.'}
              </p>
            </div>
          </div>

          <div className="flex flex-col justify-center gap-2 p-4">
            <label className="group flex cursor-pointer items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors duration-200 ease-out hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-bg-quaternary)">
              <input
                checked={withSystemAudio}
                className="peer sr-only"
                onChange={event => setWithSystemAudio(event.target.checked)}
                type="checkbox"
              />
              <span className="relative h-5 w-9 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors duration-200 ease-out after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform after:duration-200 after:ease-out peer-focus-visible:ring-2 peer-focus-visible:ring-(--theme-primary)/35 peer-checked:bg-(--theme-primary) peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground" />
              <span className="min-w-0">
                <span className="block text-xs font-semibold">Computer audio</span>
                <span className="block text-[0.6875rem] leading-relaxed text-muted-foreground">Capture the lecture or Zoom audio · macOS asks once</span>
              </span>
            </label>
            <label className="group flex cursor-pointer items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors duration-200 ease-out hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-bg-quaternary)">
              <input
                checked={liveCaptions}
                className="peer sr-only"
                onChange={event => setLiveCaptions(event.target.checked)}
                type="checkbox"
              />
              <span className="relative h-5 w-9 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors duration-200 ease-out after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform after:duration-200 after:ease-out peer-focus-visible:ring-2 peer-focus-visible:ring-(--theme-primary)/35 peer-checked:bg-(--theme-primary) peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground" />
              <span className="min-w-0">
                <span className="block text-xs font-semibold">Live transcript</span>
                <span className="block text-[0.6875rem] leading-relaxed text-muted-foreground">Auto-save a lecture note to the Library</span>
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
            <span className="mr-auto inline-flex items-center gap-1.5 font-medium">
              <IconCheck className="text-(--theme-primary)" size={13} />
              Transcript note saved to Library / {LECTURE_FOLDER} as {lectureNote}.md
            </span>
            <Button onClick={() => navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(lectureNote)}`)} size="xs" variant="outline">
              Open note
            </Button>
            <Button onClick={enhanceNote} size="xs" variant="secondary">
              <IconSparkles size={12} />
              Enhance with Nemesis
            </Button>
            {insights.some(insight => insight.queued) && (
              <Button onClick={askQueued} size="xs" variant="outline">
                Ask about {insights.filter(insight => insight.queued).length} queued drug
                {insights.filter(insight => insight.queued).length === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        )}
        {error && <p className="border-t border-(--ui-stroke-tertiary) px-5 py-3 text-xs text-destructive">{error}</p>}
      </section>

      <section className="px-6 pb-8 pt-7">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">Archive</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">Saved recordings</h2>
          </div>
          <span className="rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-2.5 py-1 text-[0.6875rem] font-medium tabular-nums text-muted-foreground">
            {recordings.length} recording{recordings.length === 1 ? '' : 's'}
          </span>
        </div>
        {recordings.length ? (
          <ul className="flex flex-col gap-2">
            {recordings.map(file => {
              const status = transcribingStatus[file.path]
              const transcript = transcripts[file.path]

              return (
                <li className="group flex flex-col gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 transition-[transform,border-color] duration-200 ease-out hover:border-(--theme-primary)/25 active:scale-[0.995]" key={file.path}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-(--ui-stroke-quaternary) bg-(--ui-bg-quaternary) text-(--theme-primary)">
                        <IconMicrophone size={17} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">Lecture recording</div>
                        <div className="truncate text-[0.6875rem] tabular-nums text-muted-foreground">{recordingLabel(file.name)}</div>
                        {status && (
                          <div className="mt-1 inline-flex items-center gap-1.5 text-[0.6875rem] font-medium text-(--theme-primary)">
                            <span className="size-1.5 animate-pulse rounded-full bg-(--theme-primary)" />
                            {status}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Tip label={transcript ? 'Re-transcribe' : 'Transcribe'}>
                        <Button
                          aria-label={transcript ? 'Re-transcribe' : 'Transcribe'}
                          className="transition-transform duration-200 ease-out active:scale-[0.98]"
                          disabled={Boolean(status)}
                          onClick={() => void transcribe(file)}
                          size="icon-sm"
                          variant="outline"
                        >
                          <Codicon name="sparkle" />
                        </Button>
                      </Tip>
                      <Tip label={playing?.path === file.path ? 'Hide player' : 'Play'}>
                        <Button
                          aria-label={playing?.path === file.path ? 'Hide player' : 'Play'}
                          className="transition-transform duration-200 ease-out active:scale-[0.98]"
                          onClick={() => void play(file)}
                          size="icon-sm"
                          variant="outline"
                        >
                          <Codicon name={playing?.path === file.path ? 'debug-pause' : 'play'} />
                        </Button>
                      </Tip>
                    </div>
                  </div>
                  {transcript && (
                    <div className="rounded-xl border border-(--ui-stroke-quaternary) bg-(--ui-bg-quaternary) p-3">
                      <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">Transcript</p>
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
          <div className="rounded-2xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-5 py-7">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">Nothing captured</p>
            <p className="mt-1 text-xs text-muted-foreground">Recordings save to Documents / Nemesis Recordings as ordinary audio files.</p>
          </div>
        )}
        {playing && <audio autoPlay className="mt-3 w-full" controls src={playing.src} />}
        <div className="flex items-center gap-1.5 pt-4 text-[0.6875rem] text-muted-foreground">
          <IconLock size={11} />
          <span>Local by design ·</span>
          <Tip
            className="max-w-sm whitespace-normal text-left leading-relaxed"
            label={
              <span>
                Recording other people may require their consent where you live — check your school&rsquo;s policy.
                Nemesis never records on its own and never hides the indicator. Transcription runs on your device
                (the first run downloads a small model); the text is a draft — review it before you rely on it.
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
    </div>
  )
}
