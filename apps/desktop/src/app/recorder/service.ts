// Module-scoped recorder engine. Nothing in this file depends on RecorderView's
// lifecycle: streams, timers, transcription, the notepad draft, and persistence keep
// running when the student navigates elsewhere in the desktop app.
import { atom } from 'nanostores'

import { createFolder, saveNote } from '../library/vault'

import { deriveRecordingTitle } from './autoname'
import { correctPharmTerms, detectPharmTerms } from './pharm-lexicon'

export const RECORDINGS_DIR = '~/Documents/Nemesis Recordings'
export const LECTURE_FOLDER = 'Lectures'

const LIVE_CHUNK_SECONDS = 8
const WHISPER_RATE = 16_000
const MAX_LIVE_WINDOW = WHISPER_RATE * 30

export type RecordingState = 'idle' | 'recording' | 'stopping'

export interface LiveInsight {
  at: string
  queued: boolean
  term: string
}

export const $recording = atom<RecordingState>('idle')
export const $starting = atom(false)
export const $paused = atom(false)
export const $elapsedMs = atom(0)
export const $liveTranscript = atom<string[]>([])
export const $liveInsights = atom<LiveInsight[]>([])
export const $liveStatus = atom('')
export const $recordingError = atom<null | string>(null)
export const $recordingTitle = atom('')
export const $notepadDraft = atom('')
export const $systemAudioEnabled = atom(true)
export const $liveCaptionsEnabled = atom(true)
export const $recentLectureNote = atom<null | string>(null)
export const $recordingsVersion = atom(0)

let recorder: MediaRecorder | null = null
let streams: MediaStream[] = []
let chunks: Blob[] = []
let tick: null | ReturnType<typeof setInterval> = null
let analyser: AnalyserNode | null = null
let context: AudioContext | null = null
let processor: ScriptProcessorNode | null = null
let liveBuffers: Float32Array[] = []
let liveSampleCount = 0
let livePending: Float32Array[] = []
let livePumping = false
let liveFailed = false
let sampleRate = 48_000
let startedAt = 0
let pausedAt = 0
let pausedTotal = 0
// True once the student types in the title field this recording — auto-naming then
// stands down completely (both the live retitle and the final pass in persist()).
let titleEdited = false

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function concatSamples(sampleChunks: Float32Array[]): Float32Array {
  const total = sampleChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Float32Array(total)
  let offset = 0

  for (const chunk of sampleChunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }

  return out
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === WHISPER_RATE) {
    return input
  }

  const ratio = inputRate / WHISPER_RATE
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)

  for (let index = 0; index < length; index++) {
    const position = index * ratio
    const left = Math.floor(position)
    const fraction = position - left
    const a = input[left] ?? 0
    const b = input[left + 1] ?? a
    out[index] = a + (b - a) * fraction
  }

  return out
}

function rmsOf(samples: Float32Array): number {
  let sum = 0

  for (let index = 0; index < samples.length; index++) {
    sum += samples[index] * samples[index]
  }

  return Math.sqrt(sum / Math.max(1, samples.length))
}

function isRealSpeech(text: string): boolean {
  const letters = text.replace(/[^a-z]/gi, '')

  return letters.length >= 3 && !/^\[?blank[_ ]?audio\]?$/i.test(text.trim())
}

function lectureNoteTitle(date: Date): string {
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/:/g, '.')

  return `Lecture ${day} ${time}`
}

function appendLiveSegment(text: string): void {
  const nextTranscript = [...$liveTranscript.get(), text]
  $liveTranscript.set(nextTranscript)

  // Live auto-naming: as soon as enough has been said, the title field renames
  // itself from the transcript — unless the student already typed their own.
  if (!titleEdited) {
    const derived = deriveRecordingTitle(nextTranscript.join(' '), new Date(startedAt || Date.now()))

    if (derived && derived !== $recordingTitle.get()) {
      $recordingTitle.set(derived)
    }
  }

  const terms = detectPharmTerms(text)

  if (terms.length === 0) {
    return
  }

  const at = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const current = $liveInsights.get()
  const known = new Set(current.map(insight => insight.term))
  const fresh = terms.filter(term => !known.has(term)).map(term => ({ at, queued: false, term }))

  if (fresh.length) {
    $liveInsights.set([...fresh, ...current].slice(0, 30))
  }
}

