/**
 * Minimal hand-rolled JSON-RPC-over-WebSocket client for the mission
 * runner's gateway connection.
 *
 * This speaks the same wire protocol as the renderer's JsonRpcGatewayClient
 * (apps/shared/src/json-rpc-gateway.ts) but is reimplemented locally rather
 * than imported: electron/ has zero precedent for reaching into
 * apps/shared or src/ (both are separate esbuild entry points), and doing so
 * trips `tsc -b`'s composite-project rootDir check on tsconfig.electron.json
 * (confirmed empirically — the class bundles fine standalone, but the
 * project-wide typecheck npm run build depends on rejects it). Matching the
 * "no new deps, mirror update-remote.ts" style guide directly avoids that.
 *
 * Wire framing (copied exactly from json-rpc-gateway.ts — this is the
 * load-bearing part; mission-runner.ts's own tests only exercise the
 * MissionGateway facade via a fake, so nothing else checks this):
 *   - outbound request:  {jsonrpc:'2.0', id, method, params}
 *   - inbound response:  a frame carrying `id` resolves/rejects the pending
 *     call keyed by that id (frame.result on success, frame.error.message
 *     on failure)
 *   - inbound server event: {method:'event', params:{type, session_id,
 *     payload}} — dispatched to handlers keyed by params.type, passing
 *     `params` through verbatim as the event
 *
 * The socket factory is injected (same seam gateway-ws-probe.ts uses for its
 * WebSocketImpl) so this is fully unit testable without a real WebSocket.
 *
 * The MissionGateway/MissionGatewayEvent contract is owned by
 * mission-runner.ts (the consumer) — imported here rather than redefined, so
 * the two can't silently drift apart.
 */

import type { MissionGateway, MissionGatewayEvent } from './mission-runner'

export type { MissionGateway, MissionGatewayEvent }

type WebSocketLike = {
  readyState: number
  send: (data: string) => void
  close: () => void
  addEventListener: (type: string, handler: (event: any) => void) => void
}

export type CreateWebSocketGatewayDeps = {
  /** Mints a fresh WS URL. Called on every connect() — OAuth gateway tickets are single-use. */
  getWsUrl: () => Promise<string>
  createSocket: (url: string) => WebSocketLike
  /** Default per-request timeout when a caller doesn't pass one explicitly. */
  requestTimeoutMs?: number
  connectTimeoutMs?: number
}

const WS_OPEN = 1
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export function createWebSocketMissionGateway(deps: CreateWebSocketGatewayDeps): MissionGateway {
  let socket: WebSocketLike | null = null
  let nextId = 0
  const pending = new Map<number, PendingCall>()
  const handlers = new Map<string, Set<(event: MissionGatewayEvent) => void>>()

  function rejectAllPending(message: string) {
    for (const [id, call] of pending) {
      if (call.timer) clearTimeout(call.timer)
      call.reject(new Error(message))
      pending.delete(id)
    }
  }

  function handleMessage(raw: unknown) {
    let frame: any
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }

    if (frame.id !== undefined && frame.id !== null) {
      const call = pending.get(frame.id)
      if (!call) return
      pending.delete(frame.id)
      if (call.timer) clearTimeout(call.timer)

      if (frame.error) {
        call.reject(new Error(frame.error.message || 'mission gateway request failed'))
      } else {
        call.resolve(frame.result)
      }
      return
    }

    if (frame.method === 'event' && frame.params?.type) {
      const event = frame.params as MissionGatewayEvent
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    }
  }

  return {
    connect: async () => {
      const url = await deps.getWsUrl()
      const opened = deps.createSocket(url)
      socket = opened

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(`timed out connecting to the agent gateway after ${timeoutMs}ms`))
        }, timeoutMs)

        opened.addEventListener('message', (event: any) => handleMessage(event?.data))

        opened.addEventListener('open', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        })

        opened.addEventListener('error', (event: any) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(event?.error instanceof Error ? event.error : new Error('could not connect to the agent gateway'))
        })

        opened.addEventListener('close', () => {
          if (socket === opened) socket = null
          rejectAllPending('mission gateway connection closed')
        })
      })
    },

    request: <T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    ): Promise<T> => {
      if (!socket || socket.readyState !== WS_OPEN) {
        return Promise.reject(new Error('mission gateway is not connected'))
      }

      const id = ++nextId

      return new Promise<T>((resolve, reject) => {
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                if (pending.delete(id)) reject(new Error(`request timed out: ${method}`))
              }, timeoutMs)
            : undefined

        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })

        try {
          socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        } catch (err) {
          pending.delete(id)
          if (timer) clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },

    on: (type, handler) => {
      let set = handlers.get(type)
      if (!set) {
        set = new Set()
        handlers.set(type, set)
      }
      set.add(handler)
      return () => set!.delete(handler)
    },

    close: () => {
      const opened = socket
      socket = null
      try {
        opened?.close()
      } catch {
        // best-effort
      }
      rejectAllPending('mission gateway connection closed')
    }
  }
}
