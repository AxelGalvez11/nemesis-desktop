import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Graph — 3D map of the Library vault. Node = note, edge = [[wikilink]], hubs glow in the
// Nemesis crimson. Built on 3d-force-graph (MIT — the same library behind Obsidian's
// community 3D graph plugin). Clicking a node opens that note in the Library.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '@/components/ui/empty-state';
import { LIBRARY_ROUTE } from '../routes';
import { buildIndex, loadVault } from '../library/vault';
export function GraphView() {
    const hostRef = useRef(null);
    const navigate = useNavigate();
    const [status, setStatus] = useState('loading');
    const [noteCount, setNoteCount] = useState(0);
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
                const accent = getComputedStyle(document.documentElement).getPropertyValue('--theme-midground').trim() || '#b3382e';
                // A graph is a viz surface: keep it dark for node contrast even in light mode.
                const instance = new ForceGraph3D(host)
                    .backgroundColor('#0e0e0e')
                    .width(host.clientWidth || host.offsetWidth || 800)
                    .height(host.clientHeight || host.offsetHeight || 600)
                    .nodeLabel((node) => `<div style="font: 12px sans-serif; color:#eee">${node.id}</div>`)
                    .nodeRelSize(6)
                    .nodeColor((node) => (node.degree >= 2 ? accent : '#c8c8c8'))
                    .nodeVal((node) => 2 + node.degree * 2)
                    .nodeOpacity(0.95)
                    .linkColor(() => '#4a4a4a')
                    .linkWidth(0.5)
                    .linkOpacity(0.6)
                    .onNodeClick((node) => navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(node.id)}`))
                    .graphData({ links, nodes });
                // Frame the whole graph once the force sim settles (and again as a fallback —
                // the container can report 0px at construction inside the flex layout).
                instance.onEngineStop(() => instance.zoomToFit(400, 60));
                window.setTimeout(() => instance.zoomToFit(600, 60), 1400);
                const controls = instance.controls();
                controls.autoRotate = true;
                controls.autoRotateSpeed = 0.6;
                observer = new ResizeObserver(() => {
                    instance.width(host.clientWidth || 800);
                    instance.height(host.clientHeight || 600);
                });
                observer.observe(host);
                graph = instance;
                setNoteCount(notes.length);
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
            graph?._destructor?.();
        };
    }, [navigate]);
    return (_jsxs("div", { className: "relative flex h-full min-h-0 flex-col", children: [_jsxs("header", { className: "pointer-events-none absolute left-6 top-5 z-10", children: [_jsx("h1", { className: "text-lg font-semibold", children: "Graph" }), _jsx("p", { className: "text-xs text-muted-foreground", children: status === 'ready' ? `${noteCount} notes — click a node to open it` : '' })] }), status === 'error' && (_jsx(EmptyState, { className: "flex-1", description: "Could not read the Library vault.", title: "Graph unavailable" })), status === 'empty' && (_jsx(EmptyState, { className: "flex-1", description: "Write linked notes in the Library first.", title: "Nothing to map yet" })), _jsx("div", { className: status === 'ready' || status === 'loading' ? 'min-h-0 flex-1' : 'hidden', ref: hostRef })] }));
}
