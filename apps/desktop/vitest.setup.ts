// Shared setup for the renderer (jsdom) vitest suite.
//
// jsdom does not implement the CSS namespace, but timeline/cron components call
// CSS.escape() to build querySelector ids. Minimal escape that is adequate for
// test ids; real browsers use their native implementation.
type CssNamespace = { escape?: (value: string) => string }
const globalWithCss = globalThis as { CSS?: CssNamespace }
if (typeof globalWithCss.CSS === 'undefined') {
  globalWithCss.CSS = {}
}
if (typeof globalWithCss.CSS.escape !== 'function') {
  globalWithCss.CSS.escape = (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

export {}
