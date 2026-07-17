import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// "Relaunch to update" card, pinned above the account row in the left sidebar
// (student build). Replaces the floating bottom-right update banner: the
// background download is now fully SILENT — no "downloading…" narration, no
// "Later"/dismiss (owner ask 2026-07-16, matching Claude Code's updater UX).
// The card appears only once there is something actionable:
//   - silent updater finished downloading → "Relaunch to update" (one click
//     installs; skipping it is harmless — the update also installs on the
//     next natural quit via autoInstallOnAppQuit)
//   - silent updater errored/unavailable AND GitHub confirms a newer release
//     → "Update available" (click opens the manual download)
import { useEffect, useState } from 'react';
import { Codicon } from '@/components/ui/codicon';
import { fetchLatestReleaseTag, isNewerVersion, normalizeVersion, UPDATE_DOWNLOAD_URL } from '@/lib/nemesis-update-check';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
/** What (if anything) the card should show. Pure so it's testable: the silent
 *  updater's word is authoritative; the GitHub tag is decorative for the
 *  relaunch case (version subtitle) and load-bearing only for the manual
 *  fallback, which must never nag unless a newer release provably exists. */
export function relaunchCardState(updater, latestTag, currentVersion) {
    if (updater === 'downloaded') {
        return { kind: 'relaunch', version: latestTag ? normalizeVersion(latestTag) : null };
    }
    // Downloading: stay silent. Narrating the background download was noise —
    // the user can't act on it, and the card appears the moment they can.
    if (updater === 'working') {
        return null;
    }
    if (latestTag && currentVersion && isNewerVersion(latestTag, currentVersion)) {
        return { kind: 'manual', version: normalizeVersion(latestTag) };
    }
    return null;
}
const STATUS_POLL_MS = 15_000;
const RELEASE_RECHECK_MS = 4 * 60 * 60 * 1000;
export const NemesisRelaunchCard = () => {
    const [updater, setUpdater] = useState('unavailable');
    const [latestTag, setLatestTag] = useState(null);
    const [currentVersion, setCurrentVersion] = useState(null);
    useEffect(() => {
        if (!NEMESIS_STUDENT_BUILD) {
            return;
        }
        // Dev servers report no packaged version and would spam the GitHub API on
        // every reload; opt in with the debug flag when testing the card itself.
        if (import.meta.env.DEV && window.localStorage.getItem('nemesis.update.debug') !== '1') {
            return;
        }
        let cancelled = false;
        const pollStatus = async () => {
            const status = await window.hermesDesktop?.nemesisUpdaterStatus?.().catch(() => 'unavailable');
            if (!cancelled && status) {
                setUpdater(status);
            }
        };
        const checkRelease = async () => {
            const info = await window.hermesDesktop?.getVersion?.().catch(() => null);
            if (cancelled || !info?.appVersion) {
                return;
            }
            setCurrentVersion(info.appVersion);
            const latest = await fetchLatestReleaseTag();
            if (!cancelled && latest) {
                setLatestTag(latest);
            }
        };
        void pollStatus();
        void checkRelease();
        const statusTimer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
        const releaseTimer = setInterval(() => void checkRelease(), RELEASE_RECHECK_MS);
        return () => {
            cancelled = true;
            clearInterval(statusTimer);
            clearInterval(releaseTimer);
        };
    }, []);
    const state = relaunchCardState(updater, latestTag, currentVersion);
    if (!state) {
        return null;
    }
    const activate = () => {
        if (state.kind === 'relaunch') {
            void window.hermesDesktop?.nemesisUpdaterInstall?.().catch(() => { });
        }
        else if (window.hermesDesktop?.openExternal) {
            void window.hermesDesktop.openExternal(UPDATE_DOWNLOAD_URL);
        }
        else {
            window.open(UPDATE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
        }
    };
    return (_jsxs("button", { "aria-label": state.kind === 'relaunch' ? 'Relaunch to update' : 'Update available', className: "group/update flex w-full items-center gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-2 py-1.5 text-left transition-colors duration-100 ease hover:border-(--theme-primary)/40 hover:bg-(--ui-control-hover-background) active:scale-[0.99] motion-reduce:active:scale-100", onClick: activate, type: "button", children: [_jsx("span", { className: "grid size-6 shrink-0 place-items-center rounded-md bg-(--theme-primary)/12 text-(--theme-primary)", children: _jsx(Codicon, { name: state.kind === 'relaunch' ? 'arrow-up' : 'cloud-download', size: "0.8rem" }) }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-xs font-medium text-foreground", children: state.kind === 'relaunch' ? 'Relaunch to update' : 'Update available' }), _jsx("span", { className: "block truncate text-[0.65rem] text-(--ui-text-tertiary)", children: state.version ? `v${state.version}` : 'A new version is ready' })] }), _jsx(Codicon, { className: "shrink-0 text-(--ui-text-tertiary) transition-transform duration-100 group-hover/update:translate-x-0.5 group-hover/update:text-foreground", name: "arrow-right", size: "0.8rem" })] }));
};
