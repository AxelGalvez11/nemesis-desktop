import { jsx as _jsx } from "react/jsx-runtime";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/nemesis-account', async () => {
    const actual = await vi.importActual('@/nemesis-account');
    return {
        ...actual,
        initAccount: vi.fn(async () => { }),
        refreshEntitlement: vi.fn(async () => { })
    };
});
import { $account, $accountDialogOpen } from '@/nemesis-account';
import { NemesisAccountGate } from './nemesis-account-gate';
const NOW = new Date('2026-07-12T18:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    $accountDialogOpen.set(false);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    $account.set({ plan: 'free', status: 'loading' });
    $accountDialogOpen.set(false);
});
describe('NemesisAccountGate trial UX', () => {
    it('shows one dismissible reminder during the final three days', () => {
        const trialEnd = new Date(NOW.getTime() + 2 * DAY_MS).toISOString();
        const trialAccount = {
            email: 'student@example.com',
            periodEnd: trialEnd,
            plan: 'plus',
            planStatus: 'trialing',
            status: 'signed-in',
            trialEnd
        };
        $account.set(trialAccount);
        render(_jsx(NemesisAccountGate, {}));
        expect(screen.getByRole('status').textContent).toContain('Trial ends in 2 days');
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByRole('status')).toBeNull();
        act(() => $account.set({ ...trialAccount }));
        expect(screen.queryByRole('status')).toBeNull();
    });
    it('uses a specific upgrade gate after the trial boundary', () => {
        const trialEnd = new Date(NOW.getTime() - DAY_MS).toISOString();
        $account.set({
            email: 'student@example.com',
            periodEnd: trialEnd,
            plan: 'free',
            planStatus: 'canceled',
            status: 'signed-in',
            trialEnd
        });
        render(_jsx(NemesisAccountGate, {}));
        expect(screen.getByRole('heading', { name: 'Your Nemesis trial has ended' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Upgrade Nemesis' })).toBeTruthy();
    });
});
