// Nemesis student-build switches. ONE flag gates every "student cut" (hidden pages,
// trimmed settings, hidden coding surfaces) so the whole trim is greppable and can later
// be driven per-account from the backend (`/api/config` ui.student_mode — Layer C in
// docs/design/nemesis-product-reskin-plan-2026-07.md). Flip to false → stock Hermes UI.
export const NEMESIS_STUDENT_BUILD = true;
/** Sidebar pages hidden for students (machinery stays alive underneath). */
// 2026-07-14: 'today' joined — owner call: the dashboard reads as noise until the
// semester graph earns a quieter version; students boot straight into chat instead.
// 2026-07-15: 'recorder' joined — hidden until the recording UI is refined (zoom
// layout + polish); the ASR engine and note pipeline stay intact underneath.
export const STUDENT_HIDDEN_NAV = new Set(['today', 'recorder', 'skills', 'messaging', 'artifacts']);
/** ⌘K palette entries hidden for students. */
export const STUDENT_HIDDEN_PALETTE = new Set(['nav-terminal', 'nav-skills', 'nav-messaging', 'nav-recorder']);
/** Settings sections students see. During the beta, students connect their own model
 *  provider, so model/provider controls stay visible and hosted-usage claims stay hidden. */
// 2026-07-13: 'providers' and 'config:model' removed — student plans include Nemesis
// intelligence via the metered proxy, so provider/key/model settings are not student-facing.
// 2026-07-14 (beta.5): 'usage' restored — students asked where to see their plan + weekly
// AI usage; the page now also carries account status (usage-settings.tsx).
// 2026-07-14: 'connections' hidden — the page confused testers; students now hand their
// school/webmail addresses to the agent in chat and it writes portals.json itself
// (school-portal skill). The page code stays for when a settings surface earns it back.
export const STUDENT_SETTINGS_KEEP = new Set([
    'usage',
    'keybinds',
    'config:appearance',
    'config:chat',
    'config:safety',
    'notifications',
    'sessions',
    'about'
]);
/** Status-bar items hidden for students — build/version hashes, gateway health, token/
 *  context meters, the YOLO toggle, command-center, agents, cron: infrastructure, not study. */
export const STUDENT_HIDDEN_STATUSBAR = new Set([
    'version-client',
    'version-backend',
    'gateway-health',
    'context-usage',
    'yolo',
    'command-center',
    'agents',
    'cron',
    'terminal'
]);
/** ⌘K palette entries hidden for students, beyond STUDENT_HIDDEN_PALETTE — the whole
 *  command-center / gateway / dev-nav surface. Matched by id prefix OR exact id. */
export const STUDENT_HIDDEN_PALETTE_PREFIXES = [
    'cc-',
    'nav-cron',
    'nav-profiles',
    'nav-agents',
    'nav-starmap'
];
/** True when this palette item id should be hidden in the student build. */
export function studentHidesPaletteId(id) {
    if (!NEMESIS_STUDENT_BUILD || !id) {
        return false;
    }
    return STUDENT_HIDDEN_PALETTE.has(id) || STUDENT_HIDDEN_PALETTE_PREFIXES.some(prefix => id.startsWith(prefix));
}
