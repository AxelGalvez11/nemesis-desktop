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
import { $account } from '@/nemesis-account';
import { enhanceLectureNote, RecordingArchive } from './archive';
import { $copilotAsk, $copilotEnabled, $copilotError, $copilotNotes, $copilotState, copilotAccess, forceCopilotRefresh, setCopilotEnabled, initCopilotWiring } from './live-copilot';
import { $elapsedMs, $liveCaptionsEnabled, $liveInsights, $liveStatus, $liveTranscript, $notepadDraft, $paused, $recentLectureNote, $recording, $recordingError, $recordingsVersion, $recordingTitle, $starting, $systemAudioEnabled, formatElapsed, getRecordingAnalyser, LECTURE_FOLDER, setLiveCaptionsEnabled, setNotepadDraft, setRecordingPaused, setRecordingTitle, setSystemAudioEnabled, startRecording, stopRecording, toggleLiveInsight } from './service';
function useLiveWaveform(recording) {
    const canvasRef = useRef(null);
    useEffect(() => {
        initCopilotWiring();
    }, []);
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
    const copilotEnabled = useStore($copilotEnabled);
    const copilotNotes = useStore($copilotNotes);
    const copilotAsk = useStore($copilotAsk);
    const copilotState = useStore($copilotState);
    const copilotError = useStore($copilotError);
    const account = useStore($account);
    const copilotCadence = copilotAccess(account);
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
                                                                    : 'Speech will appear here as the lecture continues.' })] })) })] }), _jsxs("div", { className: "shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: [_jsxs("div", { className: "mb-2.5 flex items-center justify-between gap-3", children: [_jsxs("span", { className: "inline-flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: [_jsx(IconSparkles, { size: 12 }), "Live copilot"] }), copilotCadence && (_jsx("button", { className: "text-[0.65rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline", onClick: () => setCopilotEnabled(!copilotEnabled), type: "button", children: copilotEnabled ? 'Turn off' : 'Turn on' }))] }), !copilotCadence ? (_jsx("p", { className: "text-xs text-muted-foreground", children: "Live AI notes and question suggestions are part of the Agent Pro and Max plans." })) : !copilotEnabled ? (_jsx("p", { className: "text-xs text-muted-foreground", children: "Off. When on, Nemesis writes running notes from the lecture (fixing mis-heard words from context) and suggests what to ask next. Uses your plan's daily AI budget." })) : (_jsxs(_Fragment, { children: [copilotNotes.length ? (_jsx("ul", { className: "max-h-44 space-y-1.5 overflow-y-auto pr-1 text-[0.8125rem] leading-5 text-foreground/90", children: copilotNotes.slice(-8).map((note, index) => (_jsxs("li", { className: "animate-in fade-in-0 flex gap-2 duration-200", children: [_jsx("span", { className: "text-(--theme-primary)", children: "\u2022" }), _jsx("span", { children: note })] }, `${index}-${note.slice(0, 16)}`))) })) : (_jsx("p", { className: "text-xs text-muted-foreground", children: "Notes appear here as the lecture develops." })), copilotAsk.length > 0 && (_jsxs("div", { className: "mt-2.5 border-t border-(--ui-stroke-tertiary) pt-2.5", children: [_jsx("span", { className: "text-[0.6rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: "Ask next" }), _jsx("ul", { className: "mt-1 space-y-1 text-[0.8125rem] leading-5 text-foreground/85", children: copilotAsk.map(question => (_jsxs("li", { children: ["\u201C", question, "\u201D"] }, question.slice(0, 24)))) })] })), _jsxs("div", { className: "mt-2.5 flex items-center justify-between gap-3", children: [_jsx("span", { className: cn('min-w-0 truncate text-[0.65rem]', copilotState === 'error' ? 'text-destructive' : 'text-muted-foreground'), children: copilotState === 'thinking' ? 'Thinking…' : copilotState === 'error' ? (copilotError ?? 'Copilot error') : '' }), _jsx(Button, { disabled: copilotState === 'thinking', onClick: forceCopilotRefresh, size: "sm", variant: "outline", children: "Suggest now" })] })] }))] }), liveInsights.length > 0 && (_jsxs("div", { className: "shrink-0 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: [_jsxs("div", { className: "mb-2.5 flex items-center justify-between gap-3", children: [_jsxs("span", { className: "inline-flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: [_jsx(IconSparkles, { size: 12 }), "Mentioned"] }), _jsx("span", { className: "text-[0.65rem] text-muted-foreground", children: "Select drugs to review after class" })] }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: liveInsights.map(insight => (_jsxs("button", { "aria-pressed": insight.queued, className: cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-[transform,color,border-color,background-color] active:scale-[0.98]', insight.queued
                                                            ? 'border-(--theme-primary)/45 bg-(--ui-bg-primary) text-foreground'
                                                            : 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) text-muted-foreground hover:border-(--theme-primary)/35 hover:text-foreground'), onClick: () => toggleLiveInsight(insight.term), type: "button", children: [insight.queued && _jsx(IconCheck, { size: 11 }), insight.term, _jsx("span", { className: "text-[9px] tabular-nums opacity-60", children: insight.at })] }, insight.term))) })] }))] })) : (_jsxs("div", { className: "rounded-2xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "Live transcript off" }), _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Audio is still recording and can be transcribed later." })] })), _jsxs("span", { className: "inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-3 py-1.5 text-[0.6875rem] text-muted-foreground", children: [_jsx(IconLock, { size: 12 }), "On this device only \u2014 nothing joins your call"] })] }), _jsxs("section", { className: "flex min-h-[24rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)] xl:min-h-0", children: [_jsxs("div", { className: "flex shrink-0 items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) px-5 py-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: "Lecture notepad" }), _jsx("p", { className: "mt-0.5 text-[0.6875rem] text-muted-foreground", children: "Write freely while Nemesis listens alongside you." })] }), _jsx("span", { className: "hidden rounded-full bg-(--ui-bg-quaternary) px-2.5 py-1 text-[0.625rem] text-muted-foreground sm:inline", children: "Auto-saved on stop" })] }), _jsx("div", { className: "min-h-0 flex-1 overflow-hidden px-5", children: _jsx(NoteEditor, { initialValue: notepadDraft, onChange: setNotepadDraft, onOpenWikilink: () => { } }) })] })] }), error && _jsx("p", { className: "pt-2 text-center text-xs text-destructive", children: error })] }));
    }
    const queuedCount = liveInsights.filter(insight => insight.queued).length;
    const stopping = recording === 'stopping';
    return (_jsxs("main", { className: "flex h-full min-h-0 flex-col overflow-y-auto bg-(--ui-editor-surface-background)", children: [_jsx("header", { className: "sticky top-0 z-20 shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background)/95 backdrop-blur-sm", children: _jsxs("div", { className: "mx-auto flex w-full max-w-[960px] items-start gap-4 px-5 pb-4 pt-6 sm:px-7 [@media(max-height:720px)]:pb-3 [@media(max-height:720px)]:pt-3", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--ui-text-tertiary)", children: "Capture desk" }), _jsx("h1", { className: "mt-1 text-2xl font-semibold tracking-[-0.025em] [@media(max-height:720px)]:text-xl", children: "Recorder" })] }), _jsx(Button, { "aria-label": "Start recording", className: "mt-0.5 bg-(--ui-red) text-white hover:bg-(--ui-red)/90 active:scale-[0.98]", disabled: stopping || starting, onClick: () => void startRecording(), size: "sm", children: "\u25CF Record" })] }) }), _jsxs("section", { className: "mx-auto flex w-full max-w-[960px] shrink-0 flex-col items-center gap-5 px-5 pb-9 pt-10 text-center sm:px-7 [@media(max-height:720px)]:gap-3 [@media(max-height:720px)]:py-3 [@media(max-height:720px)_and_(min-width:640px)]:flex-row [@media(max-height:720px)_and_(min-width:640px)]:text-left", children: [_jsxs(Button, { "aria-label": "Start recording", className: "group relative size-28 rounded-full bg-(--ui-red) text-white shadow-[0_12px_32px_color-mix(in_srgb,var(--ui-red)_22%,transparent)] transition-[transform,box-shadow,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-full before:ring-1 before:ring-white/25 hover:scale-[1.025] hover:bg-(--ui-red)/95 hover:shadow-[0_14px_38px_color-mix(in_srgb,var(--ui-red)_28%,transparent)] active:scale-[0.97] [@media(max-height:720px)]:size-14 [@media(max-height:720px)]:shadow-[0_7px_18px_color-mix(in_srgb,var(--ui-red)_18%,transparent)]", disabled: stopping || starting, onClick: () => void startRecording(), size: "icon-lg", children: [_jsx("span", { className: "pointer-events-none absolute inset-1 rounded-full bg-(--ui-red)/20 opacity-0 group-hover:animate-ping group-hover:opacity-100" }), _jsxs("span", { className: "relative flex flex-col items-center gap-1 [@media(max-height:720px)]:gap-0", children: [_jsx(IconMicrophone, { className: "size-8 [@media(max-height:720px)]:size-5" }), _jsx("span", { className: "text-[0.6875rem] font-semibold tracking-wide [@media(max-height:720px)]:text-[0.55rem]", children: "Record" })] })] }), _jsxs("div", { className: "flex min-w-0 flex-col items-center [@media(max-height:720px)_and_(min-width:640px)]:grid [@media(max-height:720px)_and_(min-width:640px)]:flex-1 [@media(max-height:720px)_and_(min-width:640px)]:grid-cols-[minmax(0,1fr)_auto] [@media(max-height:720px)_and_(min-width:640px)]:items-center [@media(max-height:720px)_and_(min-width:640px)]:gap-x-5", children: [_jsx("p", { className: "max-w-2xl text-sm leading-6 text-(--ui-text-secondary) [@media(max-height:720px)_and_(min-width:640px)]:row-span-2", children: stopping
                                    ? liveStatus || 'Finishing your capture and saving it on this Mac.'
                                    : starting
                                        ? 'Opening audio capture on this Mac.'
                                        : 'Capture the lecture. Notes, transcript, and terms — all on this Mac.' }), _jsxs("div", { className: "mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 [@media(max-height:720px)]:mt-2 [@media(max-height:720px)_and_(min-width:640px)]:mt-0 [@media(max-height:720px)_and_(min-width:640px)]:justify-end", children: [_jsxs("label", { className: "flex cursor-pointer items-center gap-2 text-xs font-medium text-(--ui-text-secondary)", children: [_jsx("span", { children: "Computer audio" }), _jsx("input", { checked: withSystemAudio, className: "peer sr-only", disabled: starting || stopping, onChange: event => setSystemAudioEnabled(event.target.checked), type: "checkbox" }), _jsx("span", { className: "relative h-4 w-7 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-3 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-foreground/20 peer-checked:bg-foreground peer-checked:after:translate-x-3 peer-checked:after:bg-background peer-disabled:opacity-45" })] }), _jsxs("label", { className: "flex cursor-pointer items-center gap-2 text-xs font-medium text-(--ui-text-secondary)", children: [_jsx("span", { children: "Live transcript" }), _jsx("input", { checked: liveCaptions, className: "peer sr-only", disabled: starting || stopping, onChange: event => setLiveCaptionsEnabled(event.target.checked), type: "checkbox" }), _jsx("span", { className: "relative h-4 w-7 shrink-0 rounded-full bg-(--ui-bg-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-3 after:rounded-full after:bg-(--ui-text-quaternary) after:transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-foreground/20 peer-checked:bg-foreground peer-checked:after:translate-x-3 peer-checked:after:bg-background peer-disabled:opacity-45" })] })] }), _jsxs("span", { className: "mt-3 inline-flex items-center gap-1.5 rounded-full border border-(--ui-stroke-tertiary) px-2.5 py-1 text-[0.65rem] text-(--ui-text-tertiary) [@media(max-height:720px)]:mt-1 [@media(max-height:720px)_and_(min-width:640px)]:justify-self-end", children: [_jsx(IconLock, { size: 11 }), "Nothing joins your call \u00B7 processed on this device"] })] })] }), (lectureNote || error) && (_jsxs("div", { className: "mx-auto w-full max-w-[960px] px-5 sm:px-7", children: [lectureNote && (_jsxs("div", { className: "flex flex-wrap items-center gap-2 border-y border-(--ui-stroke-tertiary) py-3 text-xs", children: [_jsxs("span", { className: "min-w-0 flex-1 basis-full items-center gap-1.5 font-medium sm:inline-flex sm:basis-auto", children: [_jsx(IconCheck, { className: "mr-1 inline", size: 13 }), "Saved to Library / ", LECTURE_FOLDER, " as ", lectureNote, ".md"] }), _jsx(Button, { onClick: () => navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(lectureNote)}`), size: "xs", variant: "outline", children: "Open note" }), _jsxs(Button, { onClick: enhanceNote, size: "xs", variant: "secondary", children: [_jsx(IconSparkles, { size: 12 }), "Enhance with Nemesis"] }), queuedCount > 0 && (_jsxs(Button, { onClick: askQueued, size: "xs", variant: "outline", children: ["Review ", queuedCount, " queued drug", queuedCount === 1 ? '' : 's'] }))] })), error && _jsx("p", { className: "border-b border-(--ui-stroke-tertiary) py-3 text-xs text-destructive", children: error })] })), _jsxs("section", { className: "mx-auto w-full max-w-[960px] px-5 pb-10 pt-7 sm:px-7", children: [_jsx(RecordingArchive, { reloadToken: recordingsVersion }), _jsxs("div", { className: "flex flex-wrap items-center gap-1.5 pt-4 text-[0.6875rem] text-muted-foreground", children: [_jsx(IconLock, { size: 11 }), _jsx("span", { children: "Local by design \u00B7" }), _jsx(Tip, { className: "max-w-sm whitespace-normal text-left leading-relaxed", label: _jsx("span", { children: "Recording other people may require their consent where you live \u2014 check your school\u2019s policy. Nemesis never records on its own and never hides the indicator. Transcription runs on your device; review the draft before relying on it." }), side: "top", children: _jsx("button", { className: "underline decoration-current/30 underline-offset-2 hover:text-foreground", type: "button", children: "Consent & transcription details" }) })] })] })] }));
}
