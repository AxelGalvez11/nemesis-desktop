// Nemesis student-build switches. ONE flag gates every "student cut" (hidden pages,
// trimmed settings, hidden coding surfaces) so the whole trim is greppable and can later
// be driven per-account from the backend (`/api/config` ui.student_mode — Layer C in
// docs/design/nemesis-product-reskin-plan-2026-07.md). Flip to false → stock Hermes UI.
export const NEMESIS_STUDENT_BUILD = true

/** Sidebar pages hidden for students (machinery stays alive underneath). */
export const STUDENT_HIDDEN_NAV: ReadonlySet<string> = new Set(['skills', 'messaging', 'artifacts'])

/** ⌘K palette entries hidden for students. */
export const STUDENT_HIDDEN_PALETTE: ReadonlySet<string> = new Set(['nav-terminal', 'nav-skills', 'nav-messaging'])

/** Settings sections students see. During the beta, students connect their own model
 *  provider, so model/provider controls stay visible and hosted-usage claims stay hidden. */
// 2026-07-13: 'providers' and 'config:model' removed — student plans include Nemesis
// intelligence via the metered proxy, so provider/key/model settings are not student-facing.
// 2026-07-14 (beta.5): 'usage' restored — students asked where to see their plan + weekly
// AI usage; the page now also carries account status (usage-settings.tsx).
export const STUDENT_SETTINGS_KEEP: ReadonlySet<string> = new Set([
  'usage',
  'keybinds',
  'connections',
  'config:appearance',
  'config:chat',
  'config:safety',
  'notifications',
  'sessions',
  'about'
])

/** Status-bar items hidden for students — build/version hashes, gateway health, token/
 *  context meters, the YOLO toggle, command-center, agents, cron: infrastructure, not study. */
export const STUDENT_HIDDEN_STATUSBAR: ReadonlySet<string> = new Set([
  'version-client',
  'version-backend',
  'gateway-health',
  'context-usage',
  'yolo',
  'command-center',
  'agents',
  'cron',
  'terminal'
])

/** ⌘K palette entries hidden for students, beyond STUDENT_HIDDEN_PALETTE — the whole
 *  command-center / gateway / dev-nav surface. Matched by id prefix OR exact id. */
export const STUDENT_HIDDEN_PALETTE_PREFIXES: readonly string[] = [
  'cc-',
  'nav-cron',
  'nav-profiles',
  'nav-agents',
  'nav-starmap'
]

/** True when this palette item id should be hidden in the student build. */
export function studentHidesPaletteId(id: string | undefined): boolean {
  if (!NEMESIS_STUDENT_BUILD || !id) {
    return false
  }

  return STUDENT_HIDDEN_PALETTE.has(id) || STUDENT_HIDDEN_PALETTE_PREFIXES.some(prefix => id.startsWith(prefix))
}
