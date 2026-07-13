import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useStore } from '@nanostores/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Codicon } from '@/components/ui/codicon';
import { Tip } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { triggerHaptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
import { $hapticsMuted, toggleHapticsMuted } from '@/store/haptics';
import { toggleKeybindPanel } from '@/store/keybinds';
import { $fileBrowserOpen, $panesFlipped, $sidebarOpen, PREVIEW_PANE_ID, toggleFileBrowserOpen, togglePanesFlipped, toggleSidebarOpen } from '@/store/layout';
import { $paneOpen, togglePane } from '@/store/panes';
import { appViewForPath, isOverlayView } from '../routes';
import { titlebarButtonClass } from './titlebar';
export function TitlebarControls({ leftTools = [], tools = [], onOpenSettings }) {
    const { t } = useI18n();
    const navigate = useNavigate();
    const location = useLocation();
    const hapticsMuted = useStore($hapticsMuted);
    const fileBrowserOpen = useStore($fileBrowserOpen);
    const sidebarOpen = useStore($sidebarOpen);
    const panesFlipped = useStore($panesFlipped);
    const previewPaneOpen = useStore($paneOpen(PREVIEW_PANE_ID));
    const currentView = appViewForPath(location.pathname);
    const showChatRailControls = !NEMESIS_STUDENT_BUILD || currentView === 'chat';
    const toggleHaptics = () => {
        if (!hapticsMuted) {
            triggerHaptic('tap');
        }
        toggleHapticsMuted();
        if (hapticsMuted) {
            window.requestAnimationFrame(() => triggerHaptic('success'));
        }
    };
    // Each titlebar button controls the pane physically on its side, so a flip
    // swaps which pane each one toggles. Default: sessions left, file browser
    // right. Flipped: file browser left, sessions right. Sidebar toggles never
    // carry an active highlight — they're plain show/hide affordances.
    // Student build: the right edge IS the single tabbed rail (Sources | Browser
    // | Preview) — there is no separate file-browser column to toggle.
    const fileBrowserEdge = NEMESIS_STUDENT_BUILD
        ? { open: previewPaneOpen, toggle: () => togglePane(PREVIEW_PANE_ID) }
        : { open: fileBrowserOpen, toggle: toggleFileBrowserOpen };
    const sessionsEdge = { open: sidebarOpen, toggle: toggleSidebarOpen };
    const leftEdge = NEMESIS_STUDENT_BUILD ? sessionsEdge : panesFlipped ? fileBrowserEdge : sessionsEdge;
    const rightEdge = NEMESIS_STUDENT_BUILD ? fileBrowserEdge : panesFlipped ? sessionsEdge : fileBrowserEdge;
    const leftToolbarTools = [
        {
            icon: _jsx(Codicon, { name: "layout-sidebar-left" }),
            id: 'sidebar',
            label: leftEdge.open ? t.titlebar.hideSidebar : t.titlebar.showSidebar,
            onSelect: () => {
                triggerHaptic('tap');
                leftEdge.toggle();
            }
        },
        {
            // Layout-flipping is a power-user affordance; students get a stable layout.
            hidden: NEMESIS_STUDENT_BUILD,
            icon: _jsx(Codicon, { name: "arrow-swap" }),
            id: 'flip-panes',
            label: t.titlebar.swapSidebarSides,
            onSelect: () => {
                triggerHaptic('tap');
                togglePanesFlipped();
            },
            title: t.titlebar.swapSidebarSidesTitle
        },
        ...leftTools
    ];
    const rightSidebarTool = {
        icon: _jsx(Codicon, { name: "layout-sidebar-right" }),
        id: 'right-sidebar',
        label: rightEdge.open ? t.titlebar.hideRightSidebar : t.titlebar.showRightSidebar,
        onSelect: () => {
            triggerHaptic('tap');
            rightEdge.toggle();
        }
    };
    // Static system tools — always pinned to the screen's right edge.
    const systemTools = [
        {
            active: hapticsMuted,
            hidden: NEMESIS_STUDENT_BUILD,
            icon: _jsx(Codicon, { name: hapticsMuted ? 'mute' : 'unmute' }),
            id: 'haptics',
            label: hapticsMuted ? t.titlebar.unmuteHaptics : t.titlebar.muteHaptics,
            onSelect: toggleHaptics
        },
        {
            hidden: NEMESIS_STUDENT_BUILD,
            icon: _jsx(Codicon, { name: "keyboard" }),
            id: 'keybinds',
            label: t.titlebar.openKeybinds,
            onSelect: () => {
                triggerHaptic('open');
                toggleKeybindPanel();
            }
        },
        {
            hidden: NEMESIS_STUDENT_BUILD,
            icon: _jsx(Codicon, { name: "settings-gear" }),
            id: 'settings',
            label: t.titlebar.openSettings,
            onSelect: () => {
                triggerHaptic('open');
                onOpenSettings();
            }
        }
    ];
    // While a full-screen overlay (settings, command center, …) is open it should
    // visually own the window. These control clusters are `fixed` at a higher
    // z-index than the overlay card, so they'd otherwise bleed over it — hide them
    // and let the overlay's own chrome (close button, drag region) take over.
    if (isOverlayView(currentView)) {
        return null;
    }
    const visibleSystemTools = systemTools.filter(tool => !tool.hidden);
    const settingsTool = visibleSystemTools.find(tool => tool.id === 'settings');
    const visibleSystemToolsBeforeSettings = visibleSystemTools.filter(tool => tool.id !== 'settings');
    const visiblePaneTools = showChatRailControls ? tools.filter(tool => !tool.hidden) : [];
    const showRightControls = visibleSystemTools.length > 0 || showChatRailControls;
    return (_jsxs(_Fragment, { children: [_jsx("div", { "aria-label": t.shell.windowControls, className: "fixed left-(--titlebar-controls-left) top-(--titlebar-controls-top) z-70 flex translate-y-0.5 flex-row items-center gap-x-1 pointer-events-auto select-none [-webkit-app-region:no-drag]", children: leftToolbarTools
                    .filter(tool => !tool.hidden)
                    .map(tool => (_jsx(TitlebarToolButton, { navigate: navigate, tool: tool }, tool.id))) }), visiblePaneTools.length > 0 && (_jsx("div", { "aria-label": t.shell.paneControls, className: "fixed top-[calc(var(--titlebar-controls-top)+var(--right-rail-top-inset,0px))] right-[calc(var(--titlebar-tools-right)+var(--shell-preview-toolbar-gap,0))] z-70 flex flex-row items-center gap-x-1 pointer-events-auto select-none [-webkit-app-region:no-drag]", children: visiblePaneTools.map(tool => (_jsx(TitlebarToolButton, { navigate: navigate, tool: tool }, tool.id))) })), showRightControls && (_jsxs("div", { "aria-label": t.shell.appControls, className: "fixed right-(--titlebar-tools-right) top-(--titlebar-controls-top) z-70 flex flex-row items-center justify-end gap-x-1 pointer-events-auto select-none [-webkit-app-region:no-drag]", children: [visibleSystemToolsBeforeSettings.map(tool => (_jsx(TitlebarToolButton, { navigate: navigate, tool: tool }, tool.id))), settingsTool && _jsx(TitlebarToolButton, { navigate: navigate, tool: settingsTool }), showChatRailControls && _jsx(TitlebarToolButton, { navigate: navigate, tool: rightSidebarTool })] }))] }));
}
function TitlebarToolButton({ navigate, tool }) {
    // Titlebar actions never show an active background — state reads from the
    // icon itself (e.g. the mute/unmute glyph). aria-pressed still carries it
    // for a11y.
    const className = cn(titlebarButtonClass, 'bg-transparent select-none', tool.className);
    if (tool.href) {
        return (_jsx(Tip, { label: tool.title ?? tool.label, children: _jsx(Button, { asChild: true, className: className, size: "icon-titlebar", variant: "ghost", children: _jsx("a", { "aria-label": tool.label, href: tool.href, onPointerDown: event => event.stopPropagation(), rel: "noreferrer", target: "_blank", children: tool.icon }) }) }));
    }
    return (_jsx(Tip, { label: tool.title ?? tool.label, children: _jsx(Button, { "aria-label": tool.label, "aria-pressed": tool.active ?? undefined, className: className, disabled: tool.disabled, onClick: () => {
                if (tool.to) {
                    navigate(tool.to);
                }
                tool.onSelect?.();
            }, onPointerDown: event => event.stopPropagation(), size: "icon-titlebar", type: "button", variant: "ghost", children: tool.icon }) }));
}
