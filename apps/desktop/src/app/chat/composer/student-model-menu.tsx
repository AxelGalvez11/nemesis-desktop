// Nemesis student model picker. Students never see "deepseek" or any model/provider name —
// they choose one of THREE answer modes (owner ask, 2026-07-14): Instant / Medium / High.
// These map to the per-turn fast-mode + reasoning-effort the agent already honors
// (Instant = fast mode on; Medium/High = thinking with that effort). The actual model
// stays whatever Nemesis provisions — Nemesis provides (and bills for) the AI, so model
// selection is ours, not the student's.
import { useStore } from '@nanostores/react'

import { cn } from '@/lib/utils'
import { $currentFastMode, $currentReasoningEffort, setCurrentFastMode, setCurrentReasoningEffort } from '@/store/session'

type AnswerMode = 'high' | 'instant' | 'medium'

export function currentAnswerMode(fast: boolean, effort: string): AnswerMode {
  if (fast) {
    return 'instant'
  }

  return effort === 'high' ? 'high' : 'medium'
}

export function answerModeLabel(mode: AnswerMode): string {
  return mode === 'instant' ? 'Instant' : mode === 'high' ? 'High' : 'Medium'
}

// Labels only — no explanations (owner call 2026-07-16: the box read too big).
const MODES: ReadonlyArray<{ label: string; mode: AnswerMode }> = [
  { label: 'Instant', mode: 'instant' },
  { label: 'Medium', mode: 'medium' },
  { label: 'High', mode: 'high' }
]

function applyAnswerMode(mode: AnswerMode) {
  if (mode === 'instant') {
    setCurrentFastMode(() => true)

    return
  }

  setCurrentFastMode(() => false)
  setCurrentReasoningEffort(() => (mode === 'high' ? 'high' : 'medium'))
}

export function StudentModelMenu() {
  const fast = useStore($currentFastMode)
  const effort = useStore($currentReasoningEffort) || 'medium'
  const active = currentAnswerMode(fast, effort)

  return (
    <div className="w-32 p-1">
      <div className="flex flex-col gap-0.5">
        {MODES.map(({ label, mode }) => (
          <button
            className={cn(
              'rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors',
              active === mode ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'
            )}
            key={mode}
            onClick={() => applyAnswerMode(mode)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
