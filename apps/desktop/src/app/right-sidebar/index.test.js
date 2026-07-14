import { jsx as _jsx } from "react/jsx-runtime";
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $connection, setCurrentCwd } from '@/store/session';
import { resetProjectTreeState } from './files/use-project-tree';
import { RightSidebarPane } from './index';
const readDir = vi.fn();
function installBridge() {
    ;
    window.hermesDesktop = { readDir };
}
describe('RightSidebarPane', () => {
    beforeEach(() => {
        $connection.set(null);
        resetProjectTreeState();
        readDir.mockReset();
        readDir.mockResolvedValue({ entries: [{ isDirectory: false, name: 'README.md', path: '/repo/README.md' }] });
        installBridge();
    });
    afterEach(() => {
        cleanup();
        $connection.set(null);
        setCurrentCwd('');
        resetProjectTreeState();
        delete window.hermesDesktop;
    });
    it('shows the "Not available" placeholder in the student build, even with a working dir — the dev tree never mounts', async () => {
        // RightSidebarPane is the DEVELOPER workspace tree only (see index.tsx's
        // NEMESIS_STUDENT_BUILD branch / round-17 fc9d59f5a34 "ONE right panel
        // (Sources as pinned rail tab)"). The student build renders the terse
        // empty state here unconditionally; Sources owns the pinned rail tab
        // instead. This replaces the pre-round-17 "renders the tree" expectation.
        setCurrentCwd('/repo');
        render(_jsx(RightSidebarPane, { onActivateFile: vi.fn(), onActivateFolder: vi.fn() }));
        expect(await screen.findByText('Not available')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Refresh tree' })).toBeNull();
        // The freeform folder picker is retired.
        expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull();
    });
    it('shows no tree for a detached chat (no working dir)', async () => {
        setCurrentCwd('');
        render(_jsx(RightSidebarPane, { onActivateFile: vi.fn(), onActivateFolder: vi.fn() }));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Refresh tree' })).toBeNull());
        expect(readDir).not.toHaveBeenCalled();
    });
});
