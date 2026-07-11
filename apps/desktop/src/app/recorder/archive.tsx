// Saved recordings — inline master/detail. The list (left) is everything under
// ~/Documents/Nemesis Recordings; selecting one (right) shows its audio playback, the
// "AI notes" Nemesis wrote when asked to enhance it, and the raw transcript — all pulled
// from the auto-saved companion Library note when one exists (see `persist()` in
// index.tsx, which writes `*Audio: <filename> (Nemesis Recordings)*` into every lecture
// note it creates). Recordings from before that linking existed, or whose note was moved
// or deleted, fall back to on-demand Whisper transcription via the same pipeline the live
// capture uses.
//
// Audio is streamed through the hermes-media:// protocol (registered in electron/main.ts)
// rather than the readFileDataUrl IPC: that IPC base64-loads the whole file into memory and
// is hard-capped at 16MB, which a lecture-length recording routinely exceeds. The custom
// protocol goes through the same path-hardening resolver with no size cap and supports
// seeking — the same mechanism chat's audio/video attachments already use.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { NavigateFunction } from 'react-router-dom'

import { mediaStreamUrl } from '@/lib/media'
import { setComposerDraft } from '@/store/composer'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { loadFolderNotes, saveNote, type VaultNote } from '../library/vault'
import {
  PanelAction,
  PanelBody,
  PanelDetail,
  PanelEmpty,
  PanelList,
  PanelListRow,
  PanelPill,
  PanelSectionLabel
} from '../overlays/panel'
import { NEW_CHAT_ROUTE } from '../routes'

import { correctPharmTerms } from './pharm-lexicon'
import { transcribeAudio } from './transcribe'

export const RECORDINGS_DIR = '~/Documents/Nemesis Recordings'
export const LECTURE_FOLDER = 'Lectures'

const AUDIO_FILE_RE = /\.(webm|m4a|wav)$/i

export interface RecordingFile {
  name: string
  path: string
  /** The auto-saved Library note for this recording, matched by its embedded
   *  "Audio: <filename>" marker. Null for recordings that predate note-linking,
   *  or whose note was since moved or deleted. */
  note: VaultNote | null
}

function audioMarker(fileName: string): string {
  return `Audio: ${fileName} (Nemesis Recordings)`
}

/** "lecture-2026-07-09T20-28-01.webm" → "Jul 9, 2026 · 8:28 PM"; else the raw name. */
export function recordingLabel(name: string): string {
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

/** Compact time-only form for the dense row list ("8:28 PM"). */
function recordingTime(name: string): string {
  const match = name.match(/T(\d{2})-(\d{2})-(\d{2})/)

  if (!match) {
    return ''
  }

  const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]))

  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Load saved recordings and best-effort match each to its auto-saved Library note. */
export async function loadRecordingFiles(): Promise<RecordingFile[]> {
  const [dir, notes] = await Promise.all([
    window.hermesDesktop?.readDir?.(RECORDINGS_DIR),
    loadFolderNotes(LECTURE_FOLDER).catch(() => [] as VaultNote[])
  ])

  return (dir?.entries ?? [])
    .filter(entry => !entry.isDirectory && AUDIO_FILE_RE.test(entry.name))
    .map(entry => ({
      name: entry.name,
      note: notes.find(note => note.content.includes(audioMarker(entry.name))) ?? null,
      path: entry.path
    }))
    .sort((a, b) => b.name.localeCompare(a.name))
}

const PLACEHOLDER_BODY_RE = /^_.*_$/

interface LectureSections {
  aiNotes: string
  myNotes: string
  transcript: string
}

/** Split the auto-saved lecture note into its "## " sections. Lenient about heading
 *  order and about "AI notes" possibly not existing yet — Nemesis only adds it once the
 *  user asks to enhance the note (see enhanceLectureNote below). Known placeholder bodies
 *  ("_none taken_", "_no speech captured_") count as empty. */
