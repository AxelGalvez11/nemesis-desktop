import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Graph — 3D map of the Library vault. Node = note, edge = [[wikilink]], hubs glow in the
// Nemesis crimson. Built on 3d-force-graph (MIT — the same library behind Obsidian's
// community 3D graph plugin). Clicking a node opens that note in the Library; wikilink
// targets that don't exist yet render as dim "ghost" nodes and a click CREATES the note
// (Obsidian's edit affordance), so the graph is a place to grow the vault, not just view it.
import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Switch } from '@/components/ui/switch';
import { useTheme } from '@/themes/context';
import { LIBRARY_ROUTE } from '../routes';
import { buildIndex, extractWikilinks, loadVault, saveNote } from '../library/vault';
const GRAPH_SETTINGS_KEY = 'nemesis.graph.settings.v1';
const DEFAULT_CONTROLS = { nodeSize: 4, repulsion: 40, rotate: true, spread: 34 };
// Chrome resolves CSS custom properties to the CSS Color-4 `color(srgb r g b / a)`
// syntax, which three.js (the 3d-force-graph renderer) CANNOT parse — it silently
// falls back to black, making nodes invisible on a dark background. Normalize every
// resolved value to an opaque `rgb(r, g, b)` string that three.js parses reliably.
function normalizeToRgb(computed) {
    if (!computed) {
        return null;
    }
    const rgb = computed.match(/rgba?\(([^)]+)\)/i);
    if (rgb) {
        const [r, g, b] = rgb[1].split(/[,/]/).map(part => Math.round(parseFloat(part.trim())));
        return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? `rgb(${r}, ${g}, ${b})` : null;
    }
    const srgb = computed.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
    if (srgb) {
        const [r, g, b] = [srgb[1], srgb[2], srgb[3]].map(part => Math.round(parseFloat(part) * 255));
        return `rgb(${r}, ${g}, ${b})`;
    }
    // Already a hex / named color three.js understands.
    return computed;
}
function resolveCssColor(value, fallback) {
    const probe = document.createElement('span');
    probe.style.color = value;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return normalizeToRgb(resolved) || fallback;
}
function readGraphPalette(mode) {
    const dark = mode === 'dark';
    return {
        accent: resolveCssColor('var(--theme-primary)', '#b3382e'),
        background: resolveCssColor('var(--ui-bg-editor)', dark ? '#0e0e0e' : '#fafafa'),
        ghost: resolveCssColor('color-mix(in srgb, var(--ui-text-primary) 38%, transparent)', dark ? 'rgba(232,232,232,0.38)' : 'rgba(28,28,30,0.38)'),
        label: resolveCssColor('var(--ui-text-primary)', dark ? '#eeeeee' : '#1c1c1e'),
        link: resolveCssColor('color-mix(in srgb, var(--ui-text-primary) 32%, transparent)', dark ? 'rgba(232,232,232,0.32)' : 'rgba(28,28,30,0.32)'),
        node: resolveCssColor('var(--ui-text-secondary)', dark ? '#c8c8c8' : '#3f3f43')
    };
}
function graphNodeColor(node, palette) {
    const graphNode = node;
    if (graphNode.ghost) {
        return palette.ghost;
    }
    return graphNode.degree >= 2 ? palette.accent : palette.node;
}
function loadControls() {
    try {
        const raw = window.localStorage.getItem(GRAPH_SETTINGS_KEY);
        if (raw) {
            return { ...DEFAULT_CONTROLS, ...JSON.parse(raw) };
        }
    }
    catch {
        // fall through to defaults
    }
    return DEFAULT_CONTROLS;
}
function ControlSlider({ label, max, min, onChange, step, value }) {
    return (_jsxs("label", { className: "block space-y-1.5", children: [_jsxs("span", { className: "flex items-center justify-between text-xs font-medium text-(--ui-text-primary)", children: [label, _jsx("span", { className: "rounded bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.6875rem] font-semibold tabular-nums text-(--ui-text-secondary)", children: value })] }), _jsx("input", { className: "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-(--ui-stroke-primary) accent-(--theme-primary) [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-(--theme-primary) [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-(--theme-primary)", max: max, min: min, onChange: event => onChange(Number(event.target.value)), step: step, type: "range", value: value })] }));
}
export function GraphView() {
    const hostRef = useRef(null);
    const graphRef = useRef(null);
    const navigate = useNavigate();
    const [status, setStatus] = useState('loading');
    const [noteCount, setNoteCount] = useState(0);
    const [ghostCount, setGhostCount] = useState(0);
    const [controls, setControls] = useState(() => loadControls());
    const [panelOpen, setPanelOpen] = useState(false);
    const { renderedMode, theme } = useTheme();
    const controlsRef = useRef(controls);
    const paletteRef = useRef(null);
    controlsRef.current = controls;
    useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
            const palette = readGraphPalette(renderedMode);
            paletteRef.current = palette;
            const graph = graphRef.current;
            if (!graph) {
                return;
            }
            graph.backgroundColor(palette.background);
            graph.nodeColor(node => graphNodeColor(node, palette));
            graph.linkColor(() => palette.link);
            graph.refresh?.();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [renderedMode, theme]);
    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return;
        }
        let disposed = false;
        let graph = null;
        let observer = null;
        void (async () => {
            try {
                const [{ default: ForceGraph3D }, notes] = await Promise.all([import('3d-force-graph'), loadVault()]);
                if (disposed) {
                    return;
                }
                if (!notes.length) {
                    setStatus('empty');
                    return;
                }
                const index = buildIndex(notes);
                const nodes = notes.map(note => ({
                    degree: (index.links.get(note.title)?.length ?? 0) + (index.backlinks.get(note.title)?.length ?? 0),
                    id: note.title
                }));
                const links = [...index.links.entries()].flatMap(([source, targets]) => targets.map(target => ({ source, target })));
                // Ghost nodes: wikilink targets with no note behind them yet. Dim, and a click
                // creates the note — the same "unresolved link" affordance Obsidian's graph has.
                const known = new Set(notes.map(note => note.title.toLowerCase()));
                const ghostByLower = new Map();
                for (const note of notes) {
                    for (const target of extractWikilinks(note.content)) {
                        if (!known.has(target.toLowerCase())) {
                            const display = ghostByLower.get(target.toLowerCase()) ?? target;
                            ghostByLower.set(target.toLowerCase(), display);
                            links.push({ source: note.title, target: display });
                        }
                    }
                }
                for (const display of ghostByLower.values()) {
                    nodes.push({ degree: 1, ghost: true, id: display });
                }
                const palette = paletteRef.current ?? readGraphPalette(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
                paletteRef.current = palette;
                const instance = new ForceGraph3D(host)
                    .backgroundColor(palette.background)
                    .width(host.clientWidth || host.offsetWidth || 800)
                    .height(host.clientHeight || host.offsetHeight || 600)
                    .nodeLabel((node) => {
                    const graphNode = node;
                    return graphNode.ghost
                        ? `<div style="font: 12px sans-serif; color:${paletteRef.current?.label ?? palette.label}">${graphNode.id} — click to create this note</div>`
                        : `<div style="font: 12px sans-serif; color:${paletteRef.current?.label ?? palette.label}">${graphNode.id}</div>`;
                })
                    .nodeRelSize(controlsRef.current.nodeSize)
                    .nodeColor((node) => graphNodeColor(node, paletteRef.current ?? palette))
                    .nodeVal((node) => 1 + node.degree)
                    .nodeOpacity(0.9)
                    .linkColor(() => paletteRef.current?.link ?? palette.link)
                    .linkWidth(0.5)
                    .linkOpacity(0.55)
                    .onNodeClick((node) => {
                    const graphNode = node;
                    void (async () => {
                        if (graphNode.ghost) {
                            // Materialize the note, then jump into it.
                            try {
                                await saveNote(graphNode.id, `# ${graphNode.id}\n\n`);
                            }
                            catch {
                                return;
                            }
                        }
                        navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(graphNode.id)}`);
                    })();
                })
                    .graphData({ links, nodes });
                // Frame the whole graph once the force sim settles (and again as a fallback —
                // the container can report 0px at construction inside the flex layout). Generous
                // padding keeps the nodes comfortably inside the viewport rather than filling it.
                instance.onEngineStop(() => instance.zoomToFit(500, 110));
                window.setTimeout(() => instance.zoomToFit(700, 110), 1500);
                const orbit = instance.controls();
                orbit.autoRotate = controlsRef.current.rotate;
                orbit.autoRotateSpeed = 0.5;
                observer = new ResizeObserver(() => {
                    instance.width(host.clientWidth || 800);
                    instance.height(host.clientHeight || 600);
                });
                observer.observe(host);
                graph = instance;
                graphRef.current = instance;
                setNoteCount(notes.length);
                setGhostCount(ghostByLower.size);
                setStatus('ready');
            }
            catch {
                if (!disposed) {
                    setStatus('error');
                }
            }
        })();
        return () => {
            disposed = true;
            observer?.disconnect();
            graphRef.current = null;
            graph?._destructor?.();
        };
    }, [navigate]);
    // Live-apply the tuning panel: size, spread (link distance), repulsion (charge),
    // rotation — then reheat so the layout actually re-settles.
    useEffect(() => {
        try {
            window.localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(controls));
        }
        catch {
            // persistence is best-effort
        }
        const graph = graphRef.current;
        if (!graph || status !== 'ready') {
            return;
        }
        graph.nodeRelSize(controls.nodeSize);
        graph.d3Force('link')?.distance?.(controls.spread);
        graph.d3Force('charge')?.strength?.(-controls.repulsion);
        graph.d3ReheatSimulation();
        graph.controls().autoRotate = controls.rotate;
    }, [controls, status]);
    return (_jsxs("div", { className: "relative flex h-full min-h-0 flex-col", children: [_jsxs("header", { className: "pointer-events-none absolute left-6 top-5 z-10", children: [_jsx("h1", { className: "text-lg font-semibold", children: "Graph" }), _jsx("p", { className: "text-xs text-muted-foreground", children: status === 'ready'
                            ? `${noteCount} notes${ghostCount > 0 ? ` · ${ghostCount} to create` : ''} — click any node`
                            : '' }), status === 'ready' && ghostCount > 0 && (_jsx("p", { className: "text-[11px] text-muted-foreground/70", children: "Dim nodes are [[links]] with no note yet \u2014 click one to create it." }))] }), status === 'ready' && (_jsxs("div", { className: "absolute right-6 top-5 z-10 flex flex-col items-end gap-2", children: [_jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { "aria-label": "Graph settings", className: "active:scale-[0.97] motion-reduce:transition-none", onClick: () => setPanelOpen(value => !value), size: "sm", variant: panelOpen ? 'secondary' : 'outline', children: _jsx(IconAdjustmentsHorizontal, { size: 14 }) }), _jsx(Button, { onClick: () => navigate(`${LIBRARY_ROUTE}?create=note`), size: "sm", variant: "outline", children: "+ New note" })] }), panelOpen && (_jsxs("div", { className: "w-64 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-4 text-(--ui-text-primary) shadow-lg", children: [_jsxs("div", { className: "mb-4", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: "Graph controls" }), _jsx("p", { className: "mt-1 text-xs text-(--ui-text-secondary)", children: "Tune the map without changing your notes." })] }), _jsxs("div", { className: "space-y-4", children: [_jsx(ControlSlider, { label: "Node size", max: 10, min: 1, onChange: nodeSize => setControls(current => ({ ...current, nodeSize })), step: 0.5, value: controls.nodeSize }), _jsx(ControlSlider, { label: "Spread", max: 120, min: 10, onChange: spread => setControls(current => ({ ...current, spread })), step: 2, value: controls.spread }), _jsx(ControlSlider, { label: "Repulsion", max: 140, min: 0, onChange: repulsion => setControls(current => ({ ...current, repulsion })), step: 5, value: controls.repulsion })] }), _jsxs("label", { className: "mt-4 flex cursor-pointer items-center justify-between border-t border-(--ui-stroke-tertiary) pt-3 text-xs font-medium text-(--ui-text-primary)", children: ["Slow auto-rotate", _jsx(Switch, { checked: controls.rotate, onCheckedChange: rotate => setControls(current => ({ ...current, rotate })), size: "xs" })] }), _jsx(Button, { className: "mt-3", onClick: () => setControls(DEFAULT_CONTROLS), size: "inline", variant: "text", children: "Reset to defaults" })] }))] })), status === 'error' && (_jsx(EmptyState, { className: "flex-1", description: "Could not read the Library vault.", title: "Graph unavailable" })), status === 'empty' && (_jsx(EmptyState, { className: "flex-1", description: "Write linked notes in the Library first.", title: "Nothing to map yet" })), _jsx("div", { className: status === 'ready' || status === 'loading' ? 'min-h-0 flex-1' : 'hidden', ref: hostRef })] }));
}
