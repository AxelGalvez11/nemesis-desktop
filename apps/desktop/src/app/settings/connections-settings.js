import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Connections (student build): let a student connect Nemesis to their school
// accounts WITHOUT ever touching an API key. "Connecting" is just signing in
// once in the app's own browser — the login cookie persists in the school
// session, and the agent reuses that same signed-in browser. Status is read
// from whether that session holds cookies for the portal (see school-view.ts).
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Codicon } from '@/components/ui/codicon';
import { Input } from '@/components/ui/input';
import { openBrowserRail } from '@/store/browser-rail';
// Curated first-run set. UTHSC is the owner's school; the rest are the common
// student accounts. "Custom" (below) covers any other portal by URL.
const PORTALS = [
    {
        hint: 'Courses, announcements, assignments',
        id: 'blackboard',
        name: 'Blackboard (UTHSC)',
        origin: 'https://blackboard.uthsc.edu',
        url: 'https://blackboard.uthsc.edu/'
    },
    {
        hint: 'School email',
        id: 'outlook',
        name: 'Outlook',
        origin: 'https://outlook.cloud.microsoft',
        url: 'https://outlook.cloud.microsoft/mail/'
    },
    {
        hint: 'Personal email',
        id: 'gmail',
        name: 'Gmail',
        origin: 'https://mail.google.com',
        url: 'https://mail.google.com/'
    },
    {
        hint: 'Some schools use Canvas instead of Blackboard',
        id: 'canvas',
        name: 'Canvas',
        origin: 'https://canvas.instructure.com',
        url: 'https://canvas.instructure.com/'
    },
    {
        hint: 'Flashcards and study sets',
        id: 'quizlet',
        name: 'Quizlet',
        origin: 'https://quizlet.com',
        url: 'https://quizlet.com/'
    },
    {
        hint: 'Notes, docs, and course workspaces',
        id: 'notion',
        name: 'Notion',
        origin: 'https://www.notion.so',
        url: 'https://www.notion.so/'
    },
    {
        hint: 'School files and shared folders',
        id: 'google-drive',
        name: 'Google Drive',
        origin: 'https://drive.google.com',
        url: 'https://drive.google.com/drive/my-drive'
    },
    {
        hint: 'Class notebooks and course notes',
        id: 'onenote',
        name: 'OneNote',
        origin: 'https://www.onenote.com',
        url: 'https://www.onenote.com/notebooks'
    },
    {
        hint: 'Classes, meetings, and assignments',
        id: 'teams',
        name: 'Microsoft Teams',
        origin: 'https://teams.microsoft.com',
        url: 'https://teams.microsoft.com/v2/'
    }
];
function originOf(url) {
    try {
        return new URL(url).origin;
    }
    catch {
        return url;
    }
}
export function ConnectionsSettings({ onClose }) {
    const [status, setStatus] = useState({});
    const [customUrl, setCustomUrl] = useState('');
    const api = window.hermesDesktop?.schoolView;
    const refresh = () => {
        if (!api?.connectionStatus) {
            return;
        }
        void api.connectionStatus(PORTALS.map(p => p.origin)).then(setStatus);
    };
    useEffect(() => {
        refresh();
        // Re-check when the window regains focus (the student just finished signing
        // in in the browser panel and came back to Settings).
        const onFocus = () => refresh();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Connect = open the account's login page in the app's browser panel and let
    // the student sign in once. Closing Settings surfaces the chat + its browser
    // rail where the page loads.
    const connect = (url) => {
        void api?.newTab?.(url);
        openBrowserRail();
        onClose?.();
    };
    const disconnect = (origin) => {
        void api?.disconnect?.(origin).then(refresh);
    };
    const connectCustom = () => {
        const url = customUrl.trim();
        if (!url) {
            return;
        }
        connect(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    };
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8", children: [_jsxs("div", { className: "flex flex-col gap-1", children: [_jsx("span", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70", children: "Connections" }), _jsx("h2", { className: "text-lg font-semibold text-foreground", children: "Connect your school accounts" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "No API keys, no setup codes. You just sign in once in Nemesis's own browser \u2014 then the agent works inside that signed-in session for you. Your passwords are never shown to or stored by the agent." })] }), _jsx("div", { className: "flex flex-col gap-2", children: PORTALS.map(portal => {
                    const connected = status[portal.origin];
                    return (_jsxs("div", { className: "flex items-center gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-3", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "truncate text-sm font-medium text-foreground", children: portal.name }), connected && (_jsxs("span", { className: "inline-flex shrink-0 items-center gap-1 rounded-full bg-(--theme-primary)/15 px-1.5 py-0.5 text-[0.6rem] font-semibold text-(--theme-primary)", children: [_jsx(Codicon, { name: "check", size: "0.6rem" }), "Connected"] }))] }), _jsx("div", { className: "truncate text-xs text-muted-foreground", children: portal.hint })] }), connected ? (_jsx(Button, { onClick: () => disconnect(portal.origin), size: "sm", variant: "ghost", children: "Sign out" })) : (_jsx(Button, { onClick: () => connect(portal.url), size: "sm", variant: "secondary", children: "Connect" }))] }, portal.id));
                }) }), _jsxs("div", { className: "flex flex-col gap-2 rounded-xl border border-dashed border-(--ui-stroke-tertiary) px-4 py-4", children: [_jsx("span", { className: "text-xs font-medium text-foreground", children: "Another site" }), _jsx("span", { className: "text-xs text-muted-foreground", children: "A different school portal, a library database, anything you log into on the web." }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Input, { className: "flex-1", onChange: event => setCustomUrl(event.target.value), onKeyDown: event => {
                                    if (event.key === 'Enter') {
                                        connectCustom();
                                    }
                                }, placeholder: "paste the site's address", value: customUrl }), _jsx(Button, { disabled: !customUrl.trim(), onClick: connectCustom, size: "sm", variant: "secondary", children: "Open & sign in" })] })] }), _jsx("p", { className: "text-xs leading-relaxed text-muted-foreground/70", children: "Once connected, ask Nemesis things like \u201Cwhat's due this week?\u201D or \u201Cpull my new lecture slides into the Library.\u201D It reads these accounts for you \u2014 it never sends email or submits anything without you saying so." })] }));
}
export { originOf as connectionOriginOf };