export function parseLectureSections(content: string): LectureSections {
  const byHeading = new Map<string, string>()

  for (const chunk of content.split(/^##[ \t]+/m).slice(1)) {
    const breakAt = chunk.search(/\r?\n/)
    const heading = (breakAt === -1 ? chunk : chunk.slice(0, breakAt)).trim().toLowerCase()
    const body = (breakAt === -1 ? '' : chunk.slice(breakAt + 1)).trim()

    if (!byHeading.has(heading)) {
      byHeading.set(heading, PLACEHOLDER_BODY_RE.test(body) ? '' : body)
    }
  }

  return {
    aiNotes: byHeading.get('ai notes') ?? '',
    myNotes: byHeading.get('my notes') ?? '',
    transcript: byHeading.get('transcript') ?? ''
  }
}

/** Ask Nemesis to fold rough notes + transcript into a structured "AI notes" section on
 *  the given lecture note. Shared by the post-recording banner (index.tsx, for the note
 *  just saved) and the archive detail view below (for any past recording). */
export function enhanceLectureNote(noteTitle: string, navigate: NavigateFunction): void {
  setComposerDraft(
    `Open my lecture note "${noteTitle}.md" in ~/Documents/Nemesis Library/${LECTURE_FOLDER}/ and add a clean, structured "AI notes" section immediately above the existing "Transcript" section. ` +
      'Use both "My notes" and "Transcript" as source material: keep my wording where it is good, fix transcription garbles against pharmacology vocabulary, ' +
      'and organize the AI notes with useful headings and bullets. Preserve the original Transcript section, My notes section, and the header lines about the recording date and audio file. Update that same file with the result. ' +
      'At the end add a "Flashcard candidates" section with 5 exam-style Q&A pairs from this lecture. Tell me when the file is updated.'
  )
  navigate(NEW_CHAT_ROUTE)
}

/** Read a saved recording's audio as bytes, streamed through the same uncapped protocol
 *  the player uses (fixes on-demand transcription throwing on lecture-length files that
 *  would blow past readFileDataUrl's 16MB cap). */
async function readAudioBuffer(file: RecordingFile): Promise<ArrayBuffer> {
  const response = await fetch(mediaStreamUrl(file.path))

  if (!response.ok) {
    throw new Error('Could not read the recording file.')
  }

  return response.arrayBuffer()
}

function draftFlashcardsPrompt(transcript: string): string {
  return (
    'Turn this lecture transcript into 8-15 exam-quality flashcards for a pharmacy/health-sciences student. ' +
    'Application-level questions (mechanisms, adverse effects, interactions, monitoring), one concept per card, no "what is X" filler. ' +
    'Reply with ONLY tab-separated lines, one card per line: front<TAB>back. No headers, no numbering, no commentary — ' +
    "I'll paste your reply straight into Study → Import cards.\n\nTranscript:\n" +
    transcript
  )
}

export function RecordingArchive({ reloadToken }: { reloadToken: number }) {
  const navigate = useNavigate()
  const [recordings, setRecordings] = useState<RecordingFile[]>([])
  const [selectedPath, setSelectedPath] = useState<null | string>(null)
  const [transcripts, setTranscripts] = useState<Record<string, string>>({})
  const [corrections, setCorrections] = useState<Record<string, number>>({})
  const [transcribingStatus, setTranscribingStatus] = useState<Record<string, string>>({})
  const [savedNote, setSavedNote] = useState<Record<string, boolean>>({})

  const reload = useCallback(async () => {
    try {
      setRecordings(await loadRecordingFiles())
    } catch {
      // listing is best-effort; individual actions below report their own errors
    }
  }, [])

  useEffect(() => {
    void reload()
    // Re-run whenever the caller bumps reloadToken (a recording just finished saving).
  }, [reload, reloadToken])

  // Press "r" to pick up a note that "Enhance with Nemesis" updated in a chat turn —
  // the selected recording's note snapshot otherwise stays as of the last load.
  useRefreshHotkey(reload)

  const selected = recordings.find(file => file.path === selectedPath) ?? recordings[0] ?? null

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
    (transcript: string) => {
      if (!transcript) {
        return
      }

      setComposerDraft(draftFlashcardsPrompt(transcript))
      navigate(NEW_CHAT_ROUTE)
    },
    [navigate]
  )

  const saveTranscriptNote = useCallback(async (file: RecordingFile, transcript: string) => {
    if (!transcript) {
      return
    }

    const title = `Lecture ${file.name.replace(/\.(webm|m4a|wav|aiff?|mp3)$/i, '').replace(/^lecture-/, '')}`
    await saveNote(title, `# ${title}\n\n*Transcribed by Nemesis — review before relying on it.*\n\n${transcript}\n`)
    setSavedNote(current => ({ ...current, [file.path]: true }))
  }, [])

  if (recordings.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-5 py-7">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">Nothing captured</p>
        <p className="mt-1 text-xs text-muted-foreground">Recordings save to Documents / Nemesis Recordings as ordinary audio files.</p>
      </div>
    )
  }

  return (
    <div className="h-[28rem] rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
      <PanelBody>
        <PanelList>
          {recordings.map(file => (
            <PanelListRow
              active={selected?.path === file.path}
              icon="mic"
              key={file.path}
              meta={recordingTime(file.name)}
              onSelect={() => setSelectedPath(file.path)}
              rowKey={file.path}
              title={file.note?.title || recordingLabel(file.name)}
            />
          ))}
        </PanelList>

        {selected ? (
          <RecordingDetail
            corrections={corrections[selected.path] ?? 0}
            file={selected}
            key={selected.path}
            navigate={navigate}
            onDraftFlashcards={draftFlashcards}
            onSaveTranscriptNote={(file, transcript) => void saveTranscriptNote(file, transcript)}
            onTranscribe={() => void transcribe(selected)}
            savedNote={Boolean(savedNote[selected.path])}
            transcribingStatus={transcribingStatus[selected.path]}
            transcript={transcripts[selected.path] ?? ''}
          />
        ) : (
          <PanelEmpty description="Pick a recording on the left." icon="mic" title="No recording selected" />
        )}
      </PanelBody>
    </div>
  )
}

