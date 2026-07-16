/**
 * Bridges a dispatched mission (Task 2's `runMission` shape) to the desktop's
 * real agent gateway — the same JSON-RPC-over-WebSocket protocol the chat UI
 * uses to open a session and send a message (see mission-runner.test.ts for
 * the recon that pins down `session.create` / `prompt.submit` / the
 * message.delta / message.complete / error event names).
 *
 * This module never imports HermesGateway or the renderer's requestGateway
 * wrapper (both are UI-coupled, renderer-only). Instead it depends on a small
 * MissionGateway facade — connect/request/on/close — so it's fully unit
 * testable with a fake, and Task 5 wires a real gateway client (from
 * @hermes/shared, the same class HermesGateway subclasses) into it.
 */

export type MissionGatewayEvent = {
  type: string
  session_id?: string
  payload?: Record<string, unknown>
}

export type MissionGateway = {
  /** Opens (or re-opens) the connection. Mints its own fresh WS URL/ticket internally. */
  connect: () => Promise<void>
  request: <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>
  /** Subscribes to a gateway event type; returns an unsubscribe function. */
  on: (type: string, handler: (event: MissionGatewayEvent) => void) => () => void
  close: () => void
}

export type MissionRunnerOptions = {
  /** How long to wait for message.complete/error after prompt.submit acks before giving up. */
  completionTimeoutMs?: number
}

export type MissionRunResult = { ok: boolean; summary: string }

// Matches PROMPT_SUBMIT_REQUEST_TIMEOUT_MS in src/hermes.ts — the same ceiling
// the composer gives a turn (MoA presets, deep reasoning, long tool chains can
// legitimately take minutes). prompt.submit's own RPC ack is unrelated to this;
// this bounds the wait for the message.complete/error event that follows it.
const DEFAULT_COMPLETION_TIMEOUT_MS = 30 * 60_000

const MAX_SUMMARY_LENGTH = 500

// Verbatim per the dispatch plan — every mission prompt is prefixed with this
// so the agent knows it's unattended and must never cross the submit line.
const STANDING_HEADER =
  "[Dispatched from the student's phone. Work autonomously; do not wait for replies.\n" +
  'Produce a draft/result for review. Never submit anything to a school portal.]'

function coerceText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function createMissionRunner(gateway: MissionGateway, options: MissionRunnerOptions = {}) {
  const completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS

  return async function runMission(prompt: string, onLog: (line: string) => void): Promise<MissionRunResult> {
    const unsubscribers: Array<() => void> = []

    try {
      try {
        await gateway.connect()
      } catch (err) {
        return { ok: false, summary: err instanceof Error ? err.message : 'could not connect to the agent gateway' }
      }

      let sessionId: string
      try {
        const created = await gateway.request<{ session_id: string }>('session.create', {
          cols: 96,
          source: 'desktop'
        })
        sessionId = created?.session_id
        if (!sessionId) throw new Error('gateway did not return a session_id')
      } catch (err) {
        return { ok: false, summary: err instanceof Error ? err.message : 'could not open an agent session' }
      }

      const outcome = await new Promise<MissionRunResult>((resolve) => {
        let settled = false
        const settle = (result: MissionRunResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }

        const timer = setTimeout(() => {
          settle({ ok: false, summary: 'timed out waiting for the agent to finish this mission' })
        }, completionTimeoutMs)

        unsubscribers.push(
          gateway.on('message.delta', (event) => {
            if (event.session_id !== sessionId) return
            const text = coerceText(event.payload?.text)
            if (text) onLog(text)
          })
        )

        const onComplete = (event: MissionGatewayEvent) => {
          if (event.session_id !== sessionId) return
          const finalText = coerceText(event.payload?.text) || coerceText(event.payload?.rendered)
          settle({ ok: true, summary: finalText.slice(0, MAX_SUMMARY_LENGTH) })
        }

        unsubscribers.push(gateway.on('message.complete', onComplete))
        // A session opened from the main process (no foreground renderer
        // window) may route its completion as background.complete instead of
        // message.complete — both are real GatewayEventName values in the
        // renderer's protocol (apps/shared/src/json-rpc-gateway.ts) and this
        // can't be verified without a live device smoke test, so listen for
        // both rather than risk every mission timing out at completionTimeoutMs
        // despite the agent actually finishing.
        unsubscribers.push(gateway.on('background.complete', onComplete))

        unsubscribers.push(
          gateway.on('error', (event) => {
            if (event.session_id !== sessionId) return
            const message = coerceText(event.payload?.message) || 'the agent reported an error'
            settle({ ok: false, summary: message })
          })
        )

        // Explicit timeoutMs so a concrete gateway's own shorter default
        // request timeout can't cut this short: prompt.submit's ack itself
        // (not just the turn) can legitimately be slow under backend load
        // (see the recon comment above), so it shares the same ceiling as
        // waiting for message.complete rather than a generic short default.
        gateway.request('prompt.submit', { session_id: sessionId, text: `${STANDING_HEADER}\n\n${prompt}` }, completionTimeoutMs).catch((err) => {
          settle({ ok: false, summary: err instanceof Error ? err.message : 'could not submit the mission prompt' })
        })
      })

      return outcome
    } finally {
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe()
        } catch {
          // best-effort cleanup
        }
      }
      try {
        gateway.close()
      } catch {
        // best-effort cleanup
      }
    }
  }
}
