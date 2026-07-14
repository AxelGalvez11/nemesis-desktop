import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// New-release notice for the student build. Since beta.6 the app updates ITSELF
// (electron-updater downloads in the background), so this card's job is to
// narrate that: "downloading…" → "Restart now". The manual download link only
// appears when the silent updater is unavailable or errored (beta.8 lesson: the
// old always-download button raced the background download and users installed
// by hand for nothing). Quiet by design: any network failure means no banner.
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
    const [updater, setUpdater] = useState('unavailable');
    // While the banner is visible, keep an eye on the silent updater so the card
    // flips from "downloading…" to "Restart now" the moment the download lands.
    useEffect(() => {
        if (!latestTag) {
            return;
        }
        let cancelled = false;
        const poll = async () => {
            const status = await window.hermesDesktop?.nemesisUpdaterStatus?.().catch(() => 'unavailable');
            if (!cancelled && status) {
                setUpdater(status);
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), 4000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [latestTag]);
    useEffect(() => {
        if (!NEMESIS_STUDENT_BUILD) {
            return;
        }
        // Dev servers report no packaged version and would spam the GitHub API on
        // every reload; opt in with the debug flag when testing the banner itself.
        if (import.meta.env.DEV && window.localStorage.getItem('nemesis.update.debug') !== '1') {
            return;
        }
        let cancelled = false;
        void (async () => {
            const info = await window.hermesDesktop?.getVersion?.().catch(() => null);
            const current = info?.appVersion;
            if (!current) {
                return;
            }
            const latest = await fetchLatestReleaseTag();
            if (cancelled || !latest) {
                return;
            }
            if (!isNewerVersion(latest, current)) {
                return;
            }
            if (readDismissedTag() === latest) {
                return;
            }
            setLatestTag(latest);
        })();
        return () => {
            cancelled = true;
        };
    }, []);
    if (!latestTag) {
        return null;
    }
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
    const restart = () => {
        void window.hermesDesktop?.nemesisUpdaterInstall?.().catch(() => { });
    };
    return (_jsxs("div", { className: "fixed right-4 bottom-4 z-[80] w-80 rounded-xl border border-border bg-background p-4 shadow-lg", children: [_jsx("p", { className: "text-sm font-semibold", children: updater === 'downloaded'
                    ? `Nemesis ${normalizeVersion(latestTag)} is ready`
                    : `Nemesis ${normalizeVersion(latestTag)} is available` }), _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: updater === 'downloaded'
                    ? 'The update is downloaded. Restart to use it now — or it installs itself when you quit.'
                    : updater === 'working'
                        ? 'Downloading in the background — you can keep working. Your notes, decks, and settings stay put.'
                        : 'Download the new version and drag it into Applications. Your notes, decks, and settings stay put.' }), _jsxs("div", { className: "mt-3 flex items-center gap-2", children: [updater === 'downloaded' ? (_jsx(Button, { onClick: restart, size: "sm", children: "Restart now" })) : updater === 'working' ? null : (_jsx(Button, { onClick: download, size: "sm", children: "Download update" })), _jsx(Button, { onClick: dismiss, size: "sm", variant: "ghost", children: "Later" })] })] }));
};
