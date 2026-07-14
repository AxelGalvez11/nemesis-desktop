import { describe, expect, it } from 'vitest'

import { EMPTY_TRANSCRIPT_BODY, replaceTranscriptSection, TRANSCRIPT_HEADING } from './transcript-upgrade'

const note = (transcriptBody: string) =>
  `# Pharmacology 4 Mar 10.02\n\n*Recorded — draft.*\n\n## My notes\n\nmy typed notes\n${TRANSCRIPT_HEADING}${transcriptBody}\n`

describe('replaceTranscriptSection', () => {
  it('swaps a matching live transcript for the refined text', () => {
    const result = replaceTranscriptSection(note('rough live captions here'), 'rough live captions here', 'Accurate refined transcript.')

    expect(result).toBe(note('Accurate refined transcript.'))
  })

  it('replaces the empty-speech placeholder when live captions were off', () => {
    const result = replaceTranscriptSection(note(EMPTY_TRANSCRIPT_BODY), '', 'Recovered full transcript.')

    expect(result).toBe(note('Recovered full transcript.'))
  })

  it('refuses when the student edited the transcript section', () => {
    expect(replaceTranscriptSection(note('student rewrote all of this'), 'rough live captions here', 'refined')).toBeNull()
  })

  it('refuses when the note has no transcript section', () => {
    expect(replaceTranscriptSection('# Title\n\njust notes\n', 'anything', 'refined')).toBeNull()
  })

  it('tolerates surrounding whitespace differences', () => {
    const result = replaceTranscriptSection(note('  rough live captions here  \n'), 'rough live captions here', 'Refined.')

    expect(result).toBe(note('Refined.'))
  })
})
