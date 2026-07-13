import { describe, expect, it } from 'vitest'

import { parseMindmapMarkdown } from './mindmap-parser'

describe('parseMindmapMarkdown', () => {
  it('uses headings and bullets as node topics', () => {
    const root = parseMindmapMarkdown('# Cardiac cycle\n- Systole\n- Diastole')

    expect(root.topic).toBe('Cardiac cycle')
    expect(root.children?.map(node => node.topic)).toEqual(['Systole', 'Diastole'])
  })

  it('splits a bullet note on only the first exact colon-space delimiter', () => {
    const root = parseMindmapMarkdown('# Root\n- Afterload: Resistance the ventricle must overcome: usually arterial pressure\n- Plain:term')

    expect(root.children?.[0]).toMatchObject({
      note: 'Resistance the ventricle must overcome: usually arterial pressure',
      topic: 'Afterload'
    })
    expect(root.children?.[1]).toMatchObject({ note: undefined, topic: 'Plain:term' })
  })

  it('preserves heading and indented-bullet nesting', () => {
    const root = parseMindmapMarkdown(
      ['# Pharmacology', '## Receptors', '- Agonists', '  - Full agonist: Produces the maximum response', '## Kinetics', '- Half-life'].join(
        '\n'
      )
    )

    expect(root.children?.map(node => node.topic)).toEqual(['Receptors', 'Kinetics'])
    expect(root.children?.[0].children?.[0].topic).toBe('Agonists')
    expect(root.children?.[0].children?.[0].children?.[0]).toMatchObject({
      note: 'Produces the maximum response',
      topic: 'Full agonist'
    })
    expect(root.children?.[1].children?.[0].topic).toBe('Half-life')
  })

  it('ignores the optional course comment', () => {
    const root = parseMindmapMarkdown('<!-- course: Cardiovascular -->\n# Hemodynamics\n- Preload')

    expect(root.topic).toBe('Hemodynamics')
    expect(root.children?.map(node => node.topic)).toEqual(['Preload'])
  })
})
