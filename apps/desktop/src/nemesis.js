// Nemesis student-build switches. ONE flag gates every "student cut" (hidden pages,
// trimmed settings, hidden coding surfaces) so the whole trim is greppable and can later
// be driven per-account from the backend (`/api/config` ui.student_mode — Layer C in
// docs/design/nemesis-product-reskin-plan-2026-07.md). Flip to false → stock Hermes UI.
export const NEMESIS_STUDENT_BUILD = true;
/** Sidebar pages hidden for students (machinery stays alive underneath). */
// 2026-07-14: 'today' joined — owner call: the dashboard reads as noise until the
// semester graph earns a quieter version; students boot straight into chat instead.
export const STUDENT_HIDDEN_NAV = new Set(['today', 'skills', 'messaging', 'artifacts']);
/** ⌘K palette entries hidden for students. */
export const STUDENT_HIDDEN_PALETTE = new Set(['nav-terminal', 'nav-skills', 'nav-messaging']);
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
/** Composer "/" popover entries hidden for students — git words (branch), checkpoint/
 *  context/dev-ops jargon. The commands still execute if typed (same philosophy as the
 *  palette: hidden, not disabled); this only keeps the suggestion list in plain English. */
export const STUDENT_HIDDEN_SLASH = new Set([
    '/agents',
    '/branch',
    '/browser',
    '/compress',
    '/debug',
    '/rollback',
    '/save',
    '/tools',
    '/yolo'
]);
/** ⌘K palette entries hidden for students, beyond STUDENT_HIDDEN_PALETTE — the whole
 *  command-center / gateway / dev-nav surface plus the granular technical lists
 *  (capability tabs, per-field settings search, MCP servers). Matched by id prefix
 *  OR exact id. */
export const STUDENT_HIDDEN_PALETTE_PREFIXES = [
    'cc-',
    'nav-cron',
    'nav-profiles',
    'nav-agents',
    'nav-starmap',
    'cap-',
    'field-',
    'mcp-'
];
/** True when this palette item id should be hidden in the student build. */
export function studentHidesPaletteId(id) {
    if (!NEMESIS_STUDENT_BUILD || !id) {
        return false;
    }
    if (STUDENT_HIDDEN_PALETTE.has(id) || STUDENT_HIDDEN_PALETTE_PREFIXES.some(prefix => id.startsWith(prefix))) {
        return true;
    }
    // Settings entries mirror STUDENT_SETTINGS_KEEP: `set-config-chat` ↔ 'config:chat',
    // `set-about` ↔ 'about', `set-providers&pview=keys` ↔ 'providers'. Anything not in
    // the keep-set (Gateway, Providers, Keys, hidden config sections) stays out of ⌘K.
    if (id.startsWith('set-config-')) {
        return !STUDENT_SETTINGS_KEEP.has(`config:${id.slice('set-config-'.length)}`);
    }
    if (id.startsWith('set-')) {
        return !STUDENT_SETTINGS_KEEP.has(id.slice('set-'.length).split('&')[0]);
    }
    return false;
}
/** Keyboard shortcuts disabled for students — every default-bound (or rebindable)
 *  chord that opens a hidden or developer surface: command center (⌘.), the terminal
 *  family (Ctrl+`…), the git review pane (⌘G), worktrees (⌘⇧B), the raw model picker,
 *  silent profile switching (⌘1-9 with the profile rail hidden), and hidden pages.
 *  use-keybinds.ts skips registering these; the Shortcuts panel hides their rows. */
export const STUDENT_HIDDEN_KEYBINDS = new Set([
    'composer.modelPicker',
    'workspace.newWorktree',
    'nav.commandCenter',
    'nav.profiles',
    'nav.skills',
    'nav.messaging',
    'nav.artifacts',
    'nav.cron',
    'nav.agents',
    'view.toggleReview',
    'view.showFiles',
    'view.showTerminal',
    'view.newTerminal',
    'view.nextTerminal',
    'view.prevTerminal',
    'view.closeTerminal',
    'profile.default',
    'profile.next',
    'profile.prev',
    'profile.toggleAll',
    'profile.create'
]);
/** True when this keybind action is disabled in the student build. */
export function studentHidesKeybind(actionId) {
    if (!NEMESIS_STUDENT_BUILD || !actionId) {
        return false;
    }
    return STUDENT_HIDDEN_KEYBINDS.has(actionId) || actionId.startsWith('profile.switch.');
}
