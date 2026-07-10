// On-device transcription for the Recorder — Whisper via transformers.js (@huggingface/
// transformers, MIT). The model (whisper-tiny.en, ~40MB) downloads once from the Hugging
// Face hub on first use and is cached by the browser; audio never leaves the machine for
// the transcription itself. WASM runs single-threaded (a file:// packaged app isn't
// cross-origin isolated, so SharedArrayBuffer/multi-thread is unavailable — tiny.en is
// still real-time-ish on Apple Silicon). base.en is the documented accuracy upgrade.
import { pipeline, env } from '@huggingface/transformers';
// Fetch models from the hub (we don't ship them in the bundle).
env.allowLocalModels = false;
// Force single-threaded WASM — no SAB under file://.
if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
}
const MODEL_ID = 'Xenova/whisper-tiny.en';
let transcriberPromise = null;
function getTranscriber(onStatus) {
    if (!transcriberPromise) {
        transcriberPromise = pipeline('automatic-speech-recognition', MODEL_ID, {
            progress_callback: (info) => {
                if (info.status === 'progress') {
                    onStatus?.({ progress: info.progress, stage: 'loading-model' });
                }
            }
        });
    }
    return transcriberPromise;
}
/** Decode any browser-playable audio (webm/opus here) to 16 kHz mono Float32 — Whisper's input. */
async function decodeTo16kMono(arrayBuffer) {
    const ctx = new AudioContext();
    try {
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        const frames = Math.ceil(decoded.duration * 16_000);
        const offline = new OfflineAudioContext(1, frames, 16_000);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start();
        const rendered = await offline.startRendering();
        return rendered.getChannelData(0);
    }
    finally {
        void ctx.close();
    }
}
export async function transcribeAudio(arrayBuffer, onStatus) {
    const transcriber = await getTranscriber(onStatus);
    onStatus?.({ stage: 'decoding' });
    const audio = await decodeTo16kMono(arrayBuffer);
    onStatus?.({ stage: 'transcribing' });
    const result = await transcriber(audio, { chunk_length_s: 30, return_timestamps: false, stride_length_s: 5 });
    return (result.text || '').trim();
}