async function pumpLive(): Promise<void> {
  if (livePumping || liveFailed) {
    return
  }

  livePumping = true

  try {
    while (livePending.length > 0) {
      let merged = concatSamples(livePending.splice(0))
      const lagging = merged.length > MAX_LIVE_WINDOW

      if (lagging) {
        merged = merged.subarray(merged.length - MAX_LIVE_WINDOW)
      }

      if (merged.length < WHISPER_RATE * 0.8 || rmsOf(merged) < 0.004) {
        continue
      }

      try {
        const { transcribeSamples } = await import('./transcribe')

        const text = await transcribeSamples(merged, update => {
          $liveStatus.set(
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
        liveFailed = true
        $liveStatus.set('Live captions unavailable — audio still recording')

        return
      }
    }

    if ($recording.get() === 'recording') {
      $liveStatus.set($paused.get() ? 'Paused' : 'Listening…')
    }
  } finally {
    livePumping = false
  }
}

function flushLiveChunk(inputRate: number): void {
  if (liveSampleCount === 0) {
    return
  }

  const raw = concatSamples(liveBuffers)
  liveBuffers = []
  liveSampleCount = 0
  livePending.push(downsampleTo16k(raw, inputRate))
  void pumpLive()
}

async function drainLive(inputRate: number): Promise<void> {
  flushLiveChunk(inputRate)
  const deadline = Date.now() + 45_000

  while ((livePumping || livePending.length > 0) && Date.now() < deadline) {
    await sleep(250)
  }
}

function refreshElapsed(): void {
  if (!startedAt) {
    $elapsedMs.set(0)

    return
  }

  const end = pausedAt || Date.now()
  $elapsedMs.set(Math.max(0, end - startedAt - pausedTotal))
}

function stopTimer(): void {
  if (tick) {
    clearInterval(tick)
    tick = null
  }
}

function releaseCapture(): void {
  analyser = null

  if (processor) {
    processor.onaudioprocess = null

    try {
      processor.disconnect()
    } catch {
      // The audio graph may already be torn down.
    }

    processor = null
  }

  if (context) {
    void context.close().catch(() => {})
    context = null
  }

  stopTimer()

  for (const stream of streams) {
    for (const track of stream.getTracks()) {
      track.stop()
    }
  }

  streams = []
  recorder = null
  startedAt = 0
  pausedAt = 0
  pausedTotal = 0
  $paused.set(false)
}

async function persist(): Promise<void> {
  try {
    const at = new Date()
    const blob = new Blob(chunks, { type: 'audio/webm' })
    const buffer = new Uint8Array(await blob.arrayBuffer())
    let binary = ''

    for (let index = 0; index < buffer.length; index += 0x8000) {
      binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000))
    }

    const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const write = window.hermesDesktop?.writeBinaryFile

    if (!write) {
      throw new Error('Saving is unavailable in this build.')
    }

    const fileName = `lecture-${stamp}.webm`
    await write(`${RECORDINGS_DIR}/${fileName}`, btoa(binary))

    $liveStatus.set('Finishing transcript…')
    await drainLive(sampleRate)
    const transcript = $liveTranscript.get().join(' ').replace(/\s+/g, ' ').trim()
    const typedNotes = $notepadDraft.get().trim()
    const typedTitle = $recordingTitle.get().trim()
    // Final naming pass over the complete transcript; a student-typed title always wins.
    const noteTitle =
      titleEdited && typedTitle
        ? typedTitle
        : (deriveRecordingTitle(transcript, at) ?? (typedTitle || lectureNoteTitle(at)))
    await createFolder(LECTURE_FOLDER)
    await saveNote(
      noteTitle,
      `# ${noteTitle}\n\n*Recorded ${at.toLocaleString(undefined, { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short' })} — my notes + on-device transcript (a draft; review before relying on it).*\n*Audio: ${fileName} (Nemesis Recordings)*\n\n## My notes\n\n${typedNotes || '_none taken_'}\n\n## Transcript\n\n${transcript || '_no speech captured_'}\n`,
      LECTURE_FOLDER
    )
    $recentLectureNote.set(noteTitle)
    $liveStatus.set('')
  } catch (error) {
    $recordingError.set(error instanceof Error ? error.message : 'Could not save the recording.')
  } finally {
    releaseCapture()
    $recording.set('idle')
    $recordingsVersion.set($recordingsVersion.get() + 1)
  }
}

export async function startRecording(): Promise<void> {
  if ($recording.get() !== 'idle' || $starting.get()) {
    return
  }

  $starting.set(true)
  $recordingError.set(null)
  chunks = []
  liveBuffers = []
  liveSampleCount = 0
  livePending = []
  liveFailed = false
  $liveTranscript.set([])
  $liveStatus.set('')
  $liveInsights.set([])
  $notepadDraft.set('')
  $recentLectureNote.set(null)
  titleEdited = false
  $recordingTitle.set(lectureNoteTitle(new Date()))

  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
    streams.push(mic)

    context = new AudioContext()
    sampleRate = context.sampleRate
    const mix = context.createGain()
    const destination = context.createMediaStreamDestination()
    mix.connect(destination)
    context.createMediaStreamSource(mic).connect(mix)

    if ($systemAudioEnabled.get()) {
      const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
      streams.push(display)

      for (const track of display.getVideoTracks()) {
        track.stop()
        display.removeTrack(track)
      }

      if (display.getAudioTracks().length) {
        context.createMediaStreamSource(display).connect(mix)
      }
    }

    analyser = context.createAnalyser()
    analyser.fftSize = 1024
    mix.connect(analyser)

    if ($liveCaptionsEnabled.get()) {
      $liveStatus.set('Loading speech model…')
      void import('./transcribe')
        .then(({ preloadTranscriber }) =>
          preloadTranscriber(update => {
            if (update.stage === 'loading-model') {
              $liveStatus.set(`Loading speech model… ${Math.round(update.progress ?? 0)}%`)
            }
          })
        )
        .then(() => {
          if ($recording.get() === 'recording' && $liveStatus.get().startsWith('Loading')) {
            $liveStatus.set('Listening…')
          }
        })

      processor = context.createScriptProcessor(4096, 1, 1)

      processor.onaudioprocess = event => {
        const data = event.inputBuffer.getChannelData(0)
        liveBuffers.push(new Float32Array(data))
        liveSampleCount += data.length

        if (liveSampleCount >= (context?.sampleRate ?? sampleRate) * LIVE_CHUNK_SECONDS) {
          flushLiveChunk(context?.sampleRate ?? sampleRate)
        }
      }

      mix.connect(processor)
      processor.connect(context.destination)
    }

    recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' })

    recorder.ondataavailable = event => {
      if (event.data.size) {
        chunks.push(event.data)
      }
    }

    recorder.onstop = () => void persist()
    recorder.start(1000)

    startedAt = Date.now()
    pausedAt = 0
    pausedTotal = 0
    $elapsedMs.set(0)
    tick = setInterval(refreshElapsed, 250)
    $recording.set('recording')
  } catch (error) {
    releaseCapture()
    $recording.set('idle')
    $recordingError.set(
      error instanceof Error && error.name === 'NotAllowedError'
        ? 'Permission was declined. macOS Settings → Privacy & Security → Screen & System Audio Recording → allow Nemesis, then try again.'
        : error instanceof Error
          ? error.message
          : 'Could not start recording.'
    )
  } finally {
    $starting.set(false)
  }
}

