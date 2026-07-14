// On-device transcription for the Recorder — Whisper via transformers.js (@huggingface/
// transformers, MIT). Models download once from the Hugging Face hub on first use and are
// cached by the browser; audio never leaves the machine for the transcription itself. WASM
// runs single-threaded (a file:// packaged app isn't cross-origin isolated, so
// SharedArrayBuffer/multi-thread is unavailable).
//
// TWO models, chosen per job — accuracy vs. latency:
//   - LIVE (whisper-tiny.en, ~40MB): the rolling caption shown WHILE recording. Must keep
//     up with ~8s chunks in real time single-threaded, so speed wins over accuracy — these
//     captions are ephemeral scaffolding, not the saved record.
//   - BATCH (whisper-base.en, ~1 tier up): the accuracy pass. After stop, the recorder
//     saves the note with the live captions immediately, then refineTranscript (service.ts)
//     re-transcribes the audio through this model in the background and swaps the note's
//     Transcript section (recordings ≤30 min). The "Transcribe" button in Recordings runs
//     the same model by hand for anything else. base.en is the documented accuracy step up
//     from tiny and still loads reliably in single-threaded onnxruntime-web (small.en fp32
//     would be ~1GB — too heavy for a one-time hub pull).
import { env, pipeline } from '@huggingface/transformers'

// Fetch models from the hub (we don't ship them in the bundle).
env.allowLocalModels = false

// Force single-threaded WASM — no SAB under file://.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1
}

const LIVE_MODEL_ID = 'Xenova/whisper-tiny.en'
const BATCH_MODEL_ID = 'Xenova/whisper-base.en'

export type TranscribeStatus = { stage: 'loading-model' | 'decoding' | 'transcribing'; progress?: number }

type Transcriber = (audio: Float32Array, opts: object) => Promise<{ text: string }>

// One cached pipeline per model id — the live caption path and the post-stop
// batch path each warm and reuse their own.
const transcriberPromises = new Map<string, Promise<Transcriber>>()

function getTranscriber(modelId: string, onStatus?: (s: TranscribeStatus) => void): Promise<Transcriber> {
  const existing = transcriberPromises.get(modelId)

  if (existing) {
    return existing
  }

  const created = pipeline('automatic-speech-recognition', modelId, {
    // Force full-precision weights. The default 4-bit-quantized variant fails to
    // create an ONNX session in the bundled onnxruntime-web (MatMulNBits missing
    // scale). fp32 is a touch larger but loads reliably single-threaded.
    dtype: { decoder_model_merged: 'fp32', encoder_model: 'fp32' },
    progress_callback: (info: { status?: string; progress?: number }) => {
      if (info.status === 'progress') {
        onStatus?.({ progress: info.progress, stage: 'loading-model' })
      }
    }
  }) as unknown as Promise<Transcriber>

  transcriberPromises.set(modelId, created)

  return created
}

/** Decode any browser-playable audio (webm/opus here) to 16 kHz mono Float32 — the
 *  input format for both the WASM models here and the native engine (native-asr.ts).
 *  NOTE: decodeAudioData DETACHES the given ArrayBuffer — pass a fresh copy per call. */
export async function decodeTo16kMono(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext()

  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    const frames = Math.ceil(decoded.duration * 16_000)
    const offline = new OfflineAudioContext(1, frames, 16_000)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()

    return rendered.getChannelData(0)
  } finally {
    void ctx.close()
  }
}

/** Post-stop transcription — the ACCURATE path. Uses the batch model
 *  (base.en), decodes the recorded audio, and returns the transcript that gets
 *  saved to the Library note. No real-time constraint here, so accuracy wins. */
export async function transcribeAudio(
  arrayBuffer: ArrayBuffer,
  onStatus?: (s: TranscribeStatus) => void
): Promise<string> {
  const transcriber = await getTranscriber(BATCH_MODEL_ID, onStatus)
  onStatus?.({ stage: 'decoding' })
  const audio = await decodeTo16kMono(arrayBuffer)
  onStatus?.({ stage: 'transcribing' })
  const result = await transcriber(audio, { chunk_length_s: 30, return_timestamps: false, stride_length_s: 5 })

  return (result.text || '').trim()
}

/** Live-caption path — the FAST path. Transcribes raw 16 kHz mono samples
 *  directly (no decode step) with the small live model so the rolling caption
 *  keeps up. The Recorder feeds ~8s chunks of the live mix through here while
 *  recording; the accurate transcript comes from transcribeAudio after stop. */
export async function transcribeSamples(
  samples: Float32Array,
  onStatus?: (s: TranscribeStatus) => void
): Promise<string> {
  const transcriber = await getTranscriber(LIVE_MODEL_ID, onStatus)
  onStatus?.({ stage: 'transcribing' })
  const result = await transcriber(samples, { chunk_length_s: 30, return_timestamps: false })

  return (result.text || '').trim()
}

/** Warm the live model in the background (first run downloads ~40MB once).
 *  The heavier batch model warms lazily on the first post-stop transcription so
 *  opening the Recorder doesn't eat its larger download up front. */
export function preloadTranscriber(onStatus?: (s: TranscribeStatus) => void): Promise<unknown> {
  return getTranscriber(LIVE_MODEL_ID, onStatus).catch(() => null)
}
