// Nemesis student model picker. Students never see "deepseek" or any model/provider name —
// they choose an ANSWER MODE (Fast vs Thinking) and, when thinking, an effort level. These
// map to the same per-turn fast-mode + reasoning-effort the agent already honors; the actual
// model stays whatever Nemesis provisions. Nemesis provides (and bills for) the AI, so model
// selection is ours, not the student's.
import { useStore } from '@nanostores/react'

import { cn } from '@/lib/utils'
import { $currentFastMode, $currentReasoningEffort, setCurrentFastMode, setCurrentReasoningEffort } from '@/store/session'

const EFFORTS: ReadonlyArray<readonly [string, string]> = [
  ['low', 'Light'],
  ['medium', 'Balanced'],
  ['high', 'Deep']
]

export function StudentModelMenu() {
  const fast = useStore($currentFastMode)
  const effort = useStore($currentReasoningEffort) || 'medium'

  const segment = (active: boolean) =>
    cn(
      'flex-1 rounded-md px-2 py-1.5 text-sm transition-colors',
      active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'
    )

  return (
    <div className="w-64 p-1">
      <div className="px-3 pb-1.5 pt-2 text-xs font-medium text-muted-foreground">Answer mode</div>
      <div className="flex gap-1 px-2">
        <button className={segment(fast)} onClick={() => setCurrentFastMode(() => true)} type="button">
          Fast
        </button>
        <button className={segment(!fast)} onClick={() => setCurrentFastMode(() => false)} type="button">
          Thinking
        </button>
      </div>
      <p className="px-3 pb-1 pt-1.5 text-xs text-muted-foreground">
        {fast ? 'Quick answers for simple questions.' : 'Reasons step by step — better for hard problems.'}
      </p>

      {!fast && (
        <>
          <div className="mx-2 my-1.5 border-t border-border" />
          <div className="px-3 pb-1.5 text-xs font-medium text-muted-foreground">Effort</div>
          <div className="flex gap-1 px-2 pb-1">
            {EFFORTS.map(([value, label]) => (
              <button
                className={cn(
                  'flex-1 rounded-md px-2 py-1.5 text-xs transition-colors',
                  effort === value ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'
                )}
                key={value}
                onClick={() => setCurrentReasoningEffort(() => value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
