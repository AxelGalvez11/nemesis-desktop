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
    'config:appearance',
    'config:chat',
    'config:safety',
    'notifications',
    'sessions',
    'about'
]);
