import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mediaStreamUrl } from '@/lib/media';
import { setComposerDraft } from '@/store/composer';
import { useRefreshHotkey } from '../hooks/use-refresh-hotkey';
import { loadFolderNotes, saveNote } from '../library/vault';
import { PanelAction, PanelBody, PanelDetail, PanelEmpty, PanelList, PanelListRow, PanelPill, PanelSectionLabel } from '../overlays/panel';
import { NEW_CHAT_ROUTE } from '../routes';
import { correctPharmTerms } from './pharm-lexicon';
import { transcribeAudio } from './transcribe';
export const RECORDINGS_DIR = '~/Documents/Nemesis Recordings';
export const LECTURE_FOLDER = 'Lectures';
const AUDIO_FILE_RE = /\.(webm|m4a|wav)$/i;
function audioMarker(fileName) {
    return `Audio: ${fileName} (Nemesis Recordings)`;
}
/** "lecture-2026-07-09T20-28-01.webm" → "Jul 9, 2026 · 8:28 PM"; else the raw name. */
export function recordingLabel(name) {
    const match = name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (match) {
        const [, y, mo, d, h, mi] = match;
        const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
        if (!Number.isNaN(date.getTime())) {
            return date.toLocaleString(undefined, {
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                month: 'short',
                year: 'numeric'
            });
        }
    }
    return name;
}
/** Compact time-only form for the dense row list ("8:28 PM"). */
function recordingTime(name) {
    const match = name.match(/T(\d{2})-(\d{2})-(\d{2})/);
    if (!match) {
        return '';
    }
    const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
/** Load saved recordings and best-effort match each to its auto-saved Library note. */
export async function loadRecordingFiles() {
    const [dir, notes] = await Promise.all([
        window.hermesDesktop?.readDir?.(RECORDINGS_DIR),
        loadFolderNotes(LECTURE_FOLDER).catch(() => [])
    ]);
    return (dir?.entries ?? [])
        .filter(entry => !entry.isDirectory && AUDIO_FILE_RE.test(entry.name))
        .map(entry => ({
        name: entry.name,
        note: notes.find(note => note.content.includes(audioMarker(entry.name))) ?? null,
        path: entry.path
    }))
        .sort((a, b) => b.name.localeCompare(a.name));
}
const PLACEHOLDER_BODY_RE = /^_.*_$/;
/** Split the auto-saved lecture note into its "## " sections. Lenient about heading
 *  order and about "AI notes" possibly not existing yet — Nemesis only adds it once the
 *  user asks to enhance the note (see enhanceLectureNote below). Known placeholder bodies
 *  ("_none taken_", "_no speech captured_") count as empty. */
export function parseLectureSections(content) {
    const byHeading = new Map();
    for (const chunk of content.split(/^##[ \t]+/m).slice(1)) {
        const breakAt = chunk.search(/\r?\n/);
        const heading = (breakAt === -1 ? chunk : chunk.slice(0, breakAt)).trim().toLowerCase();
        const body = (breakAt === -1 ? '' : chunk.slice(breakAt + 1)).trim();
        if (!byHeading.has(heading)) {
            byHeading.set(heading, PLACEHOLDER_BODY_RE.test(body) ? '' : body);
        }
    }
    return {
        aiNotes: byHeading.get('ai notes') ?? '',
        myNotes: byHeading.get('my notes') ?? '',
        transcript: byHeading.get('transcript') ?? ''
    };
}
/** Ask Nemesis to fold rough notes + transcript into a structured "AI notes" section on
 *  the given lecture note. Shared by the post-recording banner (index.tsx, for the note
 *  just saved) and the archive detail view below (for any past recording). */
export function enhanceLectureNote(noteTitle, navigate) {
    setComposerDraft(`Open my lecture note "${noteTitle}.md" in ~/Documents/Nemesis Library/${LECTURE_FOLDER}/ and add a clean, structured "AI notes" section immediately above the existing "Transcript" section. ` +
        'Use both "My notes" and "Transcript" as source material: keep my wording where it is good, fix transcription garbles against pharmacology vocabulary, ' +
        'and organize the AI notes with useful headings and bullets. Preserve the original Transcript section, My notes section, and the header lines about the recording date and audio file. Update that same file with the result. ' +
        'At the end add a "Flashcard candidates" section with 5 exam-style Q&A pairs from this lecture. Tell me when the file is updated.');
    navigate(NEW_CHAT_ROUTE);
}
/** Read a saved recording's audio as bytes, streamed through the same uncapped protocol
 *  the player uses (fixes on-demand transcription throwing on lecture-length files that
 *  would blow past readFileDataUrl's 16MB cap). */
async function readAudioBuffer(file) {
    const response = await fetch(mediaStreamUrl(file.path));
    if (!response.ok) {
        throw new Error('Could not read the recording file.');
    }
    return response.arrayBuffer();
}
function draftFlashcardsPrompt(transcript) {
    return ('Turn this lecture transcript into 8-15 exam-quality flashcards for a pharmacy/health-sciences student. ' +
        'Application-level questions (mechanisms, adverse effects, interactions, monitoring), one concept per card, no "what is X" filler. ' +
        'Reply with ONLY tab-separated lines, one card per line: front<TAB>back. No headers, no numbering, no commentary — ' +
        "I'll paste your reply straight into Study → Import cards.\n\nTranscript:\n" +
        transcript);
}
export function RecordingArchive({ reloadToken }) {
    const navigate = useNavigate();
    const [recordings, setRecordings] = useState([]);
    const [selectedPath, setSelectedPath] = useState(null);
    const [transcripts, setTranscripts] = useState({});
    const [corrections, setCorrections] = useState({});
    const [transcribingStatus, setTranscribingStatus] = useState({});
    const [savedNote, setSavedNote] = useState({});
    const reload = useCallback(async () => {
        try {
            setRecordings(await loadRecordingFiles());
        }
        catch {
            // listing is best-effort; individual actions below report their own errors
        }
    }, []);
    useEffect(() => {
        void reload();
        // Re-run whenever the caller bumps reloadToken (a recording just finished saving).
    }, [reload, reloadToken]);
    // Press "r" to pick up a note that "Enhance with Nemesis" updated in a chat turn —
    // the selected recording's note snapshot otherwise stays as of the last load.
    useRefreshHotkey(reload);
    const selected = recordings.find(file => file.path === selectedPath) ?? recordings[0] ?? null;
    const transcribe = useCallback(async (file) => {
        setTranscribingStatus(status => ({ ...status, [file.path]: 'Loading model…' }));
        try {
            const buffer = await readAudioBuffer(file);
            const text = await transcribeAudio(buffer, update => setTranscribingStatus(status => ({
                ...status,
                [file.path]: update.stage === 'loading-model'
                    ? `Loading model… ${Math.round(update.progress ?? 0)}%`
                    : update.stage === 'decoding'
                        ? 'Decoding audio…'
                        : 'Transcribing…'
            })));
            const { changes, corrected } = correctPharmTerms(text || '');
            setTranscripts(current => ({ ...current, [file.path]: corrected || '(No speech detected.)' }));
            setCorrections(current => ({ ...current, [file.path]: changes.length }));
        }
        catch (err) {
            setTranscripts(current => ({
                ...current,
                [file.path]: `Transcription failed: ${err instanceof Error ? err.message : 'unknown error'}`
            }));
        }
        finally {
            setTranscribingStatus(status => {
                const next = { ...status };
                delete next[file.path];
                return next;
            });
        }
    }, []);
    const draftFlashcards = useCallback((transcript) => {
        if (!transcript) {
            return;
        }
        setComposerDraft(draftFlashcardsPrompt(transcript));
        navigate(NEW_CHAT_ROUTE);
    }, [navigate]);
    const saveTranscriptNote = useCallback(async (file, transcript) => {
        if (!transcript) {
            return;
        }
        const title = `Lecture ${file.name.replace(/\.(webm|m4a|wav|aiff?|mp3)$/i, '').replace(/^lecture-/, '')}`;
        await saveNote(title, `# ${title}\n\n*Transcribed by Nemesis — review before relying on it.*\n\n${transcript}\n`);
        setSavedNote(current => ({ ...current, [file.path]: true }));
    }, []);
    if (recordings.length === 0) {
        return (_jsxs("div", { className: "rounded-2xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-5 py-7", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "Nothing captured" }), _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Recordings save to Documents / Nemesis Recordings as ordinary audio files." })] }));
    }
    return (_jsx("div", { className: "h-[28rem] rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: _jsxs(PanelBody, { children: [_jsx(PanelList, { children: recordings.map(file => (_jsx(PanelListRow, { active: selected?.path === file.path, icon: "mic", meta: recordingTime(file.name), onSelect: () => setSelectedPath(file.path), rowKey: file.path, title: file.note?.title || recordingLabel(file.name) }, file.path))) }), selected ? (_jsx(RecordingDetail, { corrections: corrections[selected.path] ?? 0, file: selected, navigate: navigate, onDraftFlashcards: draftFlashcards, onSaveTranscriptNote: (file, transcript) => void saveTranscriptNote(file, transcript), onTranscribe: () => void transcribe(selected), savedNote: Boolean(savedNote[selected.path]), transcribingStatus: transcribingStatus[selected.path], transcript: transcripts[selected.path] ?? '' }, selected.path)) : (_jsx(PanelEmpty, { description: "Pick a recording on the left.", icon: "mic", title: "No recording selected" }))] }) }));
}
function RecordingDetail({ corrections, file, navigate, onDraftFlashcards, onSaveTranscriptNote, onTranscribe, savedNote, transcribingStatus, transcript }) {
    const [audioFailed, setAudioFailed] = useState(false);
    const sections = file.note ? parseLectureSections(file.note.content) : null;
    const rawTranscript = sections?.transcript || transcript;
    const hasNote = Boolean(file.note);
    return (_jsxs(PanelDetail, { children: [_jsxs("header", { className: "space-y-1", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("h3", { className: "min-w-0 truncate text-[0.95rem] font-semibold tracking-tight text-foreground", children: file.note?.title || recordingLabel(file.name) }), !hasNote && _jsx(PanelPill, { children: "No linked note" })] }), _jsx("p", { className: "text-xs text-muted-foreground", children: recordingLabel(file.name) })] }), _jsxs("section", { className: "space-y-1.5", children: [_jsx(PanelSectionLabel, { children: "Audio" }), audioFailed ? (_jsx("p", { className: "rounded bg-destructive/10 p-2.5 text-xs text-destructive", children: "Couldn\u2019t play this recording \u2014 the audio file may have been moved or deleted." })) : (_jsx("audio", { className: "w-full", controls: true, onError: () => setAudioFailed(true), preload: "metadata", src: mediaStreamUrl(file.path) }))] }), _jsxs("section", { className: "space-y-1.5", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx(PanelSectionLabel, { children: "AI notes" }), hasNote && (_jsx(PanelAction, { icon: "wand", onClick: () => enhanceLectureNote(file.note?.title ?? '', navigate), children: sections?.aiNotes ? 'Re-enhance' : 'Enhance with Nemesis' }))] }), sections?.aiNotes ? (_jsx("p", { className: "whitespace-pre-wrap text-xs leading-relaxed text-foreground", children: sections.aiNotes })) : (_jsx("p", { className: "text-xs text-muted-foreground", children: hasNote
                            ? 'Not enhanced yet — click "Enhance with Nemesis" to turn your notes and transcript into structured AI notes.'
                            : 'No notes linked to this recording — it predates note-linking, or its note was moved or deleted.' }))] }), sections?.myNotes ? (_jsxs("section", { className: "space-y-1.5", children: [_jsx(PanelSectionLabel, { children: "My notes" }), _jsx("p", { className: "whitespace-pre-wrap text-xs leading-relaxed text-foreground", children: sections.myNotes })] })) : null, _jsxs("section", { className: "space-y-1.5", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx(PanelSectionLabel, { children: "Transcript" }), rawTranscript && !transcribingStatus && (_jsxs("div", { className: "flex items-center gap-0.5", children: [_jsx(PanelAction, { icon: "checklist", onClick: () => onDraftFlashcards(rawTranscript), children: "Draft flashcards" }), !hasNote && (_jsx(PanelAction, { disabled: savedNote, icon: "save", onClick: () => onSaveTranscriptNote(file, rawTranscript), children: savedNote ? 'Saved' : 'Save as note' }))] }))] }), transcribingStatus ? (_jsxs("div", { className: "flex items-center gap-1.5 text-xs font-medium text-(--theme-primary)", children: [_jsx("span", { className: "size-1.5 animate-pulse rounded-full bg-(--theme-primary)" }), transcribingStatus] })) : rawTranscript ? (_jsxs(_Fragment, { children: [_jsx("p", { className: "whitespace-pre-wrap text-xs leading-relaxed text-foreground", children: rawTranscript }), corrections > 0 && (_jsxs("p", { className: "text-[10px] text-muted-foreground", children: [corrections, " pharm term", corrections === 1 ? '' : 's', " auto-corrected"] }))] })) : (_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx("p", { className: "text-xs text-muted-foreground", children: "No transcript yet." }), _jsx(PanelAction, { icon: "sparkle", onClick: onTranscribe, children: "Transcribe" })] }))] })] }));
}
