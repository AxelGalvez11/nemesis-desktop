import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
// New-release notice for the student build. Students run signed DMGs (the git
// self-updater is disabled), so this floating card is what tells them a newer
// build exists. Detection only: the button opens the download page in their
// browser — nothing installs itself. Quiet by design: any network failure or
// rate limit simply means no banner this session.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchLatestReleaseTag, isNewerVersion, normalizeVersion, UPDATE_DISMISS_STORAGE_KEY, UPDATE_DOWNLOAD_URL } from '@/lib/nemesis-update-check';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
function readDismissedTag() {
    try {
        return window.localStorage.getItem(UPDATE_DISMISS_STORAGE_KEY);
    }
    catch {
        return null;
    }
}
export const NemesisUpdateBanner = () => {
    const [latestTag, setLatestTag] = useState(null);
    useEffect(() => {
        if (!NEMESIS_STUDENT_BUILD)
            return;
        // Dev servers report no packaged version and would spam the GitHub API on
        // every reload; opt in with the debug flag when testing the banner itself.
        if (import.meta.env.DEV && window.localStorage.getItem('nemesis.update.debug') !== '1')
            return;
        let cancelled = false;
        void (async () => {
            const info = await window.hermesDesktop?.getVersion?.().catch(() => null);
            const current = info?.appVersion;
            if (!current)
                return;
            const latest = await fetchLatestReleaseTag();
            if (cancelled || !latest)
                return;
            if (!isNewerVersion(latest, current))
                return;
            if (readDismissedTag() === latest)
                return;
            setLatestTag(latest);
        })();
        return () => {
            cancelled = true;
        };
    }, []);
    if (!latestTag)
        return null;
    const dismiss = () => {
        try {
            window.localStorage.setItem(UPDATE_DISMISS_STORAGE_KEY, latestTag);
        }
        catch {
            // Storage unavailable: the banner just reappears next launch.
        }
        setLatestTag(null);
    };
    const download = () => {
        if (window.hermesDesktop?.openExternal) {
            void window.hermesDesktop.openExternal(UPDATE_DOWNLOAD_URL);
        }
        else {
            window.open(UPDATE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
        }
    };
    return (_jsxs("div", { className: "fixed right-4 bottom-4 z-[80] w-80 rounded-xl border border-border bg-background p-4 shadow-lg", children: [_jsxs("p", { className: "text-sm font-semibold", children: ["Nemesis ", normalizeVersion(latestTag), " is available"] }), _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Download the new version and drag it into Applications. Your notes, decks, and settings stay put." }), _jsxs("div", { className: "mt-3 flex items-center gap-2", children: [_jsx(Button, { onClick: download, size: "sm", children: "Download update" }), _jsx(Button, { onClick: dismiss, size: "sm", variant: "ghost", children: "Later" })] })] }));
};
