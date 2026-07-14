// asr-worker — utilityProcess child hosting the on-device speech engine
// (sherpa-onnx + NVIDIA parakeet-tdt-0.6b-v2, CC-BY-4.0). Lives OUT of the main
// process because recognition is a blocking native call: a 1-hour lecture takes
// ~3 minutes of solid CPU that must never freeze the app. The parent sends one
// job at a time over parentPort; the recognizer is created once per model dir
// and reused. Audio never leaves this machine.

interface AsrJob {
  id: number
  modelDir: string
  sampleRate: number
  samples: Float32Array
}

type SherpaModule = {
  OfflineRecognizer: new (config: object) => {
    createStream: () => { acceptWaveform: (wave: { sampleRate: number; samples: Float32Array }) => void }
    decode: (stream: unknown) => void
    getResult: (stream: unknown) => { text: string }
  }
}

let sherpa: null | SherpaModule = null
let recognizer: InstanceType<SherpaModule['OfflineRecognizer']> | null = null
let recognizerModelDir = ''

function getRecognizer(modelDir: string) {
   
  sherpa ??= require('sherpa-onnx-node') as SherpaModule

  if (!recognizer || recognizerModelDir !== modelDir) {
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { featureDim: 80, sampleRate: 16_000 },
      modelConfig: {
        debug: 0,
        modelType: 'nemo_transducer',
        numThreads: 4,
        tokens: `${modelDir}/tokens.txt`,
        transducer: {
          decoder: `${modelDir}/decoder.int8.onnx`,
          encoder: `${modelDir}/encoder.int8.onnx`,
          joiner: `${modelDir}/joiner.int8.onnx`
        }
      }
    })
    recognizerModelDir = modelDir
  }

  return recognizer
}

process.parentPort?.on('message', (event: { data: AsrJob }) => {
  const { id, modelDir, sampleRate, samples } = event.data

  try {
    // Structured clone delivers Float32Array views intact; normalize defensively.
    const wave = samples instanceof Float32Array ? samples : new Float32Array(samples)
    const engine = getRecognizer(modelDir)
    const stream = engine.createStream()
    stream.acceptWaveform({ sampleRate, samples: wave })
    engine.decode(stream)
    const { text } = engine.getResult(stream)
    process.parentPort?.postMessage({ id, ok: true, text: (text || '').trim() })
  } catch (error) {
    process.parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error),
      id,
      ok: false
    })
  }
})
