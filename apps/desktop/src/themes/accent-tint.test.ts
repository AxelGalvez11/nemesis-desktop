import { describe, expect, it } from 'vitest'

import { accentTokensFor, DEFAULT_ACCENT_ID, parseAccentSelection } from './accent-tint'
import { contrastRatio, hslToHex } from './color'

describe('parseAccentSelection', () => {
  it('defaults to crimson for empty/unknown values', () => {
    expect(parseAccentSelection(null).id).toBe(DEFAULT_ACCENT_ID)
    expect(parseAccentSelection('nonsense').id).toBe(DEFAULT_ACCENT_ID)
  })

  it('resolves a swatch id to its hue', () => {
    const teal = parseAccentSelection('teal')
    expect(teal.id).toBe('teal')
    expect(teal.hue).toBe(180)
  })

  it('parses and wraps a custom hue', () => {
    expect(parseAccentSelection('custom:220')).toEqual({ hue: 220, id: null })
    expect(parseAccentSelection('custom:400')).toEqual({ hue: 40, id: null })
    expect(parseAccentSelection('custom:-30')).toEqual({ hue: 330, id: null })
  })
})

describe('accentTokensFor', () => {
  it('applies the exact brand crimson for the default (contrast-guarded, not gray)', () => {
    const tokens = accentTokensFor({ hue: 353, id: DEFAULT_ACCENT_ID }, '#0e0e0e', true)
    // On the dark surface the brand red passes the guard untouched.
    expect(tokens['--theme-primary'].toLowerCase()).toBe('#ff2740')
    expect(contrastRatio(tokens['--theme-primary'], '#0e0e0e')).toBeGreaterThanOrEqual(4.5)
  })

  it('produces an accent that meets WCAG AA (4.5:1) on the dark surface', () => {
    for (const hue of [0, 45, 90, 180, 210, 270, 330]) {
      const accent = accentTokensFor({ hue, id: null }, '#0e0e0e', true)['--theme-primary']
      expect(contrastRatio(accent, '#0e0e0e')).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('produces an accent that meets WCAG AA (4.5:1) on the light surface', () => {
    for (const hue of [0, 45, 90, 180, 210, 270, 330]) {
      const accent = accentTokensFor({ hue, id: null }, '#f8faff', false)['--theme-primary']
      expect(contrastRatio(accent, '#f8faff')).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('gives on-accent label text at least UI-component contrast (3:1) against the fill', () => {
    // --dt-primary-foreground is the label on a solid accent button (a UI component,
    // WCAG AA minimum 3:1), not body text — onAccent picks the higher-contrast of
    // black/white for whatever fill the surface-contrast guard produced.
    for (const hue of [0, 90, 210, 300]) {
      const tokens = accentTokensFor({ hue, id: null }, '#0e0e0e', true)
      expect(contrastRatio(tokens['--dt-primary-foreground'], tokens['--theme-primary'])).toBeGreaterThanOrEqual(3)
    }
  })

  it('never emits a destructive/danger override (semantic colors are untouched)', () => {
    const tokens = accentTokensFor({ hue: 210, id: null }, '#0e0e0e', true)
    expect(Object.keys(tokens).some(k => k.includes('destructive'))).toBe(false)
  })
})

describe('hslToHex', () => {
  it('round-trips primary hues', () => {
    expect(hslToHex(0, 1, 0.5).toLowerCase()).toBe('#ff0000')
    expect(hslToHex(120, 1, 0.5).toLowerCase()).toBe('#00ff00')
    expect(hslToHex(240, 1, 0.5).toLowerCase()).toBe('#0000ff')
  })
})
