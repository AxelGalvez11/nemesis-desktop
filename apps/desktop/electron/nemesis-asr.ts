// nemesis-asr — main-process side of the on-device speech engine.
//
// Owns two things:
//   1. The MODEL: NVIDIA parakeet-tdt-0.6b-v2 int8 (CC-BY-4.0), fetched ONCE
//      (~480 MB) from the sherpa-onnx release mirror into userData/asr/ with
//      progress relayed to the renderer. Nothing is sent anywhere — the model
//      comes down, audio stays on the machine.
//   2. The WORKER: a utilityProcess hosting sherpa-onnx (dist/asr-worker.cjs),
//      kept warm between jobs (model load ≈ 1.4 s) and killed after 2 min idle
//      (the loaded engine holds real memory). Jobs run one at a time.
//
// Renderer contract (see preload):
//   invoke 'nemesis:asr:transcribe' { samples: Float32Array, sampleRate }
//     → { ok: true, text } | { ok: false, error }
//   on 'nemesis:asr:progress' { phase: 'downloading'|'preparing'|'transcribing', pct? }
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises'
import path from 'node:path'

import { app, ipcMain, net, utilityProcess, type UtilityProcess } from 'electron'

const MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
// Tarball (~482 MB) + extracted model (~640 MB) coexist briefly during setup.
const REQUIRED_FREE_BYTES = 1_400_000_000
const WORKER_IDLE_KILL_MS = 120_000

type Progress = { pct?: number; phase: 'downloading' | 'preparing' | 'transcribing' }
type ProgressSink = (progress: Progress) => void

function modelDir(): string {
  return path.join(app.getPath('userData'), 'asr', MODEL_NAME)
}

async function modelReady(): Promise<boolean> {
  const dir = modelDir()

  const checks = await Promise.all(
    MODEL_FILES.map(file =>
      stat(path.join(dir, file)).then(
        info => info.size > 0,
        () => false
      )
    )
  )

  return checks.every(Boolean)
}

async function extractTarball(tarPath: string, intoDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xjf', tarPath, '-C', intoDir])
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))))
  })
}

async function downloadModel(onProgress: ProgressSink): Promise<void> {
  const parent = path.join(app.getPath('userData'), 'asr')
  await mkdir(parent, { recursive: true })

  const disk = await statfs(parent)

  if (disk.bavail * disk.bsize < REQUIRED_FREE_BYTES) {
    throw new Error('Not enough free disk space for the speech model (needs about 1.4 GB free).')
  }

  const tarPath = path.join(parent, `${MODEL_NAME}.tar.bz2.partial`)
  const response = await net.fetch(MODEL_URL)

  if (!response.ok || !response.body) {
    throw new Error(`model download failed: HTTP ${response.status}`)
  }

  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()
  const sink = createWriteStream(tarPath)
  let received = 0
  let lastPct = -1

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      received += value.byteLength
      await new Promise<void>((resolve, reject) =>
        sink.write(value, error => (error ? reject(error) : resolve()))
      )

      if (total > 0) {
        const pct = Math.floor((received / total) * 100)

        if (pct !== lastPct) {
          lastPct = pct
          onProgress({ pct, phase: 'downloading' })
        }
      }
    }

    await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())))
    onProgress({ phase: 'preparing' })

    // The tarball extracts to MODEL_NAME/ inside `parent`; make it atomic-ish by
    // extracting first and renaming into place only on success.
    const extracted = path.join(parent, MODEL_NAME)
    await rm(extracted, { force: true, recursive: true })
    await extractTarball(tarPath, parent)

    if (!(await modelReady())) {
      // extract landed, but not where/what we expect — surface loudly.
      const finalDir = modelDir()

      if (extracted !== finalDir) {
        await rename(extracted, finalDir)
      }

      if (!(await modelReady())) {
        throw new Error('model archive did not contain the expected files')
      }
    }
  } finally {
    await rm(tarPath, { force: true }).catch(() => {})
  }
}

// ---- worker lifecycle ------------------------------------------------------

let worker: null | UtilityProcess = null
let idleTimer: null | ReturnType<typeof setTimeout> = null
let nextJobId = 1
const pendingJobs = new Map<number, { reject: (error: Error) => void; resolve: (text: string) => void }>()

function workerScriptPath(): string {
  // dist/** ships asar-UNPACKED; fork from the real files so the worker's
  // require('sherpa-onnx-node') and its dylibs resolve on disk.
  return path
    .join(app.getAppPath(), 'dist', 'asr-worker.cjs')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

function stopWorker(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  worker?.kill()
  worker = null
}

function getWorker(): UtilityProcess {
  if (worker) {
    return worker
  }

  const spawned = utilityProcess.fork(workerScriptPath(), [], { serviceName: 'nemesis-asr' })

  spawned.on('message', (message: { error?: string; id: number; ok: boolean; text?: string }) => {
    const job = pendingJobs.get(message.id)

    if (!job) {
      return
    }

    pendingJobs.delete(message.id)

    if (message.ok) {
      job.resolve(message.text ?? '')
    } else {
      job.reject(new Error(message.error ?? 'transcription failed'))
    }
  })

  spawned.on('exit', () => {
    if (worker === spawned) {
      worker = null
    }

    for (const [id, job] of pendingJobs) {
      pendingJobs.delete(id)
      job.reject(new Error('speech engine stopped unexpectedly'))
    }
  })

  worker = spawned

  return spawned
}

function runJob(samples: Float32Array, sampleRate: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const id = nextJobId++
    pendingJobs.set(id, { reject, resolve })

    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }

    getWorker().postMessage({ id, modelDir: modelDir(), sampleRate, samples })
  }).finally(() => {
    if (pendingJobs.size === 0) {
      idleTimer = setTimeout(stopWorker, WORKER_IDLE_KILL_MS)
    }
  })
}

// ---- IPC -------------------------------------------------------------------

// One transcription (and at most one model download) at a time, app-wide.
let chain: Promise<unknown> = Promise.resolve()

export function registerNemesisAsr(): void {
  ipcMain.handle('nemesis:asr:transcribe', (event, payload: { sampleRate?: number; samples?: Float32Array }) => {
    const samples = payload?.samples
    const sampleRate = payload?.sampleRate ?? 16_000

    if (!(samples instanceof Float32Array) || samples.length === 0 || !Number.isFinite(sampleRate)) {
      return { error: 'invalid audio payload', ok: false }
    }

    const report: ProgressSink = progress => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('nemesis:asr:progress', progress)
      }
    }

    const task = chain
      .catch(() => {})
      .then(async () => {
        if (!(await modelReady())) {
          await downloadModel(report)
        }

        report({ phase: 'transcribing' })

        const text = await runJob(samples, sampleRate)

        return { ok: true as const, text }
      })

    chain = task

    return task.catch(error => ({
      error: error instanceof Error ? error.message : String(error),
      ok: false as const
    }))
  })

  app.on('before-quit', stopWorker)
}
