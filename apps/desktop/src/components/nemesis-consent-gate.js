import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// One-time privacy + responsibility consent (student build). Shown after the first
// successful sign-in, before the app is usable. Plain-language and truthful: the
// on-screen copy describes partner categories; the named data-processor list lives in
// the linked Privacy Policy (the legally required disclosure surface). Copy-only edits
// must NOT bump CONSENT_VERSION — that re-gates every existing install; bump only when
// the actual data practices change. Acceptance is stored locally per consent version.
import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
import { $account } from '@/nemesis-account';
import { setTelemetryEnabled, telemetryIdentify } from '@/nemesis-telemetry';
// 2026-07-14: bumped for a real data-practice change — anonymous usage stats +
// crash reports (PostHog) were added, disclosed below with a default-on checkbox.
const CONSENT_VERSION = '2026-07-14';
const CONSENT_STORAGE_KEY = 'nemesis.consent.accepted';
const PRIVACY_URL = 'https://app.enternemesis.com/legal/privacy';
function readAcceptedVersion() {
    try {
        return window.localStorage.getItem(CONSENT_STORAGE_KEY);
    }
    catch {
        return null;
    }
}
/** True once the student has accepted the CURRENT consent version (used by the
 *  app shell to decide whether telemetry may start on launch). */
export function hasAcceptedCurrentConsent() {
    return readAcceptedVersion() === CONSENT_VERSION;
}
export const NemesisConsentGate = () => {
    const account = useStore($account);
    const [acceptedVersion, setAcceptedVersion] = useState(() => readAcceptedVersion());
    const [shareStats, setShareStats] = useState(true);
    // Re-check on sign-in transitions so a fresh machine shows the gate exactly once.
    useEffect(() => {
        if (account.status === 'signed-in') {
            setAcceptedVersion(readAcceptedVersion());
        }
    }, [account.status]);
    if (!NEMESIS_STUDENT_BUILD || account.bypass || account.status !== 'signed-in') {
        return null;
    }
    if (acceptedVersion === CONSENT_VERSION) {
        return null;
    }
    const accept = () => {
        try {
            window.localStorage.setItem(CONSENT_STORAGE_KEY, CONSENT_VERSION);
        }
        catch {
            // localStorage unavailable: still let the user in for this session.
        }
        // Applies the checkbox: enabling also starts telemetry right away.
        setTelemetryEnabled(shareStats);
        if (shareStats && account.userId) {
            telemetryIdentify(account.userId);
        }
        setAcceptedVersion(CONSENT_VERSION);
    };
    return (_jsx("div", { className: "fixed inset-0 z-[1310] flex items-center justify-center overflow-y-auto bg-background/95 p-4 backdrop-blur-md", children: _jsxs("div", { className: "my-6 w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-lg", children: [_jsxs("div", { className: "flex flex-col items-center gap-3 text-center", children: [_jsx(BrandMark, { className: "size-12" }), _jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold tracking-tight", children: "Before Nemesis starts working" }), _jsx("p", { className: "pt-1 text-xs leading-relaxed text-muted-foreground", children: "One minute of honesty about what Nemesis reads, what stays on this Mac, and what leaves it." })] })] }), _jsxs("div", { className: "mt-5 flex flex-col gap-3 text-xs leading-relaxed", children: [_jsxs("div", { className: "rounded-lg border border-border bg-muted/30 px-3 py-2.5", children: [_jsx("div", { className: "text-sm font-medium", children: "Stays on this Mac" }), _jsx("p", { className: "pt-1 text-muted-foreground", children: "Your school-portal logins, lecture recordings, and library files live on this computer. Nemesis signs into your portals here, in a browser you can watch \u2014 your passwords are never sent to us." })] }), _jsxs("div", { className: "rounded-lg border border-border bg-muted/30 px-3 py-2.5", children: [_jsx("div", { className: "text-sm font-medium", children: "Leaves this Mac to do the work" }), _jsxs("p", { className: "pt-1 text-muted-foreground", children: ["To answer and research, the text of your requests and relevant excerpts are processed by our vetted service partners \u2014 for AI reasoning, web search and reading, and account management. The full, current list of partners always lives in the", ' ', _jsx("button", { className: "underline underline-offset-2 hover:text-foreground", onClick: () => void window.hermesDesktop?.openExternal?.(PRIVACY_URL), type: "button", children: "Privacy Policy" }), "."] })] }), _jsxs("div", { className: "rounded-lg border border-border bg-muted/30 px-3 py-2.5", children: [_jsx("div", { className: "text-sm font-medium", children: "Helping us fix bugs (your choice)" }), _jsx("p", { className: "pt-1 text-muted-foreground", children: "With the box below checked, Nemesis sends anonymous usage counts (which features get used) and crash reports \u2014 never your chats, notes, files, or recordings. Change your mind any time in Settings \u2192 Account & usage." }), _jsxs("label", { className: "mt-2 flex cursor-pointer items-start gap-2", children: [_jsx(Checkbox, { checked: shareStats, className: "mt-0.5", onCheckedChange: value => setShareStats(value === true) }), _jsx("span", { className: "text-muted-foreground", children: "Share anonymous usage stats & crash reports" })] })] }), _jsxs("div", { className: "rounded-lg border border-border bg-muted/30 px-3 py-2.5", children: [_jsx("div", { className: "text-sm font-medium", children: "You stay in charge" }), _jsx("p", { className: "pt-1 text-muted-foreground", children: "Nemesis reads your portals to organize your semester \u2014 it never submits work anywhere without you. You are responsible for how you use Nemesis in your courses; academic policies vary, so check your syllabus." })] })] }), _jsxs("div", { className: "mt-5 flex flex-col gap-2.5", children: [_jsx(Button, { onClick: accept, children: "I understand \u2014 start Nemesis" }), _jsx(Button, { onClick: () => void window.hermesDesktop?.openExternal?.(PRIVACY_URL), variant: "ghost", children: "Read the Privacy Policy" })] })] }) }));
};
