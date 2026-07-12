// User-adjustable accent tint (student build). Nemesis ships ONE monochrome
// identity (the 'nemesis' skin — grayscale surfaces) and the ONLY thing a student
// changes is the accent color. Instead of a raw hex picker (which trivially produces
// invisible controls or neon garbage), the user picks a HUE — from a curated set or a
// constrained custom slider — and we synthesize a saturation/lightness-controlled
// accent that we then CONTRAST-CHECK against the actual surface so it always reads.
//
// This overrides ONLY the accent tokens on top of the base theme. Surfaces, text, and
// especially the semantic tokens (danger red = --dt-destructive, success green) are
// left untouched, so "error" never turns into "brand" no matter what hue is picked.
import { contrastRatio, ensureContrast, hslToHex, mix } from './color';
// Curated, brand-compatible accents. Crimson is the identity (id 'crimson' is a
// sentinel: it means "use the theme's own accent unchanged", so the default look is
// byte-identical to today). The rest span the wheel while staying away from the pure
// green that reads as "success". Danger red stays its own separate token regardless.
export const ACCENT_SWATCHES = [
    { hue: 353, id: 'crimson', label: 'Crimson' },
    { hue: 12, id: 'ember', label: 'Ember' },
    { hue: 32, id: 'amber', label: 'Amber' },
    { hue: 265, id: 'violet', label: 'Violet' },
    { hue: 224, id: 'indigo', label: 'Indigo' },
    { hue: 205, id: 'azure', label: 'Azure' },
    { hue: 180, id: 'teal', label: 'Teal' },
    { hue: 158, id: 'jade', label: 'Jade' },
    { hue: 320, id: 'magenta', label: 'Magenta' },
    { hue: 20, id: 'copper', label: 'Copper' }
];
export const DEFAULT_ACCENT_ID = 'crimson';
// The exact designed Nemesis neon-crimson. Crimson applies THIS verbatim (a
// designer-approved brand color) rather than an HSL re-computation, so the default
// accent is pixel-identical to the brand — while still being contrast-guarded so it
// stays legible even in light mode.
const BRAND_CRIMSON = '#ff2740';
const STORE_KEY = 'nemesis.accent.tint.v1';
export const ACCENT_CHANGED_EVENT = 'nemesis:accent-changed';
// Fixed saturation keeps every hue in the same vivid-but-not-neon family. Lightness
// is mode-specific: a light surface needs a darker accent to stay legible as text; a
// near-black surface needs a brighter one. These are STARTING points — the contrast
// guard below moves them further if a hue still can't meet WCAG on this surface.
const ACCENT_SAT = 0.82;
const ACCENT_LIGHT_L = 0.46;
// Dark-mode accents sit lighter so perceptually-dark hues (blue/indigo) clear contrast
// BOTH against the near-black surface (as text) AND for a light label on the fill —
// raising lightness helps both at once, where lowering it trades one for the other.
const ACCENT_DARK_L = 0.66;
// --theme-primary doubles as a text color (pills, links) AND a fill. Guard the text
// use: 4.5:1 is WCAG AA for normal text. ensureContrast preserves the hue and only
// pushes lightness toward the surface's opposite until it clears.
const MIN_TEXT_CONTRAST = 4.5;
/** Resolve a stored value ('crimson' | swatch id | 'custom:<hue>') to a selection. */
export function parseAccentSelection(raw) {
    if (!raw) {
        return { hue: ACCENT_SWATCHES[0].hue, id: DEFAULT_ACCENT_ID };
    }
    if (raw.startsWith('custom:')) {
        const hue = Number.parseInt(raw.slice(7), 10);
        return Number.isFinite(hue) ? { hue: ((hue % 360) + 360) % 360, id: null } : { hue: ACCENT_SWATCHES[0].hue, id: DEFAULT_ACCENT_ID };
    }
    const swatch = ACCENT_SWATCHES.find(entry => entry.id === raw);
    return swatch ? { hue: swatch.hue, id: swatch.id } : { hue: ACCENT_SWATCHES[0].hue, id: DEFAULT_ACCENT_ID };
}
export function loadAccentSelection() {
    try {
        return parseAccentSelection(window.localStorage.getItem(STORE_KEY));
    }
    catch {
        return { hue: ACCENT_SWATCHES[0].hue, id: DEFAULT_ACCENT_ID };
    }
}
export function saveAccentSwatch(id) {
    persist(id);
}
export function saveAccentCustomHue(hue) {
    persist(`custom:${((Math.round(hue) % 360) + 360) % 360}`);
}
function persist(value) {
    try {
        window.localStorage.setItem(STORE_KEY, value);
    }
    catch {
        // best-effort
    }
    reapplyToDocument();
    try {
        window.dispatchEvent(new Event(ACCENT_CHANGED_EVENT));
    }
    catch {
        // no window (SSR/tests)
    }
}
/** The CSS-var overrides for a selection on a given surface. Always deterministic:
 *  Crimson → the exact brand red; any other swatch/custom → its hue, synthesized with
 *  fixed saturation and mode-tuned lightness. The result is ALWAYS contrast-guarded
 *  against the surface, so no accent (curated or custom) can render unreadable. Pure. */
