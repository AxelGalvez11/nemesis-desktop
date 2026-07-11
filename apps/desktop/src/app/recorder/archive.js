import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
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
import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { mediaStreamUrl } from '@/lib/media';
import { setComposerDraft } from '@/store/composer';
import { useRefreshHotkey } from '../hooks/use-refresh-hotkey';
import { loadFolderNotes, saveNote } from '../library/vault';
import { PanelAction, PanelBody, PanelDetail, PanelEmpty, PanelList, PanelListRow, PanelPill, PanelRowMenu, PanelSectionLabel } from '../overlays/panel';
import { NEW_CHAT_ROUTE } from '../routes';
import { correctPharmTerms } from './pharm-lexicon';
import { LECTURE_FOLDER, RECORDINGS_DIR } from './service';
import { transcribeAudio } from './transcribe';
export { LECTURE_FOLDER, RECORDINGS_DIR } from './service';
const AUDIO_FILE_RE = /\.(webm|m4a|wav)$/i;
const PLAYBACK_RATES = [1, 1.25, 1.5, 2];
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
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleteCompanionNote, setDeleteCompanionNote] = useState(false);
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
    const requestDelete = useCallback((file) => {
        setDeleteCompanionNote(false);
        setDeleteTarget(file);
    }, []);
    const deleteRecording = useCallback(async () => {
        if (!deleteTarget) {
            return;
        }
        const trash = window.hermesDesktop?.trashPath;
        if (!trash) {
            throw new Error('Moving files to Trash is unavailable in this build.');
        }
        const audioMoved = await trash(deleteTarget.path);
        if (!audioMoved) {
            throw new Error('The audio file could not be moved to Trash.');
        }
        if (deleteCompanionNote && deleteTarget.note) {
            const noteMoved = await trash(deleteTarget.note.path);
            if (!noteMoved) {
                await reload();
                throw new Error('The audio was moved to Trash, but its lecture note could not be moved.');
            }
        }
        setSelectedPath(current => (current === deleteTarget.path ? null : current));
        await reload();
    }, [deleteCompanionNote, deleteTarget, reload]);
    const deleteDialog = (_jsx(ConfirmDialog, { busyLabel: "Moving to Trash\u2026", confirmLabel: "Move to Trash", description: deleteTarget ? (_jsxs("span", { className: "block space-y-3", children: [_jsxs("span", { className: "block", children: ["The audio file \u201C", deleteTarget.name, "\u201D will move to the system Trash, where it can still be recovered."] }), deleteTarget.note ? (_jsxs("label", { className: "flex cursor-pointer items-start gap-2 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) p-3 text-left text-foreground", children: [_jsx(Checkbox, { checked: deleteCompanionNote, className: "mt-0.5", onCheckedChange: checked => setDeleteCompanionNote(checked === true) }), _jsxs("span", { children: [_jsx("span", { className: "block text-xs font-medium", children: "Also move its lecture note to Trash" }), _jsxs("span", { className: "mt-0.5 block text-[0.6875rem] text-muted-foreground", children: [deleteTarget.note.title, ".md in Library / ", LECTURE_FOLDER] })] })] })) : null] })) : null, destructive: true, doneLabel: "Moved to Trash", onClose: () => setDeleteTarget(null), onConfirm: deleteRecording, open: Boolean(deleteTarget), title: "Move recording to Trash?" }));
    if (recordings.length === 0) {
        return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid min-h-40 place-content-center rounded-2xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-5 py-8 text-center", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: "Archive ready" }), _jsx("p", { className: "mt-1 text-sm font-medium text-foreground", children: "Your first recording will appear here" }), _jsx("p", { className: "mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground", children: "Captures stay in Documents / Nemesis Recordings as ordinary audio files you control." })] }), deleteDialog] }));
    }
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "h-[min(34rem,68vh)] min-h-[28rem] min-w-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: _jsxs(PanelBody, { className: "!flex-col !gap-4 lg:!flex-row lg:!gap-5", children: [_jsx(PanelList, { className: "!w-full !max-h-40 lg:!max-h-none lg:!w-56", children: recordings.map(file => (_jsx(PanelListRow, { active: selected?.path === file.path, icon: "mic", menu: _jsx(PanelRowMenu, { items: [
                                        { icon: 'trash', label: 'Move to Trash', onSelect: () => requestDelete(file), tone: 'danger' }
                                    ], label: `Actions for ${file.note?.title || recordingLabel(file.name)}` }), meta: recordingTime(file.name), onSelect: () => setSelectedPath(file.path), rowKey: file.path, title: file.note?.title || recordingLabel(file.name) }, file.path))) }), selected ? (_jsx(RecordingDetail, { corrections: corrections[selected.path] ?? 0, file: selected, navigate: navigate, onDelete: () => requestDelete(selected), onDraftFlashcards: draftFlashcards, onSaveTranscriptNote: (file, transcript) => void saveTranscriptNote(file, transcript), onTranscribe: () => void transcribe(selected), savedNote: Boolean(savedNote[selected.path]), transcribingStatus: transcribingStatus[selected.path], transcript: transcripts[selected.path] ?? '' }, selected.path)) : (_jsx(PanelEmpty, { description: "Pick a recording on the left.", icon: "mic", title: "No recording selected" }))] }) }), deleteDialog] }));
}
function audioTimestamp(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '0:00';
    }
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
/** Compact app-styled playback controls for a streamed recording. */
function RecordingAudioPlayer({ onError, src }) {
    const audioRef = useRef(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [rateIndex, setRateIndex] = useState(0);
    useEffect(() => {
        setCurrentTime(0);
        setDuration(0);
        setPlaying(false);
        setRateIndex(0);
    }, [src]);
    const togglePlayback = () => {
        const audio = audioRef.current;
        if (!audio) {
            return;
        }
        if (audio.paused) {
            void audio.play().catch(() => setPlaying(false));
        }
        else {
            audio.pause();
        }
    };
    const cycleRate = () => {
        const nextIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
        const nextRate = PLAYBACK_RATES[nextIndex];
        setRateIndex(nextIndex);
        if (audioRef.current) {
            audioRef.current.playbackRate = nextRate;
        }
    };
    return (_jsxs("div", { className: "flex items-center gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-2.5 py-2", children: [_jsx("audio", { onDurationChange: event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0), onEnded: () => setPlaying(false), onError: onError, onLoadedMetadata: event => {
                    setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
                    event.currentTarget.playbackRate = PLAYBACK_RATES[rateIndex];
                }, onPause: () => setPlaying(false), onPlay: () => setPlaying(true), onTimeUpdate: event => setCurrentTime(event.currentTarget.currentTime), preload: "metadata", ref: audioRef, src: src }), _jsx("button", { "aria-label": playing ? 'Pause recording' : 'Play recording', className: "grid size-7 shrink-0 place-items-center rounded-full bg-(--theme-primary) text-primary-foreground transition-transform active:scale-[0.96]", onClick: togglePlayback, type: "button", children: playing ? _jsx(IconPlayerPause, { size: 13 }) : _jsx(IconPlayerPlay, { className: "ml-px", size: 13 }) }), _jsx("span", { className: "w-9 shrink-0 text-right font-mono text-[0.65rem] tabular-nums text-muted-foreground", children: audioTimestamp(currentTime) }), _jsx("input", { "aria-label": "Recording position", className: "h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-primary) accent-(--theme-primary) disabled:cursor-default disabled:opacity-50", disabled: duration <= 0, max: duration || 0, min: 0, onChange: event => {
                    const nextTime = Number(event.target.value);
                    setCurrentTime(nextTime);
                    if (audioRef.current) {
                        audioRef.current.currentTime = nextTime;
                    }
                }, step: 0.1, type: "range", value: Math.min(currentTime, duration || 0) }), _jsx("span", { className: "w-9 shrink-0 font-mono text-[0.65rem] tabular-nums text-muted-foreground", children: audioTimestamp(duration) }), _jsxs("button", { "aria-label": `Playback speed ${PLAYBACK_RATES[rateIndex]}x`, className: "min-w-10 shrink-0 rounded-md px-1.5 py-1 font-mono text-[0.65rem] font-semibold text-muted-foreground hover:bg-(--ui-control-hover-background) hover:text-foreground", onClick: cycleRate, type: "button", children: [PLAYBACK_RATES[rateIndex], "x"] })] }));
}
function RecordingDetail({ corrections, file, navigate, onDelete, onDraftFlashcards, onSaveTranscriptNote, onTranscribe, savedNote, transcribingStatus, transcript }) {
    const [audioFailed, setAudioFailed] = useState(false);
    const sections = file.note ? parseLectureSections(file.note.content) : null;
    const rawTranscript = sections?.transcript || transcript;
    const hasNote = Boolean(file.note);
    useEffect(() => setAudioFailed(false), [file.path]);
    return (_jsxs(PanelDetail, { children: [_jsxs("header", { className: "flex min-w-0 items-start justify-between gap-3", children: [_jsxs("div", { className: "min-w-0 space-y-1", children: [_jsxs("div", { className: "flex min-w-0 flex-wrap items-center gap-2", children: [_jsx("h3", { className: "min-w-0 truncate text-[0.95rem] font-semibold tracking-tight text-foreground", children: file.note?.title || recordingLabel(file.name) }), !hasNote && _jsx(PanelPill, { children: "No linked note" })] }), _jsx("p", { className: "truncate text-xs text-muted-foreground", children: recordingLabel(file.name) })] }), _jsx(PanelAction, { icon: "trash", onClick: onDelete, children: "Delete" })] }), _jsxs("section", { className: "space-y-1.5", children: [_jsx(PanelSectionLabel, { children: "Audio" }), audioFailed ? (_jsx("p", { className: "rounded bg-destructive/10 p-2.5 text-xs text-destructive", children: "Couldn\u2019t play this recording \u2014 the audio file may have been moved or deleted." })) : (_jsx(RecordingAudioPlayer, { onError: () => setAudioFailed(true), src: mediaStreamUrl(file.path) }))] }), _jsxs("section", { className: "space-y-1.5", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx(PanelSectionLabel, { children: "AI notes" }), hasNote && (_jsx(PanelAction, { icon: "wand", onClick: () => enhanceLectureNote(file.note?.title ?? '', navigate), children: sections?.aiNotes ? 'Re-enhance' : 'Enhance with Nemesis' }))] }), sections?.aiNotes ? (_jsx("p", { className: "whitespace-pre-wrap text-[0.8125rem] leading-6 text-foreground/90", children: sections.aiNotes })) : (_jsx("p", { className: "text-xs text-muted-foreground", children: hasNote
                            ? 'Not enhanced yet — click "Enhance with Nemesis" to turn your notes and transcript into structured AI notes.'
                            : 'No notes linked to this recording — it predates note-linking, or its note was moved or deleted.' }))] }), sections?.myNotes ? (_jsxs("section", { className: "space-y-1.5", children: [_jsx(PanelSectionLabel, { children: "My notes" }), _jsx("p", { className: "whitespace-pre-wrap text-[0.8125rem] leading-6 text-foreground/90", children: sections.myNotes })] })) : null, _jsxs("section", { className: "space-y-1.5", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx(PanelSectionLabel, { children: "Transcript" }), rawTranscript && !transcribingStatus && (_jsxs("div", { className: "flex flex-wrap items-center justify-end gap-0.5", children: [_jsx(PanelAction, { icon: "checklist", onClick: () => onDraftFlashcards(rawTranscript), children: "Draft flashcards" }), !hasNote && (_jsx(PanelAction, { disabled: savedNote, icon: "save", onClick: () => onSaveTranscriptNote(file, rawTranscript), children: savedNote ? 'Saved' : 'Save as note' }))] }))] }), transcribingStatus ? (_jsxs("div", { className: "flex items-center gap-1.5 text-xs font-medium text-(--theme-primary)", children: [_jsx("span", { className: "size-1.5 animate-pulse rounded-full bg-(--theme-primary)" }), transcribingStatus] })) : rawTranscript ? (_jsxs(_Fragment, { children: [_jsx("p", { className: "whitespace-pre-wrap border-l-2 border-(--theme-primary)/25 pl-3 text-[0.8125rem] leading-6 text-foreground/90", children: rawTranscript }), corrections > 0 && (_jsxs("p", { className: "text-[10px] text-muted-foreground", children: [corrections, " pharm term", corrections === 1 ? '' : 's', " auto-corrected"] }))] })) : (_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx("p", { className: "text-xs text-muted-foreground", children: "No transcript yet." }), _jsx(PanelAction, { icon: "sparkle", onClick: onTranscribe, children: "Transcribe" })] }))] })] }));
}
