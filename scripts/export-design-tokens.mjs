#!/usr/bin/env node
// export-design-tokens.mjs
//
// Parses the desktop app's own source of truth for its visual identity —
// apps/desktop/src/themes/presets.ts (theme color presets) and
// apps/desktop/src/styles.css (the corner-radius dial and accent-mix
// percentages) — and writes design-tokens/tokens.json at the repo root.
// That file is the single source other surfaces (the iOS companion app, per
// the dispatch plan) read for design-parity styling, instead of hand-copying
// hex values.
//
// Deliberately dependency-free: no TypeScript compiler, no CSS parser, just
// regex/string extraction over the source text. Re-run this whenever a theme
// preset or a token value in styles.css changes, then commit the refreshed
// design-tokens/tokens.json alongside the source edit.
//
// Usage: node scripts/export-design-tokens.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const PRESETS_PATH = join(REPO_ROOT, 'apps/desktop/src/themes/presets.ts')
const STYLES_PATH = join(REPO_ROOT, 'apps/desktop/src/styles.css')
const OUTPUT_PATH = join(REPO_ROOT, 'design-tokens/tokens.json')

// Presets to export. Add a name here to pick up another built-in theme —
// nothing else in this script needs to change.
const PRESET_NAMES = ['mono', 'nemesis']

// Hardcoded, not parsed: the desktop's UI font is the system stack (SF Pro on
// macOS), and iOS renders SF Pro natively, so "system" is the correct token
// on both platforms without extracting styles.css's full font-family string.
// JetBrains Mono is the desktop's bundled code font; the mobile app ships the
// same family via expo-font for code snippets only (see the dispatch plan).
const FONT_TOKENS = { sans: 'system', mono: 'JetBrains Mono' }

function fail(message) {
  console.error(`export-design-tokens: ${message}`)
  process.exit(1)
}

/** Returns the source slice from `openBraceIndex` through its matching `}`, tracking string literals so a brace inside a quoted value can't miscount. */
function extractBalancedBlock(source, openBraceIndex) {
  let depth = 0
  let quote = null

  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]

    if (quote) {
      if (ch === '\\') {
        i++ // skip the escaped character
      } else if (ch === quote) {
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(openBraceIndex, i + 1)
    }
  }

  fail(`unbalanced braces while scanning from index ${openBraceIndex}`)
}

/** Parses a flat `{ key: 'value', key2: 'value2' }`-shaped block (single-quoted string values only — true of every DesktopTheme color palette) into a plain object. */
function parseFlatStringObject(block) {
  const result = {}
  const pairPattern = /(\w+):\s*'([^']*)'/g
  let match

  while ((match = pairPattern.exec(block))) {
    result[match[1]] = match[2]
  }

  return result
}

/** Finds `label:`/`key: {...}` sub-blocks inside an already-isolated theme object block. */
function findSubBlock(themeBlock, key) {
  const anchor = new RegExp(`${key}:\\s*\\{`)
  const match = anchor.exec(themeBlock)
  if (!match) return null

  const openBraceIndex = match.index + match[0].length - 1
  return extractBalancedBlock(themeBlock, openBraceIndex)
}

function findStringField(themeBlock, key) {
  const match = new RegExp(`${key}:\\s*'([^']*)'`).exec(themeBlock)
  return match ? match[1] : null
}

function parsePreset(presetsSource, presetName) {
  const constName = `${presetName}Theme`
  const anchor = new RegExp(`export const ${constName}\\s*:\\s*DesktopTheme\\s*=\\s*\\{`)
  const match = anchor.exec(presetsSource)

  if (!match) {
    fail(`could not find "export const ${constName}: DesktopTheme = {" in ${PRESETS_PATH}`)
  }

  const openBraceIndex = match.index + match[0].length - 1
  const themeBlock = extractBalancedBlock(presetsSource, openBraceIndex)

  const label = findStringField(themeBlock, 'label')
  const description = findStringField(themeBlock, 'description')
  const colorsBlock = findSubBlock(themeBlock, 'colors')
  const darkColorsBlock = findSubBlock(themeBlock, 'darkColors')

  if (!colorsBlock) {
    fail(`preset "${presetName}" has no colors: {...} block in ${PRESETS_PATH}`)
  }

  return {
    label,
    description,
    colors: parseFlatStringObject(colorsBlock),
    // Both current presets (mono, nemesis) are single-palette, dark-only
    // themes with no separate darkColors block — null signals "same palette
    // regardless of light/dark", rather than duplicating `colors` here.
    darkColors: darkColorsBlock ? parseFlatStringObject(darkColorsBlock) : null
  }
}

function parseRadiusScalar(stylesSource) {
  const match = /--radius-scalar:\s*([0-9.]+)\s*;/.exec(stylesSource)
  if (!match) {
    fail(`could not find --radius-scalar in ${STYLES_PATH}`)
  }
  return Number(match[1])
}

function toCamelCase(hyphenated) {
  return hyphenated.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

/** Every `--theme-<word>-<word>-accent-mix: N%;` declaration (fill-primary, stroke-quaternary, row-hover, control-active, ...), camelCased. */
function parseAccentMixes(stylesSource) {
  const pattern = /--theme-([a-z]+-[a-z]+)-accent-mix:\s*([0-9.]+)%\s*;/g
  const result = {}
  let match

  while ((match = pattern.exec(stylesSource))) {
    result[toCamelCase(match[1])] = Number(match[2])
  }

  if (Object.keys(result).length === 0) {
    fail(`found no --theme-*-accent-mix declarations in ${STYLES_PATH}`)
  }

  return result
}

function main() {
  const presetsSource = readFileSync(PRESETS_PATH, 'utf8')
  const stylesSource = readFileSync(STYLES_PATH, 'utf8')

  const colors = {}
  for (const name of PRESET_NAMES) {
    colors[name] = parsePreset(presetsSource, name)
  }

  const tokens = {
    colors,
    radiusScalar: parseRadiusScalar(stylesSource),
    accentMixes: parseAccentMixes(stylesSource),
    font: FONT_TOKENS
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')

  console.log(`export-design-tokens: wrote ${OUTPUT_PATH}`)
  console.log(`  presets: ${PRESET_NAMES.join(', ')}`)
  console.log(`  radiusScalar: ${tokens.radiusScalar}`)
  console.log(`  accentMixes: ${Object.keys(tokens.accentMixes).length} keys`)
}

main()
