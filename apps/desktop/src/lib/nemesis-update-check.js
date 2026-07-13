// Release update detection for the student build. The git self-updater is
// disabled for students (they run signed DMGs, not source checkouts), so new
// versions ship as GitHub Releases on the public nemesis-desktop repo. This
// module only DETECTS a newer release — installing stays a manual download
// the user chooses in their browser.
const RELEASES_LATEST_API = 'https://api.github.com/repos/AxelGalvez11/nemesis-desktop/releases/latest';
// Served by the account portal; 307-redirects to the latest DMG so old app
// builds keep working if release hosting ever moves.
export const UPDATE_DOWNLOAD_URL = 'https://app.enternemesis.com/api/download/mac';
export const UPDATE_DISMISS_STORAGE_KEY = 'nemesis.update.dismissed';
export function normalizeVersion(version) {
    return version.trim().replace(/^[vV]/, '');
}
function parseVersion(version) {
    const cleaned = normalizeVersion(version);
    const dashIndex = cleaned.indexOf('-');
    const mainRaw = dashIndex === -1 ? cleaned : cleaned.slice(0, dashIndex);
    const preRaw = dashIndex === -1 ? null : cleaned.slice(dashIndex + 1);
    const main = mainRaw.split('.').map((part) => Number(part));
    if (main.length === 0 || main.some((n) => !Number.isInteger(n) || n < 0))
        return null;
    if (preRaw === null)
        return { main, pre: null };
    if (preRaw === '')
        return null;
    const pre = preRaw.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
    return { main, pre };
}
// Semver ordering, simplified to what our tags use: numeric main parts, then
// release > prerelease, then prerelease identifiers compared per semver §11
// (numbers numerically, numbers before strings, prefix-equal shorter first).
function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb)
        return 0;
    const mainLength = Math.max(pa.main.length, pb.main.length);
    for (let i = 0; i < mainLength; i++) {
        const diff = (pa.main[i] ?? 0) - (pb.main[i] ?? 0);
        if (diff !== 0)
            return diff;
    }
    if (pa.pre === null && pb.pre === null)
        return 0;
    if (pa.pre === null)
        return 1;
    if (pb.pre === null)
        return -1;
    const preLength = Math.max(pa.pre.length, pb.pre.length);
    for (let i = 0; i < preLength; i++) {
        const va = pa.pre[i];
        const vb = pb.pre[i];
        if (va === undefined)
            return -1;
        if (vb === undefined)
            return 1;
        if (va === vb)
            continue;
        if (typeof va === 'number' && typeof vb === 'number')
            return va - vb;
        if (typeof va === 'number')
            return -1;
        if (typeof vb === 'number')
            return 1;
        return va < vb ? -1 : 1;
    }
    return 0;
}
// Fail-safe: unparsable versions are never "newer", so a malformed tag can
// only suppress the banner, not show a bogus one.
export function isNewerVersion(candidate, current) {
    if (!parseVersion(candidate) || !parseVersion(current))
        return false;
    return compareVersions(candidate, current) > 0;
}
export async function fetchLatestReleaseTag(fetchImpl = fetch) {
    try {
        const res = await fetchImpl(RELEASES_LATEST_API, {
            headers: { Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok)
            return null;
        const data = (await res.json());
        return typeof data.tag_name === 'string' && data.tag_name.trim() !== '' ? data.tag_name.trim() : null;
    }
    catch {
        return null;
    }
}