function RecordingDetail({
  corrections,
  file,
  navigate,
  onDraftFlashcards,
  onSaveTranscriptNote,
  onTranscribe,
  savedNote,
  transcribingStatus,
  transcript
}: {
  corrections: number
  file: RecordingFile
  navigate: NavigateFunction
  onDraftFlashcards: (transcript: string) => void
  onSaveTranscriptNote: (file: RecordingFile, transcript: string) => void
  onTranscribe: () => void
  savedNote: boolean
  transcribingStatus?: string
  transcript: string
}) {
  const [audioFailed, setAudioFailed] = useState(false)
  const sections = file.note ? parseLectureSections(file.note.content) : null
  const rawTranscript = sections?.transcript || transcript
  const hasNote = Boolean(file.note)

  return (
    <PanelDetail>
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate text-[0.95rem] font-semibold tracking-tight text-foreground">
            {file.note?.title || recordingLabel(file.name)}
          </h3>
          {!hasNote && <PanelPill>No linked note</PanelPill>}
        </div>
        <p className="text-xs text-muted-foreground">{recordingLabel(file.name)}</p>
      </header>

      <section className="space-y-1.5">
        <PanelSectionLabel>Audio</PanelSectionLabel>
        {audioFailed ? (
          <p className="rounded bg-destructive/10 p-2.5 text-xs text-destructive">
            Couldn&rsquo;t play this recording — the audio file may have been moved or deleted.
          </p>
        ) : (
          <audio
            className="w-full"
            controls
            onError={() => setAudioFailed(true)}
            preload="metadata"
            src={mediaStreamUrl(file.path)}
          />
        )}
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <PanelSectionLabel>AI notes</PanelSectionLabel>
          {hasNote && (
            <PanelAction icon="wand" onClick={() => enhanceLectureNote(file.note?.title ?? '', navigate)}>
              {sections?.aiNotes ? 'Re-enhance' : 'Enhance with Nemesis'}
            </PanelAction>
          )}
        </div>
        {sections?.aiNotes ? (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{sections.aiNotes}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {hasNote
              ? 'Not enhanced yet — click "Enhance with Nemesis" to turn your notes and transcript into structured AI notes.'
              : 'No notes linked to this recording — it predates note-linking, or its note was moved or deleted.'}
          </p>
        )}
      </section>

      {sections?.myNotes ? (
        <section className="space-y-1.5">
          <PanelSectionLabel>My notes</PanelSectionLabel>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{sections.myNotes}</p>
        </section>
      ) : null}

      <section className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <PanelSectionLabel>Transcript</PanelSectionLabel>
          {rawTranscript && !transcribingStatus && (
            <div className="flex items-center gap-0.5">
              <PanelAction icon="checklist" onClick={() => onDraftFlashcards(rawTranscript)}>
                Draft flashcards
              </PanelAction>
              {!hasNote && (
                <PanelAction disabled={savedNote} icon="save" onClick={() => onSaveTranscriptNote(file, rawTranscript)}>
                  {savedNote ? 'Saved' : 'Save as note'}
                </PanelAction>
              )}
            </div>
          )}
        </div>
        {transcribingStatus ? (
          <div className="flex items-center gap-1.5 text-xs font-medium text-(--theme-primary)">
            <span className="size-1.5 animate-pulse rounded-full bg-(--theme-primary)" />
            {transcribingStatus}
          </div>
        ) : rawTranscript ? (
          <>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{rawTranscript}</p>
            {corrections > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {corrections} pharm term{corrections === 1 ? '' : 's'} auto-corrected
              </p>
            )}
          </>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">No transcript yet.</p>
            <PanelAction icon="sparkle" onClick={onTranscribe}>
              Transcribe
            </PanelAction>
          </div>
        )}
      </section>
    </PanelDetail>
  )
}
