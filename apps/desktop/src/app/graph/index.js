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
import { LIBRARY_ROUTE } from '../routes';
import { buildIndex, extractWikilinks, loadVault, saveNote } from '../library/vault';
const GRAPH_SETTINGS_KEY = 'nemesis.graph.settings.v1';
const DEFAULT_CONTROLS = { nodeSize: 4, repulsion: 40, rotate: true, spread: 34 };
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
    return (_jsxs("label", { className: "mb-2 block", children: [_jsxs("span", { className: "flex items-center justify-between text-xs text-muted-foreground", children: [label, _jsx("span", { className: "tabular-nums", children: value })] }), _jsx("input", { className: "w-full accent-(--theme-primary)", max: max, min: min, onChange: event => onChange(Number(event.target.value)), step: step, type: "range", value: value })] }));
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
    const controlsRef = useRef(controls);
    controlsRef.current = controls;
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
                const accent = getComputedStyle(document.documentElement).getPropertyValue('--theme-midground').trim() || '#b3382e';
                // A graph is a viz surface: keep it dark for node contrast even in light mode.
                const instance = new ForceGraph3D(host)
                    .backgroundColor('#0e0e0e')
                    .width(host.clientWidth || host.offsetWidth || 800)
                    .height(host.clientHeight || host.offsetHeight || 600)
                    .nodeLabel((node) => {
                    const graphNode = node;
                    return graphNode.ghost
                        ? `<div style="font: 12px sans-serif; color:#aaa">${graphNode.id} — click to create this note</div>`
                        : `<div style="font: 12px sans-serif; color:#eee">${graphNode.id}</div>`;
                })
                    .nodeRelSize(controlsRef.current.nodeSize)
                    .nodeColor((node) => {
                    const graphNode = node;
                    if (graphNode.ghost) {
                        return 'rgba(170,170,170,0.35)';
                    }
                    return graphNode.degree >= 2 ? accent : '#c8c8c8';
                })
                    .nodeVal((node) => 1 + node.degree)
                    .nodeOpacity(0.9)
                    .linkColor(() => '#4a4a4a')
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
                            : '' }), status === 'ready' && ghostCount > 0 && (_jsx("p", { className: "text-[11px] text-muted-foreground/70", children: "Dim nodes are [[links]] with no note yet \u2014 click one to create it." }))] }), status === 'ready' && (_jsxs("div", { className: "absolute right-6 top-5 z-10 flex flex-col items-end gap-2", children: [_jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { "aria-label": "Graph settings", onClick: () => setPanelOpen(value => !value), size: "sm", variant: panelOpen ? 'secondary' : 'outline', children: _jsx(IconAdjustmentsHorizontal, { size: 14 }) }), _jsx(Button, { onClick: () => navigate(`${LIBRARY_ROUTE}?create=note`), size: "sm", variant: "outline", children: "+ New note" })] }), panelOpen && (_jsxs("div", { className: "w-60 rounded-lg border border-border bg-card/95 p-3 backdrop-blur", children: [_jsx(ControlSlider, { label: "Node size", max: 10, min: 1, onChange: nodeSize => setControls(current => ({ ...current, nodeSize })), step: 0.5, value: controls.nodeSize }), _jsx(ControlSlider, { label: "Spread", max: 120, min: 10, onChange: spread => setControls(current => ({ ...current, spread })), step: 2, value: controls.spread }), _jsx(ControlSlider, { label: "Repulsion", max: 140, min: 0, onChange: repulsion => setControls(current => ({ ...current, repulsion })), step: 5, value: controls.repulsion }), _jsxs("label", { className: "mt-2 flex cursor-pointer items-center justify-between text-xs text-muted-foreground", children: ["Slow auto-rotate", _jsx("input", { checked: controls.rotate, className: "accent-(--theme-primary)", onChange: event => setControls(current => ({ ...current, rotate: event.target.checked })), type: "checkbox" })] }), _jsx("button", { className: "mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:underline", onClick: () => setControls(DEFAULT_CONTROLS), type: "button", children: "Reset to defaults" })] }))] })), status === 'error' && (_jsx(EmptyState, { className: "flex-1", description: "Could not read the Library vault.", title: "Graph unavailable" })), status === 'empty' && (_jsx(EmptyState, { className: "flex-1", description: "Write linked notes in the Library first.", title: "Nothing to map yet" })), _jsx("div", { className: status === 'ready' || status === 'loading' ? 'min-h-0 flex-1' : 'hidden', ref: hostRef })] }));
}
