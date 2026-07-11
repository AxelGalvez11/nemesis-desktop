import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Recorder UI. The capture engine lives in service.ts so this view is only a binder:
// navigating away can unmount every element below without touching an active recording.
import { useStore } from '@nanostores/react';
import { IconCheck, IconLock, IconMicrophone, IconPlayerPause, IconPlayerPlay, IconSparkles } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { setComposerDraft } from '@/store/composer';
import { NoteEditor } from '../library/note-editor';
import { LIBRARY_ROUTE, NEW_CHAT_ROUTE } from '../routes';
import { enhanceLectureNote, RecordingArchive } from './archive';
import { $elapsedMs, $liveCaptionsEnabled, $liveInsights, $liveStatus, $liveTranscript, $notepadDraft, $paused, $recentLectureNote, $recording, $recordingError, $recordingsVersion, $recordingTitle, $starting, $systemAudioEnabled, formatElapsed, getRecordingAnalyser, LECTURE_FOLDER, setLiveCaptionsEnabled, setNotepadDraft, setRecordingPaused, setRecordingTitle, setSystemAudioEnabled, startRecording, stopRecording, toggleLiveInsight } from './service';
function useLiveWaveform(recording) {
    const canvasRef = useRef(null);
    useEffect(() => {
        if (!recording) {
            return;
        }
        const canvas = canvasRef.current;
        const analyser = getRecordingAnalyser();
        if (!canvas || !analyser) {
            return;
        }
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }
        const buffer = new Uint8Array(analyser.frequencyBinCount);
        let animationFrame = 0;
        const render = () => {
            animationFrame = requestAnimationFrame(render);
            const pixelRatio = window.devicePixelRatio || 1;
            const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
            const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
            analyser.getByteTimeDomainData(buffer);
            const rootStyle = getComputedStyle(document.documentElement);
            const accent = rootStyle.getPropertyValue('--theme-primary').trim() || rootStyle.getPropertyValue('--ui-text-primary').trim();
            context.clearRect(0, 0, width, height);
            context.lineWidth = Math.max(1.5, pixelRatio * 1.5);
            context.strokeStyle = accent;
            context.beginPath();
            const slice = width / Math.max(1, buffer.length - 1);
            for (let index = 0; index < buffer.length; index++) {
                const y = (buffer[index] / 255) * height;
                index === 0 ? context.moveTo(0, y) : context.lineTo(index * slice, y);
            }
            context.stroke();
        };
        render();
        return () => cancelAnimationFrame(animationFrame);
    }, [recording]);
    return canvasRef;
}
export function RecorderView() {
    const recording = useStore($recording);
    const starting = useStore($starting);
    const paused = useStore($paused);
    const elapsedMs = useStore($elapsedMs);
    const liveTranscript = useStore($liveTranscript);
    const liveInsights = useStore($liveInsights);
    const liveStatus = useStore($liveStatus);
    const title = useStore($recordingTitle);
    const notepadDraft = useStore($notepadDraft);
    const withSystemAudio = useStore($systemAudioEnabled);
    const liveCaptions = useStore($liveCaptionsEnabled);
    const lectureNote = useStore($recentLectureNote);
    const recordingsVersion = useStore($recordingsVersion);
    const error = useStore($recordingError);
    const navigate = useNavigate();
    const liveScrollRef = useRef(null);
    const canvasRef = useLiveWaveform(recording === 'recording');
    useEffect(() => {
        const host = liveScrollRef.current;
        if (host) {
            host.scrollTop = host.scrollHeight;
        }
    }, [liveTranscript]);
    const enhanceNote = () => {
        if (lectureNote) {
            enhanceLectureNote(lectureNote, navigate);
        }
    };
    const askQueued = () => {
        const queued = liveInsights.filter(insight => insight.queued).map(insight => insight.term);
        if (!queued.length) {
            return;
        }
        const context = liveTranscript.slice(-6).join(' ').slice(-1200);
        setComposerDraft(`These drugs came up in the lecture I just recorded: ${queued.join(', ')}. ` +
            'For each, give me the exam-relevant rundown: drug class, mechanism in one line, the classic adverse effect, ' +
            'and the single interaction I must know — cite PMIDs inline where it matters.' +
            (context ? `\n\nTranscript context:\n"${context}"` : ''));
        navigate(NEW_CHAT_ROUTE);
    };
    if (recording === 'recording') {
        return (_jsxs("main", { className: "flex h-full min-h-0 flex-col overflow-y-auto bg-(--ui-editor-surface-background) px-4 pb-5 pt-4 sm:px-5 xl:overflow-hidden", children: [_jsxs("header", { className: "mb-4 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-4 py-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: [_jsxs("span", { "aria-hidden": "true", className: "relative flex size-3 shrink-0", children: [!paused && (_jsx("span", { className: "absolute inline-flex size-full animate-ping rounded-full bg-(--theme-primary) opacity-45" })), _jsx("span", { className: "relative inline-flex size-3 rounded-full bg-(--theme-primary)" })] }), _jsx("span", { className: "shrink-0 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--theme-primary)", children: paused ? 'Paused' : 'On air' }), _jsx("input", { "aria-label": "Lecture title", className: "order-last min-w-0 basis-full border-none bg-transparent text-base font-semibold tracking-tight outline-none placeholder:text-muted-foreground/50 sm:order-none sm:min-w-44 sm:flex-1 sm:basis-auto sm:text-lg", onChange: event => setRecordingTitle(event.target.value), placeholder: "Lecture title", value: title }), _jsx("span", { className: "shrink-0 rounded-full bg-(--ui-bg-quaternary) px-3 py-1 text-base font-semibold tabular-nums tracking-tight text-foreground", children: formatElapsed(elapsedMs) }), _jsx(Button, { "aria-label": paused ? 'Resume recording' : 'Pause recording', onClick: () => void setRecordingPaused(!paused), size: "icon-sm", variant: "outline", children: paused ? _jsx(IconPlayerPlay, { size: 14 }) : _jsx(IconPlayerPause, { size: 14 }) }), _jsx(Button, { className: "active:scale-[0.98]", onClick: stopRecording, size: "sm", variant: "destructive", children: "Stop & save" })] }), _jsxs("div", { className: "grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(17rem,0.78fr)_minmax(22rem,1.22fr)]", children: [_jsxs("section", { "aria-label": "Live capture", className: "flex min-h-0 min-w-0 flex-col gap-3 xl:overflow-y-auto xl:pr-0.5", children: [_jsxs("div", { className: "shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: [_jsxs("div", { className: "mb-2 flex items-center justify-between gap-3", children: [_jsx("span", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: "Audio signal" }), _jsx("span", { className: "truncate text-[0.65rem] text-(--ui-text-quaternary)", children: paused ? 'Capture paused' : `Mic${withSystemAudio ? ' + system' : ''}` })] }), _jsx("canvas", { className: cn('h-16 w-full rounded-xl bg-(--ui-bg-quaternary)', paused && 'opacity-45'), ref: canvasRef })] }), liveCaptions ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex min-h-48 shrink-0 flex-col rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)] xl:min-h-56", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between gap-3", children: [_jsx("span", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: "Live transcript" }), _jsx("span", { className: "min-w-0 truncate text-[0.65rem] text-muted-foreground", children: liveStatus })] }), _jsx("div", { "aria-live": "polite", className: "max-h-80 space-y-3 overflow-y-auto pr-1 text-[0.8125rem] leading-6 text-foreground/90", ref: liveScrollRef, children: liveTranscript.length ? (liveTranscript.map((segment, index) => (_jsx("p", { className: "animate-in fade-in-0 border-l-2 border-(--theme-primary)/30 pl-3 duration-200", children: segment }, `${index}-${segment.slice(0, 18)}`)))) : (_jsxs("div", { className: "grid min-h-28 place-content-center text-center", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: paused ? 'Capture paused' : 'Listening' }), _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: paused
                                                                    ? 'Resume when the lecture continues.'
                                                                    : 'Speech will appear here as the lecture continues.' })] })) })] }), liveInsights.length > 0 && (_jsxs("div", { className: "shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: [_jsxs("div", { className: "mb-2.5 flex items-center justify-between gap-3", children: [_jsxs("span", { className: "inline-flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: [_jsx(IconSparkles, { size: 12 }), "Mentioned"] }), _jsx("span", { className: "text-[0.65rem] text-muted-foreground", children: "Select drugs to review after class" })] }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: liveInsights.map(insight => (_jsxs("button", { "aria-pressed": insight.queued, className: cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-[transform,color,border-color,background-color] active:scale-[0.98]', insight.queued
                                                            ? 'border-(--theme-primary)/45 bg-(--ui-bg-primary) text-foreground'
                                                            : 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) text-muted-foreground hover:border-(--theme-primary)/35 hover:text-foreground'), onClick: () => toggleLiveInsight(insight.term), type: "button", children: [insight.queued && _jsx(IconCheck, { size: 11 }), insight.term, _jsx("span", { className: "text-[9px] tabular-nums opacity-60", children: insight.at })] }, insight.term))) })] }))] })) : (_jsxs("div", { className: "rounded-2xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "Live transcript off" }), _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Audio is still recording and can be transcribed later." })] })), _jsxs("span", { className: "inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-3 py-1.5 text-[0.6875rem] text-muted-foreground", children: [_jsx(IconLock, { size: 12 }), "On this device only \u2014 nothing joins your call"] })] }), _jsxs("section", { className: "flex min-h-[24rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)] xl:min-h-0", children: [_jsxs("div", { className: "flex shrink-0 items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) px-5 py-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: "Lecture notepad" }), _jsx("p", { className: "mt-0.5 text-[0.6875rem] text-muted-foreground", children: "Write freely while Nemesis listens alongside you." })] }), _jsx("span", { className: "hidden rounded-full bg-(--ui-bg-quaternary) px-2.5 py-1 text-[0.625rem] text-muted-foreground sm:inline", children: "Auto-saved on stop" })] }), _jsx("div", { className: "min-h-0 flex-1 overflow-hidden px-5", children: _jsx(NoteEditor, { initialValue: notepadDraft, onChange: setNotepadDraft, onOpenWikilink: () => { } }) })] })] }), error && _jsx("p", { className: "pt-2 text-center text-xs text-destructive", children: error })] }));
    }
    const queuedCount = liveInsights.filter(insight => insight.queued).length;
    const stopping = recording === 'stopping';
    return (_jsxs("main", { className: "flex h-full min-h-0 flex-col overflow-y-auto bg-(--ui-editor-surface-background)", children: [_jsxs("header", { className: "sticky top-0 z-20 flex shrink-0 items-start gap-3 border-b border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background)/95 px-4 pb-2 pt-5 backdrop-blur-sm sm:px-6 sm:pt-6 [@media(max-height:720px)]:pb-2 [@media(max-height:720px)]:pt-3", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--theme-primary)", children: "Capture desk" }), _jsx("h1", { className: "mt-1 text-2xl font-semibold tracking-[-0.025em] [@media(max-height:720px)]:text-xl", children: "Recorder" }), _jsxs("p", { className: "mt-1 max-w-3xl text-xs leading-5 text-muted-foreground [@media(max-height:720px)]:hidden", children: ["Capture your microphone", withSystemAudio ? ' and this computer’s audio' : '', " locally. Keep a live notepad, review on-device transcription, and collect the pharmacology terms that matter."] })] }), _jsx(Button, { "aria-label": "Start recording", className: "mt-0.5 shrink-0 active:scale-[0.98]", disabled: stopping || starting, onClick: () => void startRecording(), size: "sm", children: "\u25CF Record" })] }), _jsxs("section", { className: "mx-4 mt-4 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)] sm:mx-6 [@media(max-height:720px)]:mt-2", children: [_jsxs("div", { className: "grid items-stretch lg:grid-cols-[minmax(0,0.9fr)_minmax(20rem,1.1fr)]", children: [_jsxs("div", { className: "flex min-w-0 flex-col items-start gap-5 border-b border-(--ui-stroke-tertiary) p-5 sm:flex-row sm:items-center sm:p-6 lg:border-b-0 lg:border-r [@media(max-height:720px)]:gap-3 [@media(max-height:720px)]:p-3", children: [_jsx("div", { className: "grid size-24 shrink-0 place-items-center rounded-full border border-(--theme-primary)/25 bg-(--ui-bg-primary) shadow-[inset_0_0_0_7px_var(--ui-bg-elevated)] [@media(max-height:720px)]:size-16 [@media(max-height:720px)]:shadow-[inset_0_0_0_4px_var(--ui-bg-elevated)]", children: _jsx(Button, { "aria-label": "Start recording", className: "size-20 rounded-full shadow-lg transition-[transform,opacity] active:scale-[0.96] [@media(max-height:720px)]:size-12", disabled: stopping || starting, onClick: () => void startRecording(), size: "icon-lg", children: _jsx(IconMicrophone, { className: "size-7 [@media(max-height:720px)]:size-5" }) }) }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: stopping ? 'Finishing capture' : starting ? 'Opening audio capture' : 'Ready to record' }), _jsx("h2", { className: "mt-1 text-lg font-semibold tracking-tight", children: stopping ? 'Saving your lecture' : 'Capture the lecture, keep the context' }), _jsx("p", { className: "mt-1 max-w-sm text-xs leading-5 text-muted-foreground", children: stopping
                                                    ? liveStatus || 'Writing audio and notes to disk…'
                                                    : 'One click opens the live notepad, audio signal, transcript, and pharmacology mentions.' })] })] }), _jsxs("div", { className: "flex min-w-0 flex-col justify-center gap-2 p-4", children: [_jsxs("label", { className: "group flex cursor-pointer items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-bg-quaternary)", children: [_jsx("input", { checked: withSystemAudio, className: "peer sr-only", disabled: starting || stopping, onChange: event => setSystemAudioEnabled(event.target.checked), type: "checkbox" }), _jsx("span", { className: "relative h-5 w-9 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-(--theme-primary)/35 peer-checked:bg-(--theme-primary) peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground peer-disabled:opacity-45" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block text-xs font-semibold", children: "Computer audio" }), _jsx("span", { className: "block text-[0.6875rem] leading-relaxed text-muted-foreground", children: "Capture lecture or meeting audio \u00B7 macOS asks once" })] })] }), _jsxs("label", { className: "group flex cursor-pointer items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-bg-quaternary)", children: [_jsx("input", { checked: liveCaptions, className: "peer sr-only", disabled: starting || stopping, onChange: event => setLiveCaptionsEnabled(event.target.checked), type: "checkbox" }), _jsx("span", { className: "relative h-5 w-9 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-(--theme-primary)/35 peer-checked:bg-(--theme-primary) peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground peer-disabled:opacity-45" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block text-xs font-semibold", children: "Live transcript" }), _jsx("span", { className: "block text-[0.6875rem] leading-relaxed text-muted-foreground", children: "Process speech on-device and save a linked lecture note" })] })] }), _jsxs("span", { className: "mx-3 mt-1 inline-flex items-center gap-1.5 self-start rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-3 py-1.5 text-[0.6875rem] text-muted-foreground", children: [_jsx(IconLock, { size: 12 }), "Nothing joins your call \u00B7 processed on this device"] })] })] }), lectureNote && (_jsxs("div", { className: "flex flex-wrap items-center gap-2 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-5 py-3 text-xs", children: [_jsxs("span", { className: "min-w-0 flex-1 basis-full items-center gap-1.5 font-medium sm:inline-flex sm:basis-auto", children: [_jsx(IconCheck, { className: "mr-1 inline text-(--theme-primary)", size: 13 }), "Saved to Library / ", LECTURE_FOLDER, " as ", lectureNote, ".md"] }), _jsx(Button, { onClick: () => navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(lectureNote)}`), size: "xs", variant: "outline", children: "Open note" }), _jsxs(Button, { onClick: enhanceNote, size: "xs", variant: "secondary", children: [_jsx(IconSparkles, { size: 12 }), "Enhance with Nemesis"] }), queuedCount > 0 && (_jsxs(Button, { onClick: askQueued, size: "xs", variant: "outline", children: ["Review ", queuedCount, " queued drug", queuedCount === 1 ? '' : 's'] }))] })), error && _jsx("p", { className: "border-t border-(--ui-stroke-tertiary) px-5 py-3 text-xs text-destructive", children: error })] }), _jsxs("section", { className: "px-4 pb-8 pt-7 sm:px-6", children: [_jsxs("div", { className: "mb-3", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--theme-primary)", children: "Archive" }), _jsx("h2", { className: "mt-1 text-lg font-semibold tracking-tight", children: "Saved recordings" }), _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Play back, transcribe, enhance, or clean up past captures." })] }), _jsx(RecordingArchive, { reloadToken: recordingsVersion }), _jsxs("div", { className: "flex flex-wrap items-center gap-1.5 pt-4 text-[0.6875rem] text-muted-foreground", children: [_jsx(IconLock, { size: 11 }), _jsx("span", { children: "Local by design \u00B7" }), _jsx(Tip, { className: "max-w-sm whitespace-normal text-left leading-relaxed", label: _jsx("span", { children: "Recording other people may require their consent where you live \u2014 check your school\u2019s policy. Nemesis never records on its own and never hides the indicator. Transcription runs on your device; review the draft before relying on it." }), side: "top", children: _jsx("button", { className: "underline decoration-current/30 underline-offset-2 hover:text-foreground", type: "button", children: "Consent & transcription details" }) })] })] })] }));
}