export function accentTokensFor(selection, background, isDark) {
    // Crimson uses the brand hex verbatim; everything else is HSL-synthesized.
    const base = selection.id === DEFAULT_ACCENT_ID
        ? BRAND_CRIMSON
        : hslToHex(selection.hue, ACCENT_SAT, isDark ? ACCENT_DARK_L : ACCENT_LIGHT_L);
    const accent = ensureContrast(base, background, MIN_TEXT_CONTRAST);
    // Label on a solid accent fill: pick the CONTRAST-optimal of black/white, not a
    // perceptual-luminance guess (readableOn's fixed threshold picks white for light-ish
    // accents like amber where black reads far better). Guarantees the best available.
    const onAccent = contrastRatio('#ffffff', accent) >= contrastRatio('#1a1a1a', accent) ? '#ffffff' : '#1a1a1a';
    return {
        '--dt-accent-foreground': accent,
        '--dt-composer-ring': accent,
        '--dt-midground-foreground': onAccent,
        '--dt-primary-foreground': onAccent,
        '--dt-ring': accent,
        '--theme-accent-soft': mix(background, accent, 0.1),
        '--theme-midground': accent,
        '--theme-primary': accent,
        '--theme-secondary': mix(background, accent, 0.07),
        '--theme-warm': accent
    };
}
/** Repaint the accent tokens over whatever the base theme just applied. Called at the
 *  end of applyTheme (every theme/mode change + boot paint) and on live picker changes. */
export function applyAccentTint(root, background, isDark) {
    const tokens = accentTokensFor(loadAccentSelection(), background, isDark);
    for (const [key, value] of Object.entries(tokens)) {
        root.style.setProperty(key, value);
    }
}
// Live re-tint without a full theme reapply: read the surface + mode the base theme
// already stamped on <html> and repaint the accent. Falls back silently if the DOM
// isn't ready (tests).
function reapplyToDocument() {
    if (typeof document === 'undefined') {
        return;
    }
    const root = document.documentElement;
    const isDark = root.dataset.hermesMode === 'dark' || root.classList.contains('dark');
    const background = getComputedStyle(root).getPropertyValue('--theme-background-seed').trim() || (isDark ? '#0e0e0e' : '#f8faff');
    applyAccentTint(root, background, isDark);
}
/** A vivid, mode-independent representative color for a picker swatch. Swatches are
 *  decorative fills (not text), so they show the hue's TRUE character at a consistent
 *  pleasant lightness — the applied accent then adapts + contrast-guards per mode. This
 *  is the standard color-picker convention (vivid chip, adaptive result) and keeps warm
 *  hues from rendering muddy-brown just because light mode would darken them as text. */
export function accentSwatchHex(hue) {
    return hslToHex(hue, 0.74, 0.52);
}
