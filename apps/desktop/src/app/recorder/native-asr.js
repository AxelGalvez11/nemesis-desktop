export function nativeAsrAvailable() {
    return typeof window.hermesDesktop?.nemesisAsrTranscribe === 'function';
}
/** Human copy for the recorder's status line while the engine works. */
export function nativeAsrStatusLabel(status) {
    if (status.phase === 'downloading') {
        return `Downloading the accurate speech model (one-time, ~480 MB) — ${status.pct ?? 0}%`;
    }
    if (status.phase === 'preparing') {
        return 'Unpacking the speech model…';
    }
    return 'Refining the transcript with the accurate on-device model…';
}
/**
 * Transcribes browser-playable audio via the native engine. Returns null when
 * the engine isn't exposed in this build; throws when it is but the job failed
 * (model download failed, engine crashed) — callers fall back to WASM either way.
 */
export async function nativeTranscribe(audio, onStatus) {
    const bridge = window.hermesDesktop;
    if (!bridge?.nemesisAsrTranscribe) {
        return null;
    }
    const { decodeTo16kMono } = await import('./transcribe');
    const samples = await decodeTo16kMono(audio);
    const unsubscribe = onStatus && bridge.onNemesisAsrProgress ? bridge.onNemesisAsrProgress(onStatus) : null;
    try {
        const result = await bridge.nemesisAsrTranscribe(samples, 16_000);
        if (!result?.ok) {
            throw new Error(result?.error || 'transcription failed');
        }
        return (result.text ?? '').trim();
    }
    finally {
        unsubscribe?.();
    }
}
