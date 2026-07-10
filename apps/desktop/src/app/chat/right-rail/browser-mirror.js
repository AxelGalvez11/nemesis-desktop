import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Live mirror of the app-managed agent browser, docked in the chat right rail.
// Frames arrive as CDP screencast JPEGs relayed by the main process; mouse and
// keyboard events on the mirror are forwarded back as trusted CDP input — so a
// student can watch the agent browse AND type (e.g. a Blackboard login) right
// here, into the same persistent browser profile the agent drives.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Codicon } from '@/components/ui/codicon';
import { cn } from '@/lib/utils';
const TAB_POLL_MS = 3000;
// DOM key → CDP dispatchKeyEvent payload for the non-printable keys a login
// form needs. Printable characters ride Input.insertText instead (reliable).
const SPECIAL_KEYS = {
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    ArrowLeft: { code: 'ArrowLeft', vk: 37 },
    ArrowRight: { code: 'ArrowRight', vk: 39 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
    Backspace: { code: 'Backspace', vk: 8 },
    Delete: { code: 'Delete', vk: 46 },
    End: { code: 'End', vk: 35 },
    Enter: { code: 'Enter', text: '\r', vk: 13 },
    Escape: { code: 'Escape', vk: 27 },
    Home: { code: 'Home', vk: 36 },
    PageDown: { code: 'PageDown', vk: 34 },
    PageUp: { code: 'PageUp', vk: 33 },
    Tab: { code: 'Tab', text: '\t', vk: 9 }
};
function modifiersFor(event) {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}
function mouseButtonFor(button) {
    return button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
}
function api() {
    return window.hermesDesktop?.schoolBrowser;
}
export function BrowserMirror() {
    const [status, setStatus] = useState('connecting');
    const [tabs, setTabs] = useState([]);
    const [activeId, setActiveId] = useState('');
    const [url, setUrl] = useState('');
    const [urlDraft, setUrlDraft] = useState(null);
    const imgRef = useRef(null);
    const overlayRef = useRef(null);
    // Page CSS size of the last frame — the input coordinate space.
    const frameSizeRef = useRef({ height: 0, width: 0 });
    const activeIdRef = useRef('');
    activeIdRef.current = activeId;
    const exec = useCallback((payload) => {
        void api()
            ?.exec(payload)
            .catch(() => undefined);
    }, []);
    const attach = useCallback(async (targetId) => {
        setActiveId(targetId);
        if (imgRef.current) {
            imgRef.current.removeAttribute('src');
        }
        const ok = await api()?.attach(targetId);
        setStatus(ok ? 'live' : 'offline');
    }, []);
    const refreshTabs = useCallback(async () => {
        const result = await api()?.list();
        if (!result?.running) {
            setStatus('offline');
            setTabs([]);
            return [];
        }
        setTabs(result.tabs);
        return result.tabs;
    }, []);
    const startBrowser = useCallback(async () => {
        setStatus('connecting');
        const ensured = await api()?.ensure();
        if (!ensured?.ok) {
            setStatus('offline');
            return;
        }
        const found = await refreshTabs();
        if (found[0]) {
            await attach(found[0].id);
            setUrl(found[0].url);
        }
    }, [attach, refreshTabs]);
    // Boot: ensure the browser, list its tabs, mirror the first one. Poll the tab
    // strip; frames + URL changes stream in via the IPC subscriptions.
    useEffect(() => {
        let stopped = false;
        void (async () => {
            if (stopped) {
                return;
            }
            await startBrowser();
        })();
        const timer = window.setInterval(() => {
            void refreshTabs().then(found => {
                if (found.length > 0 && !found.some(tab => tab.id === activeIdRef.current)) {
                    void attach(found[0].id);
                    setUrl(found[0].url);
                }
            });
        }, TAB_POLL_MS);
        const offFrame = api()?.onFrame(frame => {
            if (frame.targetId !== activeIdRef.current || !imgRef.current) {
                return;
            }
            frameSizeRef.current = { height: frame.metadata.deviceHeight, width: frame.metadata.deviceWidth };
            imgRef.current.src = `data:image/jpeg;base64,${frame.data}`;
            setStatus('live');
        });
        const offEvent = api()?.onEvent(event => {
            if (event.targetId !== activeIdRef.current) {
                return;
            }
            if (event.type === 'url-changed' && event.url) {
                setUrl(event.url);
            }
            if (event.type === 'detached') {
                setStatus('offline');
            }
        });
        return () => {
            stopped = true;
            window.clearInterval(timer);
            offFrame?.();
            offEvent?.();
            void api()?.detach();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    /** Mirror-box pixel → page CSS pixel, honoring the object-contain letterbox. */
    const pageCoords = useCallback((clientX, clientY) => {
        const box = overlayRef.current?.getBoundingClientRect();
        const frame = frameSizeRef.current;
        if (!box || !frame.width || !frame.height) {
            return null;
        }
        const scale = Math.min(box.width / frame.width, box.height / frame.height);
        const drawnWidth = frame.width * scale;
        const drawnHeight = frame.height * scale;
        const offsetX = box.left + (box.width - drawnWidth) / 2;
        const offsetY = box.top + (box.height - drawnHeight) / 2;
        const x = (clientX - offsetX) / scale;
        const y = (clientY - offsetY) / scale;
        if (x < 0 || y < 0 || x > frame.width || y > frame.height) {
            return null;
        }
        return { x: Math.round(x), y: Math.round(y) };
    }, []);
    const sendMouse = useCallback((type, event, extra) => {
        const coords = pageCoords(event.clientX, event.clientY);
        if (!coords) {
            return;
        }
        exec({
            method: 'Input.dispatchMouseEvent',
            params: {
                button: mouseButtonFor('button' in event ? event.button : 0),
                clickCount: 'detail' in event ? Math.max(1, Math.min(3, event.detail)) : 1,
                modifiers: modifiersFor(event),
                type,
                x: coords.x,
                y: coords.y,
                ...extra
            }
        });
    }, [exec, pageCoords]);
    const lastMoveRef = useRef(0);
    const onKeyDown = useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        // Paste: read the app clipboard and inject as text.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
            void navigator.clipboard
                .readText()
                .then(text => text && exec({ method: 'Input.insertText', params: { text } }))
                .catch(() => undefined);
            return;
        }
        const special = SPECIAL_KEYS[event.key];
        if (special) {
            const base = {
                code: special.code,
                key: event.key,
                modifiers: modifiersFor(event),
                nativeVirtualKeyCode: special.vk,
                windowsVirtualKeyCode: special.vk
            };
            exec({ method: 'Input.dispatchKeyEvent', params: { ...base, ...(special.text ? { text: special.text } : {}), type: 'keyDown' } });
            exec({ method: 'Input.dispatchKeyEvent', params: { ...base, type: 'keyUp' } });
            return;
        }
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
            exec({ method: 'Input.insertText', params: { text: event.key } });
        }
    }, [exec]);
    const navigate = useCallback((raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
            return;
        }
        const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
            ? trimmed
            : /\s/.test(trimmed) || !trimmed.includes('.')
                ? `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
                : `https://${trimmed}`;
        exec({ method: 'Page.navigate', params: { url: target } });
        setUrlDraft(null);
    }, [exec]);
    const newTab = useCallback(async () => {
        await api()?.exec({ kind: 'tab-new', url: 'about:blank' });
        const found = await refreshTabs();
        const created = found[found.length - 1];
        if (created) {
            await attach(created.id);
            setUrl(created.url);
            setUrlDraft('');
        }
    }, [attach, refreshTabs]);
    const closeTab = useCallback(async (targetId) => {
        await api()?.exec({ kind: 'tab-close', targetId });
        const found = await refreshTabs();
        if (targetId === activeIdRef.current && found[0]) {
            await attach(found[0].id);
            setUrl(found[0].url);
        }
    }, [attach, refreshTabs]);
    return (_jsxs("div", { className: "flex h-full min-h-0 w-full flex-col bg-(--ui-editor-surface-background)", children: [_jsxs("div", { className: "flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-(--ui-stroke-tertiary) px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", children: [tabs.map(tab => {
                        const active = tab.id === activeId;
                        return (_jsxs("div", { className: cn('group/btab flex h-5.5 min-w-0 max-w-40 shrink-0 items-center rounded-md pl-2 pr-1 text-[0.65rem]', active
                                ? 'bg-(--ui-bg-secondary) text-foreground'
                                : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'), children: [_jsx("button", { className: "min-w-0 truncate outline-none", onClick: () => {
                                        void attach(tab.id);
                                        setUrl(tab.url);
                                        setUrlDraft(null);
                                    }, title: tab.url, type: "button", children: tab.title || tab.url || 'New tab' }), _jsx("button", { "aria-label": "Close tab", className: "ml-1 grid size-4 shrink-0 place-items-center rounded-sm opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) group-hover/btab:opacity-100", onClick: () => void closeTab(tab.id), type: "button", children: _jsx(Codicon, { name: "close", size: "0.6rem" }) })] }, tab.id));
                    }), _jsx("button", { "aria-label": "New tab", className: "grid size-5.5 shrink-0 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground", onClick: () => void newTab(), type: "button", children: _jsx(Codicon, { name: "add", size: "0.7rem" }) })] }), _jsxs("div", { className: "flex h-8 shrink-0 items-center gap-1 border-b border-(--ui-stroke-tertiary) px-1.5", children: [_jsx("button", { "aria-label": "Back", className: "grid size-6 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground", onClick: () => exec({ direction: 'back', kind: 'history' }), type: "button", children: _jsx(Codicon, { name: "arrow-left", size: "0.8rem" }) }), _jsx("button", { "aria-label": "Forward", className: "grid size-6 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground", onClick: () => exec({ direction: 'forward', kind: 'history' }), type: "button", children: _jsx(Codicon, { name: "arrow-right", size: "0.8rem" }) }), _jsx("button", { "aria-label": "Reload", className: "grid size-6 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground", onClick: () => exec({ method: 'Page.reload', params: {} }), type: "button", children: _jsx(Codicon, { name: "refresh", size: "0.8rem" }) }), _jsx("input", { className: "h-6 min-w-0 flex-1 rounded-md border border-(--ui-stroke-quaternary) bg-(--ui-bg-secondary) px-2 text-[0.7rem] text-foreground outline-none placeholder:text-(--ui-text-quaternary) focus:border-(--ui-stroke-secondary)", onBlur: () => setUrlDraft(null), onChange: event => setUrlDraft(event.target.value), onFocus: event => event.target.select(), onKeyDown: event => {
                            if (event.key === 'Enter') {
                                navigate(event.currentTarget.value);
                                event.currentTarget.blur();
                            }
                        }, placeholder: "Type a URL and press Enter", spellCheck: false, value: urlDraft ?? url })] }), _jsx("div", { className: "relative min-h-0 flex-1 bg-black/90", children: status === 'offline' ? (_jsxs("div", { className: "flex h-full flex-col items-center justify-center gap-3 px-6 text-center", children: [_jsx(Codicon, { className: "text-(--ui-text-quaternary)", name: "globe", size: "1.6rem" }), _jsx("div", { className: "text-[0.75rem] text-(--ui-text-tertiary)", children: "The agent\u2019s browser isn\u2019t running." }), _jsx("button", { className: "rounded-md bg-(--ui-bg-secondary) px-3 py-1.5 text-[0.72rem] font-medium text-foreground transition-colors hover:bg-(--chrome-action-hover)", onClick: () => void startBrowser(), type: "button", children: "Start browser" })] })) : (_jsxs(_Fragment, { children: [_jsx("img", { alt: "", className: "h-full w-full select-none object-contain", draggable: false, ref: imgRef }), _jsx("div", { className: "absolute inset-0 cursor-default outline-none", onKeyDown: onKeyDown, onMouseDown: event => {
                                event.preventDefault();
                                event.currentTarget.focus();
                                sendMouse('mousePressed', event, { buttons: 1 });
                            }, onMouseMove: event => {
                                const now = Date.now();
                                if (now - lastMoveRef.current < 33) {
                                    return;
                                }
                                lastMoveRef.current = now;
                                sendMouse('mouseMoved', event, { buttons: event.buttons });
                            }, onMouseUp: event => sendMouse('mouseReleased', event, { buttons: 0 }), onWheel: event => sendMouse('mouseWheel', event, { deltaX: event.deltaX, deltaY: event.deltaY }), ref: overlayRef, role: "application", tabIndex: 0 }), status === 'connecting' && (_jsx("div", { className: "pointer-events-none absolute inset-0 grid place-items-center text-[0.72rem] text-(--ui-text-tertiary)", children: "Connecting to the agent\u2019s browser\u2026" }))] })) })] }));
}
