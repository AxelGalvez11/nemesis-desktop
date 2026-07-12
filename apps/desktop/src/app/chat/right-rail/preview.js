import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useState } from 'react';
import { SourcesTab } from '@/app/right-sidebar/sources';
import { Button } from '@/components/ui/button';
import { Codicon } from '@/components/ui/codicon';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { translateNow, useI18n } from '@/i18n';
import { formatCombo } from '@/lib/keybinds/combo';
import { cn } from '@/lib/utils';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
import { $browserRailOpen } from '@/store/browser-rail';
import { $panesFlipped, $rightRailActiveTabId, RIGHT_RAIL_BROWSER_TAB_ID, RIGHT_RAIL_PREVIEW_TAB_ID, RIGHT_RAIL_SOURCES_TAB_ID, selectRightRailTab } from '@/store/layout';
import { $filePreviewTabs, $previewReloadRequest, $previewTarget, closeOtherRightRailTabs, closeRightRail, closeRightRailTab, closeRightRailTabsToRight } from '@/store/preview';
import { $dirtyPreviewUrls } from '@/store/preview-edit';
import { SchoolBrowserPanel } from './native-browser-panel';
import { PreviewPane } from './preview-pane';
// Synthetic targets for the non-PreviewPane tabs (browser mirror + pinned
// sources) — they only feed the tab strip (label/tooltip/dirty-lookup).
const BROWSER_TAB_TARGET = {
    kind: 'url',
    label: 'Browser',
    source: 'agent-browser',
    url: 'about:agent-browser'
};
const SOURCES_TAB_TARGET = {
    kind: 'url',
    label: 'Sources',
    source: 'sources',
    url: 'about:sources'
};
export const PREVIEW_RAIL_MIN_WIDTH = '18rem';
export const PREVIEW_RAIL_MAX_WIDTH = '38rem';
const INTRINSIC = `clamp(${PREVIEW_RAIL_MIN_WIDTH}, 36vw, 32rem)`;
const IS_MACOS = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
// Track for <Pane id="preview">. Folds the intrinsic clamp with a min-floor
// against --chat-min-width so the chat surface never gets squeezed below it.
// Subtracts the project browser width so preview yields rather than crushing
// the chat when both right-side panes are open.
export const PREVIEW_RAIL_PANE_WIDTH = `min(${INTRINSIC}, max(0rem, calc(100vw - var(--pane-chat-sidebar-width) - var(--pane-file-browser-width, 0rem) - var(--chat-min-width))))`;
function tabLabelFor(target) {
    const value = target.label || target.path || target.source || target.url;
    const tail = value.split(/[\\/]/).filter(Boolean).at(-1);
    return tail || value || translateNow('preview.tab');
}
export function ChatPreviewRail(props) {
    return NEMESIS_STUDENT_BUILD ? _jsx(StudentChatPreviewRail, { ...props }) : _jsx(DefaultChatPreviewRail, { ...props });
}
function StudentChatPreviewRail({ onRestartServer, setTitlebarToolGroup }) {
    const { t } = useI18n();
    const previewReloadRequest = useStore($previewReloadRequest);
    const activeTabId = useStore($rightRailActiveTabId);
    const panesFlipped = useStore($panesFlipped);
    const filePreviewTabs = useStore($filePreviewTabs);
    const previewTarget = useStore($previewTarget);
    const dirtyPreviewUrls = useStore($dirtyPreviewUrls);
    const browserRailOpen = useStore($browserRailOpen);
    const hasPreviewContent = Boolean(previewTarget || filePreviewTabs.length > 0);
    const segments = useMemo(() => [
        { id: RIGHT_RAIL_SOURCES_TAB_ID, label: 'Sources' },
        ...(browserRailOpen ? [{ id: RIGHT_RAIL_BROWSER_TAB_ID, label: 'Browser' }] : []),
        ...(hasPreviewContent ? [{ id: RIGHT_RAIL_PREVIEW_TAB_ID, label: 'Preview' }] : [])
    ], [browserRailOpen, hasPreviewContent]);
    const activeFileTab = activeTabId.startsWith('file:')
        ? filePreviewTabs.find(tab => tab.id === activeTabId)
        : undefined;
    const activeSegmentId = activeTabId === RIGHT_RAIL_BROWSER_TAB_ID && browserRailOpen
        ? RIGHT_RAIL_BROWSER_TAB_ID
        : (activeTabId === RIGHT_RAIL_PREVIEW_TAB_ID || activeFileTab) && hasPreviewContent
            ? RIGHT_RAIL_PREVIEW_TAB_ID
            : RIGHT_RAIL_SOURCES_TAB_ID;
    const activePreviewTarget = activeTabId === RIGHT_RAIL_PREVIEW_TAB_ID
        ? previewTarget
        : (activeFileTab?.target ?? previewTarget ?? filePreviewTabs[0]?.target ?? null);
    const previewTabs = useMemo(() => [
        ...(previewTarget
            ? [{ id: RIGHT_RAIL_PREVIEW_TAB_ID, label: t.preview.tab, target: previewTarget }]
            : []),
        ...filePreviewTabs.map(({ id, target }) => ({ id, label: tabLabelFor(target), target }))
    ], [filePreviewTabs, previewTarget, t.preview.tab]);
    useEffect(() => {
        const activeTabAvailable = activeTabId === RIGHT_RAIL_SOURCES_TAB_ID ||
            (activeTabId === RIGHT_RAIL_BROWSER_TAB_ID && browserRailOpen) ||
            (activeTabId === RIGHT_RAIL_PREVIEW_TAB_ID && Boolean(previewTarget)) ||
            Boolean(activeFileTab);
        if (!activeTabAvailable) {
            selectRightRailTab(RIGHT_RAIL_SOURCES_TAB_ID);
        }
    }, [activeFileTab, activeTabId, browserRailOpen, previewTarget]);
    const selectSegment = (id) => {
        if (id !== RIGHT_RAIL_PREVIEW_TAB_ID) {
            selectRightRailTab(id);
            return;
        }
        if (activeSegmentId === RIGHT_RAIL_PREVIEW_TAB_ID) {
            return;
        }
        selectRightRailTab(previewTarget ? RIGHT_RAIL_PREVIEW_TAB_ID : (filePreviewTabs[0]?.id ?? RIGHT_RAIL_SOURCES_TAB_ID));
    };
    const closeActiveView = () => {
        if (activeSegmentId === RIGHT_RAIL_SOURCES_TAB_ID) {
            closeRightRail();
            return;
        }
        if (activeSegmentId === RIGHT_RAIL_BROWSER_TAB_ID) {
            closeRightRailTab(RIGHT_RAIL_BROWSER_TAB_ID);
            return;
        }
        closeRightRailTab(activeFileTab?.id ?? RIGHT_RAIL_PREVIEW_TAB_ID);
    };
    const activeSegmentLabel = segments.find(segment => segment.id === activeSegmentId)?.label ?? 'Sources';
    // Fullscreen: the rail lifts out of its column and covers the whole window
    // (owner ask — reading a paper or steering the browser in a narrow strip is
    // cramped). Plain fixed positioning; the native browser view follows
    // automatically because its bounds track the placeholder's live rect.
    const [fullscreen, setFullscreen] = useState(false);
    useEffect(() => {
        if (!fullscreen) {
            return;
        }
        const onKey = (event) => {
            if (event.key === 'Escape') {
                setFullscreen(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [fullscreen]);
    return (_jsxs("aside", { className: cn('isolate flex min-w-0 flex-col overflow-hidden border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) text-(--ui-text-tertiary)', fullscreen
            ? 'fixed inset-0 z-40 border-none'
            : cn('relative h-full w-full', panesFlipped ? 'border-r' : 'border-l')), style: fullscreen ? undefined : { paddingTop: 'var(--right-rail-top-inset, 0px)' }, children: [_jsxs("div", { className: cn('relative z-10 flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) pr-3 [-webkit-app-region:no-drag]', fullscreen && IS_MACOS ? 'pl-[84px]' : 'pl-2'), "data-rail-chrome": "", children: [_jsx(SegmentedControl, { className: "min-w-0 max-w-full bg-(--ui-bg-tertiary) [&>button]:min-w-0 [&>button]:truncate [&>button]:transition-none [&>button]:active:scale-[0.98] [&>button]:motion-reduce:active:scale-100 [&>button[aria-pressed=true]]:bg-(--theme-primary)/15 [&>button[aria-pressed=true]]:text-(--theme-primary) [&>button[aria-pressed=true]]:shadow-none", onChange: selectSegment, options: segments, value: activeSegmentId }), _jsx(Tip, { label: fullscreen ? 'Exit full screen' : 'Full screen', children: _jsx(Button, { "aria-label": fullscreen ? 'Exit full screen' : 'Full screen', className: "ml-auto shrink-0 text-(--ui-text-tertiary) transition-colors duration-100 ease active:scale-[0.97] motion-reduce:active:scale-100", onClick: () => setFullscreen(current => !current), size: "icon-xs", type: "button", variant: "ghost", children: _jsx(Codicon, { name: fullscreen ? 'screen-normal' : 'screen-full', size: "0.75rem" }) }) }), _jsx(Tip, { label: activeSegmentId === RIGHT_RAIL_SOURCES_TAB_ID ? t.preview.closePane : t.preview.closeTab(activeSegmentLabel), children: _jsx(Button, { "aria-label": activeSegmentId === RIGHT_RAIL_SOURCES_TAB_ID
                                ? t.preview.closePane
                                : t.preview.closeTab(activeSegmentLabel), className: "shrink-0 text-(--ui-text-tertiary) transition-colors duration-100 ease active:scale-[0.97] motion-reduce:active:scale-100", onClick: () => {
                                setFullscreen(false);
                                closeActiveView();
                            }, size: "icon-xs", type: "button", variant: "ghost", children: _jsx(Codicon, { name: "close", size: "0.75rem" }) }) })] }), activeSegmentId === RIGHT_RAIL_PREVIEW_TAB_ID && filePreviewTabs.length > 0 && (_jsx("div", { className: "flex h-7 shrink-0 overflow-x-auto border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", role: "tablist", children: previewTabs.map(tab => {
                    const active = tab.id === activeTabId;
                    const dirty = Boolean(dirtyPreviewUrls[tab.target.url]);
                    return (_jsxs("div", { className: cn('group/file-tab relative flex h-full min-w-24 max-w-40 shrink-0 items-center border-r border-(--ui-stroke-quaternary) text-[0.65rem] font-medium [-webkit-app-region:no-drag]', active
                            ? 'bg-(--ui-editor-surface-background) text-foreground'
                            : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'), children: [active && (_jsx("span", { "aria-hidden": "true", className: "absolute inset-x-0 bottom-0 h-px bg-(--theme-primary)" })), _jsx(Tip, { label: tab.target.path || tab.target.url || tab.label, children: _jsx("button", { "aria-selected": active, className: "min-w-0 flex-1 truncate py-1 pl-2 pr-1 text-left outline-none active:scale-[0.98] motion-reduce:active:scale-100", onClick: () => selectRightRailTab(tab.id), role: "tab", type: "button", children: tab.label }) }), dirty && _jsx("span", { "aria-hidden": "true", className: "size-1.5 shrink-0 rounded-full bg-(--theme-primary)" }), _jsx("button", { "aria-label": t.preview.closeTab(tab.label), className: "mx-1 grid size-4 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) opacity-0 hover:bg-(--ui-control-hover-background) hover:text-foreground focus-visible:opacity-100 group-hover/file-tab:opacity-100 active:scale-[0.97] motion-reduce:active:scale-100", onClick: () => closeRightRailTab(tab.id), type: "button", children: _jsx(Codicon, { name: "close", size: "0.65rem" }) })] }, tab.id));
                }) })), _jsx("div", { className: "relative z-0 min-h-0 flex-1 overflow-hidden", children: activeSegmentId === RIGHT_RAIL_SOURCES_TAB_ID ? (_jsx("div", { className: "flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)", children: _jsx(SourcesTab, {}) })) : activeSegmentId === RIGHT_RAIL_BROWSER_TAB_ID ? (_jsx(SchoolBrowserPanel, {})) : activePreviewTarget ? (_jsx(PreviewPane, { embedded: true, onRestartServer: activeTabId === RIGHT_RAIL_PREVIEW_TAB_ID ? onRestartServer : undefined, reloadRequest: previewReloadRequest, setTitlebarToolGroup: setTitlebarToolGroup, target: activePreviewTarget })) : null })] }));
}
function DefaultChatPreviewRail({ onRestartServer, setTitlebarToolGroup }) {
    const { t } = useI18n();
    const previewReloadRequest = useStore($previewReloadRequest);
    const activeTabId = useStore($rightRailActiveTabId);
    const panesFlipped = useStore($panesFlipped);
    const filePreviewTabs = useStore($filePreviewTabs);
    const previewTarget = useStore($previewTarget);
    const dirtyPreviewUrls = useStore($dirtyPreviewUrls);
    const browserRailOpen = useStore($browserRailOpen);
    const tabs = useMemo(() => [
        // Student build: Sources is the rail's pinned home tab — the one right
        // panel replaces the old separate sources sidebar column.
        ...(NEMESIS_STUDENT_BUILD
            ? [{ id: RIGHT_RAIL_SOURCES_TAB_ID, label: 'Sources', target: SOURCES_TAB_TARGET }]
            : []),
        ...(browserRailOpen
            ? [{ id: RIGHT_RAIL_BROWSER_TAB_ID, label: 'Browser', target: BROWSER_TAB_TARGET }]
            : []),
        ...(previewTarget
            ? [{ id: RIGHT_RAIL_PREVIEW_TAB_ID, label: t.preview.tab, target: previewTarget }]
            : []),
        ...filePreviewTabs.map(({ id, target }) => ({ id, label: tabLabelFor(target), target }))
    ], [browserRailOpen, filePreviewTabs, previewTarget, t.preview.tab]);
    const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
    useEffect(() => {
        if (activeTab && activeTab.id !== activeTabId) {
            selectRightRailTab(activeTab.id);
        }
    }, [activeTab, activeTabId]);
    if (!activeTab) {
        return null;
    }
    const isPreview = activeTab.id === RIGHT_RAIL_PREVIEW_TAB_ID;
    return (_jsxs("aside", { className: cn('relative flex h-full w-full min-w-0 flex-col overflow-hidden border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) text-(--ui-text-tertiary)', panesFlipped ? 'border-r' : 'border-l'), 
        // Windows/WSLg paint Electron's Window Controls Overlay across our
        // titlebar band, so the editor-style tab strip (which normally sits IN that
        // band) would land under the fixed titlebar tools. --right-rail-top-inset
        // (set by AppShell only when the overlay is present) drops the rail one
        // titlebar-height so it opens below the band. 0px elsewhere → unchanged.
        style: { paddingTop: 'var(--right-rail-top-inset, 0px)' }, children: [_jsxs("div", { className: "group/rail-tabs flex h-(--titlebar-height) shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)", children: [_jsx("div", { className: "flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", role: "tablist", children: tabs.map((tab, index) => {
                            const active = tab.id === activeTab.id;
                            const pinned = tab.id === RIGHT_RAIL_SOURCES_TAB_ID;
                            const hasOthers = tabs.length > 1;
                            const hasTabsToRight = index < tabs.length - 1;
                            const dirty = Boolean(dirtyPreviewUrls[tab.target.url]);
                            return (_jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsxs("div", { className: cn('group/tab relative flex h-full min-w-0 max-w-48 shrink-0 items-center text-[0.6875rem] font-medium [-webkit-app-region:no-drag] last:border-r last:border-(--ui-stroke-quaternary)', active
                                                ? 'bg-(--ui-editor-surface-background) text-foreground [--tab-bg:var(--ui-editor-surface-background)]'
                                                : 'border-r border-(--ui-stroke-quaternary) text-(--ui-text-tertiary) [--tab-bg:var(--ui-sidebar-surface-background)] hover:bg-(--chrome-action-hover) hover:text-foreground'), 
                                            // Middle-click closes the tab, matching browser/IDE muscle
                                            // memory. `onMouseDown` swallows the middle-button press so
                                            // Chromium doesn't switch into autoscroll mode.
                                            onAuxClick: event => {
                                                if (event.button !== 1) {
                                                    return;
                                                }
                                                event.preventDefault();
                                                closeRightRailTab(tab.id);
                                            }, onMouseDown: event => {
                                                if (event.button === 1) {
                                                    event.preventDefault();
                                                }
                                            }, children: [active && (_jsx("span", { "aria-hidden": "true", className: "absolute inset-x-0 top-0 h-px bg-(--ui-stroke-primary)" })), _jsx(Tip, { label: tab.target.path || tab.target.url || tab.label, children: _jsx("button", { "aria-selected": active, className: "flex h-full min-w-0 max-w-full items-center overflow-hidden pl-3 pr-2 text-left outline-none", onClick: () => selectRightRailTab(tab.id), role: "tab", type: "button", children: _jsx("span", { className: "block min-w-0 truncate", children: tab.label }) }) }), _jsx("span", { "aria-hidden": "true", className: "pointer-events-none absolute inset-y-0 right-0 w-9 bg-[linear-gradient(to_right,transparent,var(--tab-bg)_55%)] opacity-0 transition-opacity group-hover/tab:opacity-100 group-focus-within/tab:opacity-100" }), dirty && (_jsx("span", { "aria-hidden": "true", className: "pointer-events-none absolute right-1.5 top-1/2 grid size-4 -translate-y-1/2 place-items-center opacity-100 transition-opacity group-hover/tab:opacity-0 group-focus-within/tab:opacity-0", children: _jsx("span", { className: "size-2 rounded-full bg-amber-500 shadow-[0_0_0_2px_var(--tab-bg),0_1px_2px_rgba(0,0,0,0.45)] dark:bg-amber-400" }) })), !pinned && (_jsx("button", { "aria-label": t.preview.closeTab(tab.label), className: "pointer-events-none absolute right-1.5 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-(--ui-text-tertiary) opacity-0 transition-[background-color,color,opacity] hover:bg-(--ui-bg-secondary) hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100", onClick: () => closeRightRailTab(tab.id), type: "button", children: _jsx(Codicon, { name: "close", size: "0.75rem" }) }))] }) }), _jsxs(ContextMenuContent, { children: [_jsxs(ContextMenuItem, { disabled: pinned, onSelect: () => closeRightRailTab(tab.id), children: [t.common.close, _jsx("span", { className: "ml-auto pl-4 text-(--ui-text-tertiary)", children: formatCombo('mod+w') })] }), _jsx(ContextMenuItem, { disabled: !hasOthers, onSelect: () => closeOtherRightRailTabs(tab.id), children: t.preview.closeOthers }), _jsx(ContextMenuItem, { disabled: !hasTabsToRight, onSelect: () => closeRightRailTabsToRight(tab.id), children: t.preview.closeToRight }), _jsx(ContextMenuSeparator, {}), _jsx(ContextMenuItem, { onSelect: closeRightRail, children: t.preview.closeAll })] })] }, tab.id));
                        }) }), _jsx("button", { "aria-label": t.preview.closePane, className: "mr-1.5 grid size-6 shrink-0 self-center place-items-center rounded-md text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-hover/rail-tabs:opacity-100 [-webkit-app-region:no-drag]", onClick: closeRightRail, type: "button", children: _jsx(Codicon, { name: "close", size: "0.75rem" }) })] }), _jsx("div", { className: "min-h-0 flex-1 overflow-hidden", children: activeTab.id === RIGHT_RAIL_SOURCES_TAB_ID ? (_jsx("div", { className: "flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)", children: _jsx(SourcesTab, {}) })) : activeTab.id === RIGHT_RAIL_BROWSER_TAB_ID ? (_jsx(SchoolBrowserPanel, {})) : (_jsx(PreviewPane, { embedded: true, onRestartServer: isPreview ? onRestartServer : undefined, reloadRequest: previewReloadRequest, setTitlebarToolGroup: setTitlebarToolGroup, target: activeTab.target })) })] }));
}
