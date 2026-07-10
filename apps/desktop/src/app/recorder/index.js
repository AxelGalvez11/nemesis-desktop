import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Recorder — consent-first lecture capture. The deliberate ANTI-Cluely: user-initiated
// only, a large persistent ON-AIR indicator while recording, nothing hidden from screen
// shares. Captures the microphone plus system audio (Electron 39+ loopback via the
// macOS CoreAudio tap — the main process answers getDisplayMedia with `audio:'loopback'`),
// mixes both into one Opus/WebM file under ~/Documents/Nemesis Recordings.
// v1 scope: record + save + play back. On-device transcription (whisper) is the
// documented next step — see docs/research/nemesis-study-pages-oss-2026-07.md §4.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { saveNote } from '../library/vault';
import { transcribeAudio } from './transcribe';
const RECORDINGS_DIR = '~/Documents/Nemesis Recordings';
export function RecorderView() {
    const [state, setState] = useState('idle');
    const [error, setError] = useState(null);
    const [elapsed, setElapsed] = useState(0);
    const [withSystemAudio, setWithSystemAudio] = useState(true);
    const [recordings, setRecordings] = useState([]);
    const [playing, setPlaying] = useState(null);
    const [transcripts, setTranscripts] = useState({});
    const [transcribingStatus, setTranscribingStatus] = useState({});
    const [savedNote, setSavedNote] = useState({});
    const recorderRef = useRef(null);
    const streamsRef = useRef([]);
    const chunksRef = useRef([]);
    const tickRef = useRef(null);
    const refreshList = useCallback(async () => {
        try {
            const dir = await window.hermesDesktop?.readDir?.(RECORDINGS_DIR);
            const files = (dir?.entries ?? [])
                .filter(entry => !entry.isDirectory && /\.(webm|m4a|wav)$/i.test(entry.name))
                .map(entry => ({ name: entry.name, path: entry.path }))
                .sort((a, b) => b.name.localeCompare(a.name));
            setRecordings(files);
        }
        catch {
            // listing is best-effort; recording itself reports its own errors
        }
    }, []);
    useEffect(() => {
        void refreshList();
        return () => stopEverything();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const stopEverything = () => {
        if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
        }
        for (const stream of streamsRef.current) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }
        streamsRef.current = [];
    };
    const start = useCallback(async () => {
        setError(null);
        chunksRef.current = [];
        try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamsRef.current.push(mic);
            const context = new AudioContext();
            const destination = context.createMediaStreamDestination();
            context.createMediaStreamSource(mic).connect(destination);
            if (withSystemAudio) {
                // The main process answers this with the primary screen + loopback audio.
                // macOS shows its own Screen & System Audio Recording prompt on first use —
                // that OS-level consent gate is a feature, not a bug.
                const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
                streamsRef.current.push(display);
                // Audio-only capture: the mandatory video track is dropped immediately.
                for (const track of display.getVideoTracks()) {
                    track.stop();
                    display.removeTrack(track);
                }
                if (display.getAudioTracks().length) {
                    context.createMediaStreamSource(display).connect(destination);
                }
            }
            const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
            recorder.ondataavailable = event => {
                if (event.data.size) {
                    chunksRef.current.push(event.data);
                }
            };
            recorder.onstop = () => void persist();
            recorder.start(1000);
            recorderRef.current = recorder;
            setElapsed(0);
            tickRef.current = setInterval(() => setElapsed(count => count + 1), 1000);
            setState('recording');
        }
        catch (err) {
            stopEverything();
            setState('idle');
            setError(err instanceof Error && err.name === 'NotAllowedError'
                ? 'Permission was declined. macOS Settings → Privacy & Security → Screen & System Audio Recording → allow Nemesis, then try again.'
                : err instanceof Error
                    ? err.message
                    : 'Could not start recording.');
        }
    }, [withSystemAudio]);
    const stop = useCallback(() => {
        setState('saving');
        recorderRef.current?.stop();
        if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
        }
    }, []);
    const persist = async () => {
        try {
            const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
            const buffer = new Uint8Array(await blob.arrayBuffer());
            let base64 = '';
            for (let i = 0; i < buffer.length; i += 0x8000) {
                base64 += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
            }
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const write = window.hermesDesktop?.writeBinaryFile;
            if (!write) {
                throw new Error('Saving is unavailable in this build.');
            }
            await write(`${RECORDINGS_DIR}/lecture-${stamp}.webm`, btoa(base64));
            await refreshList();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save the recording.');
        }
        finally {
            stopEverything();
            setState('idle');
        }
    };
    const play = useCallback(async (file) => {
        if (playing?.path === file.path) {
            setPlaying(null);
            return;
        }
        const read = await window.hermesDesktop?.readFileDataUrl?.(file.path);
        const src = typeof read === 'string' ? read : read?.dataUrl;
        if (src) {
            setPlaying({ path: file.path, src });
        }
    }, [playing]);
    const readAudioBuffer = async (file) => {
        const read = await window.hermesDesktop?.readFileDataUrl?.(file.path);
        const src = typeof read === 'string' ? read : read?.dataUrl;
        if (!src) {
            throw new Error('Could not read the recording file.');
        }
        return (await fetch(src)).arrayBuffer();
    };
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
            setTranscripts(current => ({ ...current, [file.path]: text || '(No speech detected.)' }));
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
    const saveTranscriptNote = useCallback(async (file) => {
        const text = transcripts[file.path];
        if (!text) {
            return;
        }
        const title = `Lecture ${file.name.replace(/\.webm$/i, '').replace(/^lecture-/, '')}`;
        await saveNote(title, `# ${title}\n\n*Transcribed by Nemesis — review before relying on it.*\n\n${text}\n`);
        setSavedNote(current => ({ ...current, [file.path]: true }));
    }, [transcripts]);
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsxs("header", { className: "px-6 pb-2 pt-5", children: [_jsx("h1", { className: "text-lg font-semibold", children: "Recorder" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Records your mic", withSystemAudio ? ' + this computer’s audio (the lecture/Zoom)' : ' only', " \u2014 locally, to your own files. You start it, you see it, you keep it."] })] }), _jsxs("section", { className: "mx-6 mt-3 flex flex-col items-center gap-4 rounded-lg border border-border bg-card px-6 py-8", children: [state === 'recording' ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("span", { className: "relative flex size-4", children: [_jsx("span", { className: "absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" }), _jsx("span", { className: "relative inline-flex size-4 rounded-full bg-primary" })] }), _jsxs("span", { className: "text-2xl font-semibold tabular-nums", children: [minutes, ":", seconds] })] }), _jsx("p", { className: "text-xs font-medium uppercase tracking-widest text-primary", children: "Recording \u2014 visible, on purpose" }), _jsx(Button, { onClick: stop, size: "lg", variant: "secondary", children: "Stop & save" })] })) : (_jsxs(_Fragment, { children: [_jsx(Button, { disabled: state === 'saving', onClick: () => void start(), size: "lg", children: state === 'saving' ? 'Saving…' : 'Start recording' }), _jsxs("label", { className: "flex cursor-pointer items-center gap-2 text-xs text-muted-foreground", children: [_jsx("input", { checked: withSystemAudio, className: "accent-(--theme-primary)", onChange: event => setWithSystemAudio(event.target.checked), type: "checkbox" }), "Also capture this computer\u2019s audio (lecture, Zoom) \u2014 macOS will ask once"] })] })), error && _jsx("p", { className: "max-w-md text-center text-xs text-destructive", children: error })] }), _jsxs("section", { className: "px-6 pb-8 pt-5", children: [_jsx("h2", { className: "pb-2 text-sm font-medium", children: "Saved recordings" }), recordings.length ? (_jsx("ul", { className: "flex flex-col gap-1.5", children: recordings.map(file => {
                            const status = transcribingStatus[file.path];
                            const transcript = transcripts[file.path];
                            return (_jsxs("li", { className: "flex flex-col gap-2 rounded-md border border-border px-3 py-2", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx("span", { className: "truncate text-sm", children: file.name }), _jsxs("div", { className: "flex shrink-0 items-center gap-2", children: [_jsx(Button, { disabled: Boolean(status), onClick: () => void transcribe(file), size: "sm", variant: "outline", children: status ?? (transcript ? 'Re-transcribe' : 'Transcribe') }), _jsx(Button, { onClick: () => void play(file), size: "sm", variant: "outline", children: playing?.path === file.path ? 'Hide' : 'Play' })] })] }), transcript && (_jsxs("div", { className: "rounded-md bg-muted/40 p-3", children: [_jsx("p", { className: "whitespace-pre-wrap text-xs leading-relaxed text-foreground", children: transcript }), _jsx("div", { className: "mt-2 flex items-center gap-2", children: _jsx(Button, { disabled: savedNote[file.path], onClick: () => void saveTranscriptNote(file), size: "sm", variant: "secondary", children: savedNote[file.path] ? 'Saved to Library ✓' : 'Save as note' }) })] }))] }, file.path));
                        }) })) : (_jsx(EmptyState, { className: cn('min-h-28'), description: "Recordings save to Documents / Nemesis Recordings as ordinary audio files.", title: "No recordings yet" })), playing && _jsx("audio", { autoPlay: true, className: "mt-3 w-full", controls: true, src: playing.src }), _jsx("p", { className: "pt-4 text-[11px] leading-relaxed text-muted-foreground", children: "Recording other people may require their consent where you live \u2014 check your school\u2019s policy. Nemesis never records on its own and never hides the indicator. Transcription runs on your device (the first run downloads a small model); the text is a draft \u2014 review it before you rely on it." })] })] }));
}
