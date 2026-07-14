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

const MODES: ReadonlyArray<{ description: string; label: string; mode: AnswerMode }> = [
  { description: 'Fastest answers for quick questions.', label: 'Instant', mode: 'instant' },
  { description: 'Thinks it through first — the everyday default.', label: 'Medium', mode: 'medium' },
  {
    description: 'Deepest reasoning for hard problems. Slower and uses more of your daily allowance.',
    label: 'High',
    mode: 'high'
  }
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
    <div className="w-72 p-1">
      <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Answer mode</div>
      <div className="flex flex-col gap-0.5 px-1 pb-1">
        {MODES.map(({ description, label, mode }) => (
          <button
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
              active === mode ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'
            )}
            key={mode}
            onClick={() => applyAnswerMode(mode)}
            type="button"
          >
            <span className="text-sm font-medium">{label}</span>
            <span className={cn('text-xs', active === mode ? 'text-primary-foreground/75' : 'text-muted-foreground')}>
              {description}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
