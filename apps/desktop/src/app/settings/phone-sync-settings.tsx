// Settings → Phone: pair the Nemesis iPhone app and watch what this Mac is
// publishing. The pairing code IS the vault key — rendered as a QR plus a
// copyable string, shown only while the dialog is open, never persisted in the
// renderer and never logged. Everything the agent writes syncs end-to-end
// encrypted; the server stores ciphertext it cannot read.
import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type PhoneSyncStatus = {
  paired: boolean
  lastPublish: { at: number; published: number; deleted: number; total: number } | null
}

function agoLabel(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function publishLine(status: PhoneSyncStatus): string {
  if (!status.paired) return 'Pair your phone to start syncing.'
  const last = status.lastPublish
  if (!last) return 'Paired. Waiting for the first publish (runs every 30 seconds while you are signed in).'
  const changes = last.published + last.deleted
  const what = changes === 0 ? 'Everything up to date' : `${changes} note${changes === 1 ? '' : 's'} updated`
  return `${what} · ${last.total} notes tracked · checked ${agoLabel(last.at)}`
}

export function PhoneSyncSettings() {
  const [status, setStatus] = useState<PhoneSyncStatus | null>(null)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [code, setCode] = useState<null | string>(null)
  const [qrDataUrl, setQrDataUrl] = useState<null | string>(null)
  const [copied, setCopied] = useState(false)
  const [confirmingUnpair, setConfirmingUnpair] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void window.hermesDesktop
      ?.nemesisPhoneSyncStatus?.()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  const openPairing = async () => {
    setBusy(true)
    try {
      const result = await window.hermesDesktop?.nemesisPhoneSyncPairingCode?.()
      if (!result?.code) return
      setCode(result.code)
      setQrDataUrl(await QRCode.toDataURL(result.code, { margin: 1, width: 260 }))
      setPairingOpen(true)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  // Drop the key material from renderer state the moment the dialog closes.
  const closePairing = () => {
    setPairingOpen(false)
    setCode(null)
    setQrDataUrl(null)
    setCopied(false)
  }

  const copyCode = async () => {
    if (!code) return
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const unpair = async () => {
    setBusy(true)
    try {
      await window.hermesDesktop?.nemesisPhoneSyncUnpair?.()
      setConfirmingUnpair(false)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-6">
      <div>
        <h2 className="text-lg font-semibold text-(--ui-fg-primary)">Phone</h2>
        <p className="mt-1 text-sm text-(--ui-fg-secondary)">
          Read your library on your phone. Everything the agent writes on this Mac shows up in the Nemesis iPhone app —
          end-to-end encrypted, so it stays between your devices. Your phone can read it anywhere, even offline.
        </p>
      </div>

      <div className="rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-(--ui-fg-primary)">
              {status === null ? 'Checking…' : status.paired ? 'Paired with your phone' : 'Not paired yet'}
            </div>
            <div className="mt-1 text-xs text-(--ui-fg-secondary)">{status ? publishLine(status) : ' '}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button disabled={busy} onClick={() => void openPairing()} variant="outline">
              {status?.paired ? 'Show pairing code' : 'Pair phone'}
            </Button>
          </div>
        </div>
      </div>

      {status?.paired ? (
        <div className="rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-(--ui-fg-primary)">Unpair</div>
              <div className="mt-1 text-xs text-(--ui-fg-secondary)">
                Stops syncing, forgets the key on this Mac, and removes the synced copies from the server. Your files
                here are untouched. The phone keeps only what it already downloaded until you unpair there too.
              </div>
            </div>
            {confirmingUnpair ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button disabled={busy} onClick={() => setConfirmingUnpair(false)} variant="outline">
                  Keep
                </Button>
                <Button disabled={busy} onClick={() => void unpair()} variant="outline">
                  Yes, unpair
                </Button>
              </div>
            ) : (
              <Button disabled={busy} onClick={() => setConfirmingUnpair(true)} variant="outline">
                Unpair…
              </Button>
            )}
          </div>
        </div>
      ) : null}

      <Dialog onOpenChange={open => !open && closePairing()} open={pairingOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Pair your phone</DialogTitle>
            <DialogDescription>
              In the Nemesis iPhone app, open Library → Scan pairing code and point the camera here.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            {qrDataUrl ? (
              <img
                alt="Nemesis pairing code"
                className="rounded-lg border border-(--ui-stroke-tertiary) bg-white p-2"
                height={260}
                src={qrDataUrl}
                width={260}
              />
            ) : null}
            <button
              className="max-w-full truncate rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-3 py-2 font-mono text-xs text-(--ui-fg-secondary) hover:text-(--ui-fg-primary)"
              onClick={() => void copyCode()}
              title="Copy the code (for typing it in manually)"
              type="button"
            >
              {copied ? 'Copied' : (code ?? '')}
            </button>
            <p className="text-xs text-(--ui-fg-secondary)">
              This code is the key to your notes. Show it only to your own phone — anyone with it can read your
              library.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
