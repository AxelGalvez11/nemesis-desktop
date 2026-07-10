import { useEffect } from 'react';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
import { openBrowserRail } from '@/store/browser-rail';
import { $messages } from '@/store/session';
// "Watch the agent work": when the current assistant turn starts using its
// browser tools, pop the live browser mirror open in the right rail — once per
// message, so a student who closes it mid-turn isn't fought over the pane.
// Also warms the app-managed browser at startup so the agent's configured
// cdp_url (config.yaml browser.cdp_url) always has something to attach to.
const BROWSER_TOOL_MARKER = /"browser_[a-z_]+"/;
export function useAgentBrowserWatcher() {
    useEffect(() => {
        if (!NEMESIS_STUDENT_BUILD) {
            return;
        }
        void window.hermesDesktop?.schoolBrowser?.ensure().catch(() => undefined);
        let lastOpenedFor = '';
        return $messages.subscribe(messages => {
            const last = messages[messages.length - 1];
            if (!last) {
                return;
            }
            const key = last.id ?? `#${messages.length}`;
            if (key === lastOpenedFor) {
                return;
            }
            let raw = '';
            try {
                // Tool calls ride inside the assistant message payload; a stringify
                // scan is shape-agnostic (same trick as the Sources rail).
                raw = JSON.stringify(last).slice(0, 200_000);
            }
            catch {
                return;
            }
            if (BROWSER_TOOL_MARKER.test(raw)) {
                lastOpenedFor = key;
                openBrowserRail();
            }
        });
    }, []);
}
