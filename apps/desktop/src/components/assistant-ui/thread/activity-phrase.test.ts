import { describe, expect, it } from 'vitest'

import { ACTIVITY_FALLBACK_PHRASE, type ActivityEvent, currentActivityEvent, phraseForActivity } from './activity-phrase'

const tool = (toolName: string, args?: unknown): ActivityEvent => ({ args, toolName, type: 'tool-call' })

const reasoning = (text: string): ActivityEvent => ({ text, type: 'reasoning' })

describe('phraseForActivity', () => {
  it('maps browser navigation to the bare hostname', () => {
    const event = tool('browser_navigate', { url: 'https://www.blackboard.uthsc.edu/ultra/courses/_123' })

    expect(phraseForActivity(event)).toBe('Browsing blackboard.uthsc.edu…')
  })

  it('stays generic for browser actions without a nameable destination', () => {
    expect(phraseForActivity(tool('browser_click', { ref: '@button-3' }))).toBe('Browsing…')
  })

  it('maps web search to source + quoted query', () => {
    expect(phraseForActivity(tool('web_search', { query: 'tesamorelin dosing' }))).toBe(
      "Searching the web for 'tesamorelin dosing'…"
    )
  })

  it('maps pubmed-flavored search tools to PubMed', () => {
    expect(phraseForActivity(tool('pubmed_search', { query: 'tesamorelin' }))).toBe(
      "Searching PubMed for 'tesamorelin'…"
    )
  })

  it('maps trials-flavored search tools to ClinicalTrials.gov', () => {
    expect(phraseForActivity(tool('search_trials', { query: 'GLP-1 agonists' }))).toBe(
      "Searching ClinicalTrials.gov for 'GLP-1 agonists'…"
    )
  })

  it('maps openfda-flavored search tools to openFDA', () => {
    expect(phraseForActivity(tool('openfda_search', { search_term: 'metformin recalls' }))).toBe(
      "Searching openFDA for 'metformin recalls'…"
    )
  })

  it('caps search queries at 40 characters including the ellipsis', () => {
    const phrase = phraseForActivity(tool('web_search', { query: 'x'.repeat(80) }))
    const quoted = /'([^']*)'/.exec(phrase)?.[1] ?? ''

    expect(quoted.length).toBeLessThanOrEqual(40)
    expect(quoted.endsWith('…')).toBe(true)
  })

  it('maps file writes and edits to the file basename', () => {
    expect(phraseForActivity(tool('write_file', { path: '/Users/ax/Library/Renal dosing.md' }))).toBe(
      'Writing Renal dosing.md…'
    )

    expect(phraseForActivity(tool('edit_file', { file: 'notes\\pharm\\Loop diuretics.md' }))).toBe(
      'Writing Loop diuretics.md…'
    )

    expect(phraseForActivity(tool('patch', {}))).toBe('Writing a file…')
  })

  it('never echoes the raw command for terminal tools', () => {
    const phrase = phraseForActivity(tool('terminal', { command: 'rm -rf /tmp/scratch && ls' }))

    expect(phrase).toBe('Running a command…')
    expect(phrase).not.toContain('rm -rf')
    expect(phraseForActivity(tool('execute_code', { code: 'print(1)' }))).toBe('Running a command…')
  })

  it('maps the nemesis-study-decks skill to the flashcard phrase', () => {
    expect(phraseForActivity(tool('skill_view', { name: 'nemesis-study-decks' }))).toBe(
      'Building your flashcard deck…'
    )
  })

  it('maps the nemesis-deliverables skill to the slides phrase', () => {
    expect(phraseForActivity(tool('skill_view', { name: 'nemesis-deliverables' }))).toBe('Assembling your slides…')
  })

  it('maps the school-portal skill (plugin-qualified too) to the portal phrase', () => {
    expect(phraseForActivity(tool('skill_view', { name: 'school-portal' }))).toBe('Checking your school portal…')
    expect(phraseForActivity(tool('skill_view', { name: 'nemesis:school-portal' }))).toBe(
      'Checking your school portal…'
    )
  })

  it('maps the nemesis-organize skill to the library phrase', () => {
    expect(phraseForActivity(tool('skill_view', { name: 'nemesis-organize' }))).toBe('Tidying your library…')
  })

  it('falls back for skills without a student-facing phrase', () => {
    expect(phraseForActivity(tool('skill_view', { name: 'note-taking' }))).toBe(ACTIVITY_FALLBACK_PHRASE)
  })

  it('turns reasoning text into its cleaned first sentence', () => {
    const event = reasoning('**Okay** — I need to pull the `renal dosing` slides first. Then I will build cards.')

    expect(phraseForActivity(event)).toBe('Okay — I need to pull the renal dosing slides first…')
  })

  it('truncates long reasoning to roughly 90 characters with a trailing ellipsis', () => {
    const phrase = phraseForActivity(reasoning(`${'thinking about vancomycin trough targets '.repeat(6)}.`))

    expect(phrase.length).toBeLessThanOrEqual(91)
    expect(phrase.endsWith('…')).toBe(true)
  })

  it('falls back for unknown tools', () => {
    expect(phraseForActivity(tool('todo', { items: [] }))).toBe(ACTIVITY_FALLBACK_PHRASE)
  })

  it('falls back for missing events', () => {
    expect(phraseForActivity(null)).toBe(ACTIVITY_FALLBACK_PHRASE)
    expect(phraseForActivity(undefined)).toBe(ACTIVITY_FALLBACK_PHRASE)
  })
})

describe('currentActivityEvent', () => {
  it('picks the newest tool call', () => {
    const parts = [
      { text: 'Planning the search.', type: 'reasoning' },
      { args: { query: 'a' }, result: { ok: true }, toolName: 'web_search', type: 'tool-call' },
      { args: { url: 'https://pubmed.ncbi.nlm.nih.gov' }, toolName: 'browser_navigate', type: 'tool-call' }
    ]

    expect(currentActivityEvent(parts)).toMatchObject({ toolName: 'browser_navigate', type: 'tool-call' })
  })

  it('prefers streaming reasoning that follows completed tools', () => {
    const parts = [
      { args: {}, result: {}, toolName: 'web_search', type: 'tool-call' },
      { text: 'Now comparing the two trials.', type: 'reasoning' }
    ]

    expect(currentActivityEvent(parts)).toEqual({ text: 'Now comparing the two trials.', type: 'reasoning' })
  })

  it('goes quiet once visible answer text is streaming', () => {
    const parts = [
      { args: {}, result: {}, toolName: 'web_search', type: 'tool-call' },
      { text: 'Here is what I found:', type: 'text' }
    ]

    expect(currentActivityEvent(parts)).toBeNull()
  })

  it('returns null when there is nothing to describe', () => {
    expect(currentActivityEvent([])).toBeNull()
    expect(currentActivityEvent([{ text: '', type: 'reasoning' }, null])).toBeNull()
  })
})
