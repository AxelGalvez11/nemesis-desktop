// Nemesis student-build switches. ONE flag gates every "student cut" (hidden pages,
// trimmed settings, hidden coding surfaces) so the whole trim is greppable and can later
// be driven per-account from the backend (`/api/config` ui.student_mode — Layer C in
// docs/design/nemesis-product-reskin-plan-2026-07.md). Flip to false → stock Hermes UI.
export const NEMESIS_STUDENT_BUILD = true;
/** Sidebar pages hidden for students (machinery stays alive underneath). */
export const STUDENT_HIDDEN_NAV = new Set(['skills', 'messaging']);
/** ⌘K palette entries hidden for students. */
export const STUDENT_HIDDEN_PALETTE = new Set(['nav-terminal', 'nav-skills', 'nav-messaging']);
/** Settings sections students see. Everything else (model/providers/keys/gateway/workspace/
 *  voice/memory/advanced) is provisioned by Nemesis — students pay, we run the model. */
export const STUDENT_SETTINGS_KEEP = new Set([
    'usage',
    'connections',
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
export const STUDENT_HIDDEN_PALETTE_PREFIXES = ['cc-', 'nav-cron', 'nav-profiles', 'nav-agents', 'nav-starmap'];
/** True when this palette item id should be hidden in the student build. */
export function studentHidesPaletteId(id) {
    if (!NEMESIS_STUDENT_BUILD || !id) {
        return false;
    }
    return STUDENT_HIDDEN_PALETTE.has(id) || STUDENT_HIDDEN_PALETTE_PREFIXES.some(prefix => id.startsWith(prefix));
}