export function stopRecording(): void {
  if ($recording.get() !== 'recording' || !recorder) {
    return
  }

  refreshElapsed()
  $recording.set('stopping')
  stopTimer()

  if (processor) {
    processor.onaudioprocess = null
  }

  flushLiveChunk(sampleRate)
  recorder.stop()
}

export async function pauseRecording(): Promise<void> {
  if ($recording.get() !== 'recording' || $paused.get() || !recorder) {
    return
  }

  recorder.pause()
  pausedAt = Date.now()
  refreshElapsed()
  $paused.set(true)
  $liveStatus.set('Paused')
  await context?.suspend()
}

export async function resumeRecording(): Promise<void> {
  if ($recording.get() !== 'recording' || !$paused.get() || !recorder) {
    return
  }

  await context?.resume()
  pausedTotal += Date.now() - pausedAt
  pausedAt = 0
  recorder.resume()
  $paused.set(false)
  $liveStatus.set(liveFailed ? 'Live captions unavailable — audio still recording' : 'Listening…')
}

export function setRecordingPaused(paused: boolean): Promise<void> {
  return paused ? pauseRecording() : resumeRecording()
}

export function setRecordingTitle(title: string): void {
  titleEdited = true
  $recordingTitle.set(title)
}

export function setNotepadDraft(draft: string): void {
  $notepadDraft.set(draft)
}

export function setSystemAudioEnabled(enabled: boolean): void {
  $systemAudioEnabled.set(enabled)
}

export function setLiveCaptionsEnabled(enabled: boolean): void {
  $liveCaptionsEnabled.set(enabled)
}

export function toggleLiveInsight(term: string): void {
  $liveInsights.set(
    $liveInsights.get().map(insight => (insight.term === term ? { ...insight, queued: !insight.queued } : insight))
  )
}

export function getRecordingAnalyser(): AnalyserNode | null {
  return analyser
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')

  return `${minutes}:${seconds}`
}
