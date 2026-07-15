import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import { NEW_CHAT_ROUTE } from '../routes'

import { completeOnboarding } from './onboarding'

export const READ_SEMESTER_PROMPT =
  'Connect to my school accounts and read my semester: every course on Blackboard — syllabi, slides, lecture files, announcements, due dates. File everything into my Library, update my calendar and semester graph, and show me what you found. Use the nemesis-graph and nemesis-ledger skills.'

export const FIND_MATERIALS_PROMPT =
  'Find my existing school files on this Mac (Documents, Desktop, Downloads, OneDrive/Google Drive folders), read my Anki collection, and fetch my Quizlet sets — propose what you find, then bring it into my Library. Use the nemesis-import skill.'

const IMPORTS_PATH = '~/Documents/Nemesis Library/Imports/'
const STEP_LABELS = ['Welcome', 'Connect', 'First sweep', 'Done'] as const

interface WelcomeViewProps {
  onStartSweep: (prompt: string) => void
}

function Progress({ step }: { step: number }) {
  return (
    <div aria-label={`Step ${step + 1} of ${STEP_LABELS.length}: ${STEP_LABELS[step]}`} className="flex gap-2">
      {STEP_LABELS.map((label, index) => (
        <span
          aria-label={label}
          className={cn(
            'h-1 w-7 rounded-full transition-colors',
            index <= step ? 'bg-(--theme-primary)' : 'bg-(--ui-bg-quaternary)'
          )}
          key={label}
        />
      ))}
    </div>
  )
}

function SweepCard({ icon, onClick, text, title }: { icon: string; onClick: () => void; text: string; title: string }) {
  return (
    <button
      className="group flex min-h-40 flex-col items-start rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5 text-left transition-colors hover:border-(--theme-primary)/45 hover:bg-(--ui-bg-quaternary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--theme-primary)/50"
      onClick={onClick}
      type="button"
    >
      <span className="mb-8 grid size-9 place-items-center rounded-lg bg-(--theme-primary)/10 text-(--theme-primary)">
        <Codicon name={icon} size="1rem" />
      </span>
      <span className="text-base font-semibold tracking-[-0.015em] text-(--ui-text-primary)">{title}</span>
      <span className="mt-1 text-xs leading-relaxed text-(--ui-text-tertiary)">{text}</span>
      <span className="mt-4 inline-flex items-center gap-1 text-[0.6875rem] font-semibold text-(--theme-primary)">
        Let Nemesis handle it <Codicon name="arrow-right" size="0.7rem" />
      </span>
    </button>
  )
}

function ConnectStep({ icon, text, title }: { icon: string; text: string; title: string }) {
  return (
    <div className="flex items-start gap-3.5 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-(--theme-primary)/10 text-(--theme-primary)">
        <Codicon name={icon} size="0.875rem" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold tracking-[-0.01em] text-(--ui-text-primary)">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-(--ui-text-tertiary)">{text}</span>
      </span>
    </div>
  )
}

export function WelcomeView({ onStartSweep }: WelcomeViewProps) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  const finish = () => {
    completeOnboarding()
    navigate(NEW_CHAT_ROUTE, { replace: true })
  }

  const startSweep = (prompt: string) => {
    completeOnboarding()
    onStartSweep(prompt)
  }

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-(--ui-editor-surface-background) font-mono text-(--ui-text-primary)">
      <div className="mx-auto flex min-h-full w-full max-w-[960px] flex-col px-6 pb-10 pt-16 sm:px-10 sm:pt-20">
        <div className="flex items-center justify-between gap-4">
          <Progress step={step} />
          {step > 0 && (
            <Button onClick={() => setStep(current => current - 1)} size="inline" variant="text">
              <Codicon name="arrow-left" /> Back
            </Button>
          )}
        </div>

        {step === 0 && (
          <section className="my-auto flex max-w-2xl flex-col items-start py-16">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-(--theme-primary)">
              Nemesis · Student agent
            </p>
            <h1 className="mt-5 text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Your semester, under watch.</h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-(--ui-text-secondary)">
              It runs the work around school. Let&apos;s connect your semester.
            </p>
            <div className="mt-10 flex items-center gap-4">
              <Button onClick={() => setStep(1)} size="lg">
                Begin
              </Button>
              <Button onClick={finish} size="inline" variant="text">
                Skip for now
              </Button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="mt-10 flex flex-1 flex-col">
            <div>
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-(--theme-primary)">Connect</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Bring your school within reach.</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-(--ui-text-secondary)">
                No forms here — you set this up by talking to Nemesis. Your logins stay on this Mac.
              </p>
            </div>
            {/* 2026-07-14: onboarding stopped embedding the Connections settings page (it
                confused testers). The agent owns portal setup now: the student names their
                school sites in chat and Nemesis writes portals.json (school-portal skill). */}
            <div className="mt-8 grid max-w-2xl gap-3">
              <ConnectStep
                icon="comment"
                text="Paste your school’s course site and webmail — “my school uses canvas.myschool.edu and outlook.com”."
                title="Tell Nemesis in chat"
              />
              <ConnectStep
                icon="globe"
                text="Nemesis opens the real site in its own browser panel. Type your password there — never in chat."
                title="Sign in once, in its browser"
              />
              <ConnectStep
                icon="pass"
                text="Your addresses are saved on this Mac, so every future sweep knows where your school lives."
                title="It remembers"
              />
            </div>
            <div className="mt-auto flex justify-end pt-4">
              <Button onClick={() => setStep(2)} size="lg">
                Continue
              </Button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="mt-10 flex flex-1 flex-col">
            <div>
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-(--theme-primary)">
                First sweep
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Choose the first job.</h1>
              <p className="mt-2 text-sm text-(--ui-text-secondary)">
                Nemesis will gather the material. You approve what comes into your Library.
              </p>
            </div>
            <div className="mt-8 grid gap-4 md:grid-cols-2">
              <SweepCard
                icon="book"
                onClick={() => startSweep(READ_SEMESTER_PROMPT)}
                text="Read Blackboard, organize every course, and build the semester plan."
                title="Read my semester"
              />
              <SweepCard
                icon="folder-opened"
                onClick={() => startSweep(FIND_MATERIALS_PROMPT)}
                text="Survey local files, Anki, and Quizlet before importing anything."
                title="Find my study materials"
              />
            </div>
            <div className="mt-4 flex items-center gap-3 rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-4 py-3">
              <Codicon className="text-(--ui-text-tertiary)" name="files" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-(--ui-text-secondary)">Manual import folder</p>
                <p className="truncate text-[0.6875rem] text-(--ui-text-quaternary)" title={IMPORTS_PATH}>
                  {IMPORTS_PATH}
                </p>
              </div>
              <span className="hidden text-[0.65rem] text-(--ui-text-quaternary) sm:block">
                Place files here to import them later.
              </span>
            </div>
            <div className="mt-auto flex justify-end pt-8">
              <Button onClick={() => setStep(3)} size="inline" variant="text">
                Choose a sweep later
              </Button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="my-auto flex max-w-2xl flex-col items-start py-16">
            <span className="grid size-12 place-items-center rounded-full bg-(--theme-primary)/10 text-(--theme-primary)">
              <Codicon name="check" size="1.15rem" />
            </span>
            <p className="mt-8 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-(--theme-primary)">
              Ready
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">Nemesis is watching your semester now.</h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-(--ui-text-secondary)">
              Ask anything in chat — Nemesis keeps watch and speaks up when something needs you.
            </p>
            <Button className="mt-9" onClick={finish} size="lg">
              Start
            </Button>
          </section>
        )}
      </div>
    </main>
  )
}
